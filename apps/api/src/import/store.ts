import type { ScanCounts, Spotted } from "./scan";

// The state of one mailbox import, kept between the browser's calls (each call does a small step). One record per job. The
// access token is in it only as `tokenCipher` (see tokenBox.ts), and only until the job ends.

export type ImportStatus = "running" | "done" | "failed" | "cancelled";

export interface ImportJob {
  id: string;
  householdId: string;
  status: ImportStatus;
  createdAt: number;
  finishedAt: number | null;
  counts: ScanCounts & { candidates: number };
  /** Message ids still to read, newest first. Empty before the search has run. */
  remaining: string[];
  /** True once the search for subscription mail has run. */
  listed: boolean;
  /** Mail that carries a document to list at the end. */
  documentIds: string[];
  spotted: Spotted[];
  /** Null once the job has ended. */
  tokenCipher: string | null;
  tokenExpiresAt: number;
  /** `auth_ended`, `expired`, `cap` or `failed`; null otherwise. */
  error: string | null;
  /** Whether Google confirmed the access was revoked at the end. */
  revoked: boolean;
}

export interface ImportStore {
  create(job: ImportJob): Promise<void>;
  get(id: string): Promise<ImportJob | null>;
  /** Replaces the record. */
  update(job: ImportJob): Promise<void>;
  /** Takes the job for `ttlMs` unless another caller holds it. One winner, even when called at once. */
  tryLock(id: string, nowMs: number, ttlMs: number): Promise<boolean>;
  unlock(id: string): Promise<void>;
  /** The newest job of a household, or null. */
  latestFor(householdId: string): Promise<ImportJob | null>;
  /** Ends running jobs whose token has expired (and drops the sealed token), and removes old finished jobs. */
  purge(nowMs: number): Promise<void>;
}

export const FINISHED_KEEP_MS = 30 * 24 * 3600_000;

export function createMemoryImportStore(): ImportStore {
  const jobs = new Map<string, ImportJob>();
  const locks = new Map<string, number>();
  const copy = (j: ImportJob): ImportJob => structuredClone(j);
  return {
    async create(job) {
      jobs.set(job.id, copy(job));
    },
    async get(id) {
      const j = jobs.get(id);
      return j ? copy(j) : null;
    },
    async update(job) {
      jobs.set(job.id, copy(job));
    },
    async tryLock(id, nowMs, ttlMs) {
      if (!jobs.has(id)) return false;
      const until = locks.get(id) ?? 0;
      if (until > nowMs) return false;
      locks.set(id, nowMs + ttlMs);
      return true;
    },
    async unlock(id) {
      locks.delete(id);
    },
    async latestFor(householdId) {
      const mine = [...jobs.values()].filter((j) => j.householdId === householdId);
      mine.sort((a, b) => b.createdAt - a.createdAt);
      return mine[0] ? copy(mine[0]) : null;
    },
    async purge(nowMs) {
      for (const [id, j] of jobs) {
        if (j.status === "running" && j.tokenExpiresAt < nowMs) {
          jobs.set(id, { ...j, status: "failed", error: "expired", tokenCipher: null, finishedAt: nowMs });
        } else if (j.finishedAt !== null && j.finishedAt < nowMs - FINISHED_KEEP_MS) {
          jobs.delete(id);
          locks.delete(id);
        }
      }
    },
  };
}
