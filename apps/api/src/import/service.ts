import type { Repository } from "core/src/contracts";
import type { OnCaptured } from "../api/extension";
import { GmailError, type GmailClient } from "./gmail";
import { listCandidates, scanBatch, spotDocuments, type ScanCounts, type Spotted } from "./scan";
import type { ImportJob, ImportStore } from "./store";
import type { TokenBox } from "./tokenBox";

// One mailbox import, driven by the browser in small steps so no request runs long. The rules this file keeps:
//  - The access token exists only sealed (tokenBox.ts), only for the job, and every way a job can end goes through `end`,
//    which asks Google to revoke it and deletes the sealed copy. There is no path that finishes a job without that.
//  - A job is read and changed only by the household it belongs to, and the household comes from the session, never from
//    the request.
//  - Nothing here logs an address, a subject, a message id or a token: counts and error names only.

export const STEP_SIZE = 25;
export const LOCK_MS = 60_000;
/** One finished scan a day: a person who scanned today is told to come back tomorrow. */
export const MIN_GAP_MS = 24 * 3600_000;
const MAX_TOKEN_MS = 3600_000;

export interface ImportView {
  id: string;
  status: ImportJob["status"];
  finished: boolean;
  counts: ImportJob["counts"];
  /** `auth_ended`, `expired`, `cap`, `failed`, or null. */
  error: string | null;
  /** Whether Google confirmed that access was ended (only once finished). */
  revoked: boolean;
  /** The lease, warranty, manual and policy mail spotted, only once finished. */
  spotted: Spotted[];
}

export interface ImportService {
  start(who: {
    householdId: string;
    accessToken: string;
    expiresInSec: number;
  }): Promise<{ id: string } | { refused: "too_soon" }>;
  view(householdId: string, id: string): Promise<ImportView | null>;
  step(householdId: string, id: string): Promise<ImportView | null>;
  cancel(householdId: string, id: string): Promise<ImportView | null>;
  decline(householdId: string): Promise<void>;
  /** The newest job of a household, for the page that resumes after a reload. */
  latest(householdId: string): Promise<ImportView | null>;
}

export interface ImportServiceDeps {
  store: ImportStore;
  box: TokenBox;
  gmail: GmailClient;
  capture: OnCaptured;
  repo: Repository;
  now: () => number;
  newId: () => string;
  stepSize?: number;
  log?: (line: string) => void;
}

const sum = (a: ScanCounts, b: ScanCounts): ScanCounts => ({
  scanned: a.scanned + b.scanned,
  found: a.found + b.found,
  duplicates: a.duplicates + b.duplicates,
  skipped: a.skipped + b.skipped,
  failed: a.failed + b.failed,
});

const viewOf = (j: ImportJob): ImportView => {
  const finished = j.status !== "running";
  return {
    id: j.id,
    status: j.status,
    finished,
    counts: j.counts,
    error: j.error,
    revoked: finished && j.revoked,
    spotted: finished ? j.spotted : [],
  };
};

export function createImportService(d: ImportServiceDeps): ImportService {
  const log = d.log ?? (() => undefined);
  const stepSize = d.stepSize ?? STEP_SIZE;

  async function markHousehold(householdId: string, value: "done" | "declined"): Promise<void> {
    const h = await d.repo.getHousehold(householdId);
    if (h && h.gmail !== value) await d.repo.putHousehold(householdId, { ...h, gmail: value });
  }

  /** The only way a job ends. Revokes the token, deletes the sealed copy, records the outcome. */
  async function end(
    job: ImportJob,
    status: Exclude<ImportJob["status"], "running">,
    error: string | null,
  ): Promise<ImportJob> {
    let revoked = false;
    const token = job.tokenCipher ? await d.box.open(job.tokenCipher) : null;
    if (token) revoked = await d.gmail.revoke(token);
    const ended: ImportJob = {
      ...job,
      status,
      error,
      tokenCipher: null,
      finishedAt: d.now(),
      revoked,
      remaining: [],
      documentIds: [],
    };
    await d.store.update(ended);
    if (status === "done") await markHousehold(job.householdId, "done");
    log(
      `[hippo-import] ${status}${error ? ` (${error})` : ""} scanned=${ended.counts.scanned} found=${ended.counts.found} revoked=${revoked}`,
    );
    return ended;
  }

  const mine = async (householdId: string, id: string): Promise<ImportJob | null> => {
    const j = await d.store.get(id);
    return j && j.householdId === householdId ? j : null;
  };

  return {
    async start(who) {
      const last = await d.store.latestFor(who.householdId);
      if (last?.status === "done" && d.now() - (last.finishedAt ?? last.createdAt) < MIN_GAP_MS)
        return { refused: "too_soon" };
      // Someone who left a scan half way and came back gets a fresh one: the old token is revoked first.
      if (last?.status === "running") await end(last, "cancelled", null);
      const id = d.newId();
      await d.store.create({
        id,
        householdId: who.householdId,
        status: "running",
        createdAt: d.now(),
        finishedAt: null,
        counts: { scanned: 0, found: 0, duplicates: 0, skipped: 0, failed: 0, candidates: 0 },
        remaining: [],
        listed: false,
        documentIds: [],
        spotted: [],
        tokenCipher: await d.box.seal(who.accessToken),
        tokenExpiresAt: d.now() + Math.min(Math.max(who.expiresInSec, 60), 3600) * 1000 - 30_000,
        error: null,
        revoked: false,
      });
      log("[hippo-import] started");
      return { id };
    },

    async view(householdId, id) {
      const j = await mine(householdId, id);
      return j ? viewOf(j) : null;
    },

    async latest(householdId) {
      const j = await d.store.latestFor(householdId);
      return j ? viewOf(j) : null;
    },

    async cancel(householdId, id) {
      const j = await mine(householdId, id);
      if (!j) return null;
      return viewOf(j.status === "running" ? await end(j, "cancelled", null) : j);
    },

    async decline(householdId) {
      await markHousehold(householdId, "declined");
    },

    async step(householdId, id) {
      const first = await mine(householdId, id);
      if (!first) return null;
      if (first.status !== "running") return viewOf(first);
      // Another call is already working on it (a double click, two tabs): answer with where it stands.
      if (!(await d.store.tryLock(id, d.now(), LOCK_MS))) return viewOf(first);
      try {
        let j = await d.store.get(id);
        if (!j || j.status !== "running") return viewOf(j ?? first);
        if (d.now() >= j.tokenExpiresAt) return viewOf(await end(j, "failed", "expired"));
        const token = j.tokenCipher ? await d.box.open(j.tokenCipher) : null;
        if (!token) return viewOf(await end(j, "failed", "failed"));

        if (!j.listed) {
          let found: Awaited<ReturnType<typeof listCandidates>>;
          try {
            found = await listCandidates(d.gmail, token);
          } catch (e) {
            const refused = e instanceof GmailError && (e.status === 401 || e.status === 403);
            return viewOf(await end(j, "failed", refused ? "auth_ended" : "failed"));
          }
          j = {
            ...j,
            listed: true,
            remaining: found.ids,
            documentIds: found.documentIds,
            counts: { ...j.counts, candidates: found.ids.length },
          };
        }

        const batch = await scanBatch(
          { gmail: d.gmail, capture: d.capture, repo: d.repo, now: d.now },
          j.householdId,
          token,
          j.remaining.slice(0, stepSize),
        );
        j = {
          ...j,
          remaining: j.remaining.slice(batch.consumed),
          counts: { ...sum(j.counts, batch.counts), candidates: j.counts.candidates },
        };
        if (batch.stopped === "auth") return viewOf(await end(j, "failed", "auth_ended"));
        if (batch.stopped === "cap" || j.remaining.length === 0) {
          const spotted = await spotDocuments(d.gmail, token, j.documentIds);
          return viewOf(await end({ ...j, spotted }, "done", batch.stopped === "cap" ? "cap" : null));
        }
        await d.store.update(j);
        return viewOf(j);
      } catch (e) {
        // Whatever went wrong, the token is not left behind.
        log(`[hippo-import] step failed (${e instanceof Error ? e.name : "error"})`);
        const cur = (await d.store.get(id)) ?? first;
        return viewOf(cur.status === "running" ? await end(cur, "failed", "failed") : cur);
      } finally {
        await d.store.unlock(id);
      }
    },
  };
}
