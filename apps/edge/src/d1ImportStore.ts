import type { D1Like } from "core/src/repository/d1";
import { FINISHED_KEEP_MS, type ImportJob, type ImportStore } from "../../api/src/import/store";

// The import jobs on D1 (migration 0005_import.sql). Every change is one statement, so nothing depends on how D1 orders
// separate statements, and the lock is a single UPDATE that only one caller can win.

type Row = {
  id: string;
  household: string;
  status: ImportJob["status"];
  created_at: number;
  finished_at: number | null;
  token_cipher: string | null;
  token_expires_at: number;
  state: string;
};

type State = Pick<ImportJob, "counts" | "remaining" | "listed" | "documentIds" | "spotted" | "error" | "revoked">;

const toRow = (j: ImportJob): [string, string, string, number, number | null, string | null, number, string] => {
  const state: State = {
    counts: j.counts,
    remaining: j.remaining,
    listed: j.listed,
    documentIds: j.documentIds,
    spotted: j.spotted,
    error: j.error,
    revoked: j.revoked,
  };
  return [
    j.id,
    j.householdId,
    j.status,
    j.createdAt,
    j.finishedAt,
    j.tokenCipher,
    j.tokenExpiresAt,
    JSON.stringify(state),
  ];
};

const fromRow = (r: Row): ImportJob => {
  const s = JSON.parse(r.state) as State;
  return {
    id: r.id,
    householdId: r.household,
    status: r.status,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
    counts: s.counts,
    remaining: s.remaining,
    listed: s.listed,
    documentIds: s.documentIds,
    spotted: s.spotted,
    tokenCipher: r.token_cipher,
    tokenExpiresAt: r.token_expires_at,
    error: s.error,
    revoked: s.revoked,
  };
};

export function createD1ImportStore(db: D1Like): ImportStore {
  const rows = async (sql: string, ...values: unknown[]): Promise<Record<string, unknown>[]> =>
    ((
      await db
        .prepare(sql)
        .bind(...values)
        .all()
    ).results ?? []) as Record<string, unknown>[];

  return {
    async create(job) {
      await rows(
        "INSERT INTO import_jobs (id, household, status, created_at, finished_at, token_cipher, token_expires_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ...toRow(job),
      );
    },
    async get(id) {
      const [r] = await rows("SELECT * FROM import_jobs WHERE id = ?", id);
      return r ? fromRow(r as unknown as Row) : null;
    },
    async update(job) {
      const [id, , status, , finishedAt, cipher, expires, state] = toRow(job);
      // Only while it is still running, in the one statement, so a step that was in flight cannot undo a cancel.
      const written = await rows(
        "UPDATE import_jobs SET status = ?, finished_at = ?, token_cipher = ?, token_expires_at = ?, state = ? WHERE id = ? AND status = 'running' RETURNING id",
        status,
        finishedAt,
        cipher,
        expires,
        state,
        id,
      );
      return written.length === 1;
    },
    async deleteFor(householdId) {
      await rows("DELETE FROM import_jobs WHERE household = ?", householdId);
    },
    async tryLock(id, nowMs, ttlMs) {
      const won = await rows(
        "UPDATE import_jobs SET locked_until = ? WHERE id = ? AND locked_until <= ? RETURNING id",
        nowMs + ttlMs,
        id,
        nowMs,
      );
      return won.length === 1;
    },
    async unlock(id) {
      await rows("UPDATE import_jobs SET locked_until = 0 WHERE id = ?", id);
    },
    async latestFor(householdId) {
      const [r] = await rows(
        "SELECT * FROM import_jobs WHERE household = ? ORDER BY created_at DESC LIMIT 1",
        householdId,
      );
      return r ? fromRow(r as unknown as Row) : null;
    },
    async purge(nowMs) {
      await rows(
        "UPDATE import_jobs SET status = 'failed', token_cipher = NULL, finished_at = ?, state = json_set(state, '$.error', 'expired', '$.remaining', json('[]'), '$.documentIds', json('[]')) WHERE status = 'running' AND token_expires_at < ?",
        nowMs,
        nowMs,
      );
      await rows("DELETE FROM import_jobs WHERE finished_at IS NOT NULL AND finished_at < ?", nowMs - FINISHED_KEEP_MS);
    },
  };
}
