import type { AuthStore, CodeRecord, Consumed, RefreshRecord, SessionRecord } from "@hippo/auth/src/store";
import type { D1Like } from "core/src/repository/d1";

// The sign in store on Cloudflare D1 (schema: migrations/0002_auth.sql). It never relies on a batch being isolated or on
// a statement reporting how many rows it changed, neither of which D1's documentation promises (docs/VERIFIED.md 10).
// Each guarantee is one statement, and SQLite runs one statement atomically:
// - consume: one UPDATE can set `winner` on a row once. Each call brings its own random value and reads the row back, so
//   exactly one caller finds its own value there.
// - revoke versus rotation: revoking a family writes a tombstone, and consume refuses any record whose family has one,
//   whenever that record was stored. So a token put after (or during) a revoke is dead, whichever order they landed in.
// - rate counter: one conditional INSERT takes the slot only if the window has room.

type Row = Record<string, unknown>;

export interface D1AuthStoreOptions {
  /** Milliseconds. Only used to stamp tombstones. */
  now?: () => number;
}

export function createD1AuthStore(
  db: D1Like,
  opts: D1AuthStoreOptions = {},
): AuthStore & {
  /** Deletes records past their expiry, and tombstones older than `tombstoneTtlMs` (the longest a token can live). */
  purgeExpired(nowMs: number, tombstoneTtlMs: number): Promise<void>;
} {
  const clock = opts.now ?? Date.now;
  const rows = async (sql: string, ...values: unknown[]): Promise<Row[]> =>
    ((
      await db
        .prepare(sql)
        .bind(...values)
        .all()
    ).results ?? []) as Row[];
  const run = async (sql: string, ...values: unknown[]): Promise<void> => void (await rows(sql, ...values));

  /** codes and refresh tokens are the same shape, in two tables. */
  const oneTime = <T extends CodeRecord | RefreshRecord>(table: "auth_codes" | "auth_refresh") => ({
    put: (key: string, rec: T) =>
      run(
        `INSERT OR REPLACE INTO ${table} (key, family_id, sub, expires_at, rec, winner) VALUES (?, ?, ?, ?, ?, NULL)`,
        key,
        rec.familyId,
        rec.sub,
        rec.expiresAt,
        JSON.stringify(rec),
      ),
    async consume(key: string): Promise<Consumed<T>> {
      const mine = crypto.randomUUID();
      await run(
        `UPDATE ${table} SET winner = ? WHERE key = ? AND winner IS NULL
           AND family_id NOT IN (SELECT family_id FROM auth_revoked_families)`,
        mine,
        key,
      );
      const [row] = await rows(`SELECT rec, winner FROM ${table} WHERE key = ?`, key);
      if (!row) return { status: "unknown" };
      const record = JSON.parse(row.rec as string) as T;
      return { status: row.winner === mine ? "ok" : "used", record };
    },
  });
  const codes = oneTime<CodeRecord>("auth_codes");
  const refresh = oneTime<RefreshRecord>("auth_refresh");

  const store: AuthStore = {
    putCode: codes.put,
    consumeCode: codes.consume,
    putRefresh: refresh.put,
    consumeRefresh: refresh.consume,

    revokeFamily: (familyId) =>
      run("INSERT OR IGNORE INTO auth_revoked_families (family_id, at) VALUES (?, ?)", familyId, clock()),

    async revokeUser(sub) {
      await run("DELETE FROM auth_sessions WHERE sub = ?", sub);
      await run(
        `INSERT OR IGNORE INTO auth_revoked_families (family_id, at)
         SELECT family_id, ? FROM auth_refresh WHERE sub = ?
         UNION SELECT family_id, ? FROM auth_codes WHERE sub = ?`,
        clock(),
        sub,
        clock(),
        sub,
      );
    },

    putSession: (key, rec: SessionRecord) =>
      run(
        "INSERT OR REPLACE INTO auth_sessions (key, sub, expires_at, rec) VALUES (?, ?, ?, ?)",
        key,
        rec.sub,
        rec.expiresAt,
        JSON.stringify(rec),
      ),
    async getSession(key) {
      const [row] = await rows("SELECT rec FROM auth_sessions WHERE key = ?", key);
      return row ? (JSON.parse(row.rec as string) as SessionRecord) : undefined;
    },
    deleteSession: (key) => run("DELETE FROM auth_sessions WHERE key = ?", key),

    putMagic: (key, rec) =>
      run(
        "INSERT OR REPLACE INTO auth_magic (key, expires_at, rec) VALUES (?, ?, ?)",
        key,
        rec.expiresAt,
        JSON.stringify(rec),
      ),
    async getMagic(key) {
      const [row] = await rows("SELECT rec FROM auth_magic WHERE key = ?", key);
      return row ? JSON.parse(row.rec as string) : undefined;
    },
    deleteMagic: (key) => run("DELETE FROM auth_magic WHERE key = ?", key),

    async tryHit(key, windowMs, max, minGapMs, nowMs) {
      const since = nowMs - windowMs;
      // Hits that left the window are only clutter. A key keeps one window length, so this never removes a live hit.
      await run("DELETE FROM auth_hits WHERE key = ? AND ts <= ?", key, since);
      const before = (await rows("SELECT ts FROM auth_hits WHERE key = ? AND ts > ? ORDER BY ts", key, since)).map(
        (r) => r.ts as number,
      );
      // Take the slot only if there is room and the last hit is old enough. One statement, so two callers cannot both
      // take the last slot, whatever order their statements run in. The row carries this call's own random value, so
      // reading it back says whether this call, and not another one, got the slot.
      const mine = crypto.randomUUID();
      await run(
        `INSERT INTO auth_hits (key, ts, nonce)
         SELECT ?, ?, ? WHERE (SELECT count(*) FROM auth_hits WHERE key = ? AND ts > ?) < ?
           AND NOT EXISTS (SELECT 1 FROM auth_hits WHERE key = ? AND ts > ?)`,
        key,
        nowMs,
        mine,
        key,
        since,
        max,
        key,
        nowMs - minGapMs,
      );
      if ((await rows("SELECT 1 AS got FROM auth_hits WHERE key = ? AND nonce = ?", key, mine)).length > 0) {
        return { ok: true };
      }
      // Refused. The wait is worked out the way the memory store does it, from the hits seen before the attempt.
      const waits: number[] = [];
      if (before.length >= max) waits.push(before[before.length - max]! + windowMs - nowMs);
      const last = before[before.length - 1];
      if (last !== undefined && nowMs - last < minGapMs) waits.push(last + minGapMs - nowMs);
      // Other callers filled the window between the look and the insert: ask for a short wait.
      return { ok: false, retryAfterMs: waits.length > 0 ? Math.max(...waits) : 1000 };
    },
    clearCounter: (key) => run("DELETE FROM auth_hits WHERE key = ?", key),
  };

  return {
    ...store,
    async purgeExpired(nowMs, tombstoneTtlMs) {
      await run("DELETE FROM auth_codes WHERE expires_at <= ?", nowMs);
      await run("DELETE FROM auth_refresh WHERE expires_at <= ?", nowMs);
      await run("DELETE FROM auth_sessions WHERE expires_at <= ?", nowMs);
      await run("DELETE FROM auth_magic WHERE expires_at <= ?", nowMs);
      await run("DELETE FROM auth_revoked_families WHERE at <= ?", nowMs - tombstoneTtlMs);
    },
  };
}
