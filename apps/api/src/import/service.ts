import type { Repository } from "core/src/contracts";
import type { OnCaptured } from "../api/extension";
import { GmailError, type GmailClient } from "./gmail";
import { listCandidates, scanBatch, spotDocuments, type ScanCounts, type Spotted } from "./scan";
import type { ImportJob, ImportStore } from "./store";
import type { TokenBox } from "./tokenBox";

// One mailbox import, driven by the browser in small steps so no request runs long. The rules this file keeps:
//  - The access token exists only sealed (tokenBox.ts), only for the job, and every way a job can end goes through `end`,
//    which asks Google to revoke it and deletes the sealed copy. Two ends are left to Google and the cleanup: a person who
//    closes the page (the token dies by itself within the hour, and the next read of the job or the cleanup deletes the
//    sealed copy) and a household's own "delete all data" (`forget`, which does go through `end`).
//  - A write only lands while the job is still running (`store.update`), so a step that was in flight when the person
//    cancelled cannot bring the job back.
//  - A job is read and changed only by the household it belongs to, and the household comes from the session, never from
//    the request.
//  - Nothing here logs an address, a subject, a message id or a token: counts and error names only.

export const STEP_SIZE = 25;
export const LOCK_MS = 60_000;
/** One finished scan a day: a person who scanned today is told to come back tomorrow. */
/** How long `forget` waits for a step that was already working (a Gmail read can take 10 s and be retried once). */
export const DRAIN_MS = 30_000;
const DRAIN_POLL_MS = 250;
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
  /** Set only on an answer to a step that did no work because another step of the same job was running. */
  busy?: true;
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
  /**
   * Does the next small step. `beforeWork` runs once this call holds the job and is about to work (the route charges its
   * rate limit there, so a call that only finds the job busy costs nothing); if it throws, nothing is done.
   */
  step(householdId: string, id: string, beforeWork?: () => Promise<void>): Promise<ImportView | null>;
  cancel(householdId: string, id: string): Promise<ImportView | null>;
  decline(householdId: string): Promise<void>;
  /**
   * "Delete all data": ends a running scan (revoking its access), waits for a step that was already working to stop, then
   * deletes every scan record of the household. False: a step was still working after the wait, and nothing was deleted
   * (the scan itself is ended); the caller must not go on to wipe the household, and can try again.
   */
  forget(householdId: string): Promise<boolean>;
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
  /** Test seam for the wait in `forget`. Default: a real timer. */
  sleep?: (ms: number) => Promise<void>;
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
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function markHousehold(householdId: string, value: "done" | "declined"): Promise<void> {
    const h = await d.repo.getHousehold(householdId);
    if (h && h.gmail !== value) await d.repo.putHousehold(householdId, { ...h, gmail: value });
  }

  /** The only way a job ends. Revokes the token, deletes the sealed copy, records the outcome. */
  async function end(
    job: ImportJob,
    status: Exclude<ImportJob["status"], "running">,
    error: string | null,
    /** The step ending its own job passes its lock mark; a cancel, a delete or a read of an expired job passes null. */
    owner: string | null = null,
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
    // Already ended by someone else (a cancel while this step was working): theirs stands, the revoke above was harmless.
    if (!(await d.store.update(ended, owner))) return (await d.store.get(job.id)) ?? ended;
    if (status === "done") await markHousehold(job.householdId, "done");
    log(
      `[hippo-import] ${status}${error ? ` (${error})` : ""} scanned=${ended.counts.scanned} found=${ended.counts.found} revoked=${revoked}`,
    );
    return ended;
  }

  /** A running job whose token has run out is ended here, so its sealed copy does not wait for the nightly cleanup. */
  const fresh = async (j: ImportJob): Promise<ImportJob> =>
    j.status === "running" && d.now() >= j.tokenExpiresAt ? end(j, "failed", "expired") : j;

  const mine = async (householdId: string, id: string): Promise<ImportJob | null> => {
    const j = await d.store.get(id);
    return j && j.householdId === householdId ? fresh(j) : null;
  };

  return {
    async start(who) {
      const last = await d.store.latestFor(who.householdId);
      if (last?.status === "done" && d.now() - (last.finishedAt ?? last.createdAt) < MIN_GAP_MS) {
        // The person just granted access for nothing: give it back now.
        await d.gmail.revoke(who.accessToken);
        return { refused: "too_soon" };
      }
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
      return j ? viewOf(await fresh(j)) : null;
    },

    async cancel(householdId, id) {
      const j = await mine(householdId, id);
      if (!j) return null;
      return viewOf(j.status === "running" ? await end(j, "cancelled", null) : j);
    },

    async decline(householdId) {
      await markHousehold(householdId, "declined");
    },

    async forget(householdId) {
      const j = await d.store.latestFor(householdId);
      if (j?.status === "running") await end(j, "cancelled", null);
      if (j) {
        // The step that was working sees the job ended at its next check and lets go of the lock. Holding the lock
        // ourselves is the proof that no step is still saving a page.
        const me = d.newId();
        let drained = false;
        for (let waited = 0; waited <= DRAIN_MS && !drained; waited += DRAIN_POLL_MS) {
          if (await d.store.tryLock(j.id, me, d.now(), LOCK_MS)) {
            await d.store.unlock(j.id, me);
            drained = true;
          } else await sleep(DRAIN_POLL_MS);
        }
        if (!drained) return false;
      }
      await d.store.deleteFor(householdId);
      return true;
    },

    async step(householdId, id, beforeWork) {
      const first = await mine(householdId, id);
      if (!first) return null;
      if (first.status !== "running") return viewOf(first);
      // Another call is already working on it (a double click, two tabs): answer with where it stands.
      // Every step has its own mark on the lock. It writes only while the mark is still its own, and asks again before
      // each message (which also keeps the lease alive), so a step that took too long, or was cancelled or deleted
      // meanwhile, stops instead of writing over the one that replaced it.
      const owner = d.newId();
      if (!(await d.store.tryLock(id, owner, d.now(), LOCK_MS))) return { ...viewOf(first), busy: true };
      try {
        await beforeWork?.();
      } catch (e) {
        await d.store.unlock(id, owner);
        throw e;
      }
      try {
        let j = await d.store.get(id);
        if (!j || j.status !== "running") return viewOf(j ?? first);
        if (d.now() >= j.tokenExpiresAt) return viewOf(await end(j, "failed", "expired", owner));
        const token = j.tokenCipher ? await d.box.open(j.tokenCipher) : null;
        if (!token) return viewOf(await end(j, "failed", "failed", owner));

        if (!j.listed) {
          let found: Awaited<ReturnType<typeof listCandidates>>;
          try {
            found = await listCandidates(d.gmail, token);
          } catch (e) {
            const refused = e instanceof GmailError && (e.status === 401 || e.status === 403);
            return viewOf(await end(j, "failed", refused ? "auth_ended" : "failed", owner));
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
          () => d.store.renew(id, owner, d.now(), LOCK_MS),
        );
        j = {
          ...j,
          remaining: j.remaining.slice(batch.consumed),
          counts: { ...sum(j.counts, batch.counts), candidates: j.counts.candidates },
        };
        // No longer the owner (cancelled, deleted, or taken over): write nothing, end nothing, say where the job stands.
        if (batch.stopped === "lost") return viewOf((await d.store.get(id)) ?? j);
        if (batch.stopped === "auth") return viewOf(await end(j, "failed", "auth_ended", owner));
        if (batch.stopped === "cap" || j.remaining.length === 0) {
          const spotted = await spotDocuments(d.gmail, token, j.documentIds);
          return viewOf(await end({ ...j, spotted }, "done", batch.stopped === "cap" ? "cap" : null, owner));
        }
        // Cancelled while this step was working: say where the job stands now, and write nothing.
        if (!(await d.store.update(j, owner))) return viewOf((await d.store.get(id)) ?? j);
        return viewOf(j);
      } catch (e) {
        // Whatever went wrong, the token is not left behind.
        log(`[hippo-import] step failed (${e instanceof Error ? e.name : "error"})`);
        const cur = (await d.store.get(id)) ?? first;
        return viewOf(cur.status === "running" ? await end(cur, "failed", "failed", owner) : cur);
      } finally {
        await d.store.unlock(id, owner);
      }
    },
  };
}
