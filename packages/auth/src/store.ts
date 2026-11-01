export interface CodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  sub: string;
  householdId: string;
  familyId: string;
  expiresAt: number;
}

export interface RefreshRecord {
  clientId: string;
  resource: string;
  scope: string;
  sub: string;
  householdId: string;
  familyId: string;
  expiresAt: number;
}

export interface SessionRecord {
  email: string;
  sub: string;
  householdId: string;
  expiresAt: number;
}

export interface MagicRecord {
  codeHash: string;
  expiresAt: number;
  attempts: number;
}

export type Consumed<T> = { status: "ok"; record: T } | { status: "used"; record: T } | { status: "unknown" };

// Every key is a hash of the secret value, so a store dump does not leak usable credentials.
// consume* must be atomic: two concurrent calls with the same key may return "ok" at most once.
export interface AuthStore {
  putCode(key: string, rec: CodeRecord): Promise<void>;
  consumeCode(key: string): Promise<Consumed<CodeRecord>>;
  putRefresh(key: string, rec: RefreshRecord): Promise<void>;
  consumeRefresh(key: string): Promise<Consumed<RefreshRecord>>;
  revokeFamily(familyId: string): Promise<void>;
  /** Ends every web session and every refresh token of one user. A durable store needs an index by `sub` for this. */
  revokeUser(sub: string): Promise<void>;
  putSession(key: string, rec: SessionRecord): Promise<void>;
  getSession(key: string): Promise<SessionRecord | undefined>;
  deleteSession(key: string): Promise<void>;
  putMagic(emailKey: string, rec: MagicRecord): Promise<void>;
  getMagic(emailKey: string): Promise<MagicRecord | undefined>;
  deleteMagic(emailKey: string): Promise<void>;
  /**
   * Atomic rate counter. Records a hit at nowMs and returns ok only if fewer than max hits fall inside the
   * trailing windowMs and the last hit is at least minGapMs old. A refused call records nothing.
   * A durable store must do this as one conditional write.
   */
  tryHit(key: string, windowMs: number, max: number, minGapMs: number, nowMs: number): Promise<HitResult>;
  clearCounter(key: string): Promise<void>;
}

export type HitResult = { ok: true } | { ok: false; retryAfterMs: number };

export function createMemoryStore(): AuthStore {
  const codes = new Map<string, { rec: CodeRecord; used: boolean }>();
  const refresh = new Map<string, { rec: RefreshRecord; used: boolean }>();
  const sessions = new Map<string, SessionRecord>();
  const magic = new Map<string, MagicRecord>();
  const counters = new Map<string, number[]>();
  // A revoked family stays dead: records already issued are used up, and a record put into it later is born used. This
  // closes the race where a rotation (consume the old token, then put the new one) straddles a revoke.
  const revokedFamilies = new Set<string>();

  const consume = <T>(m: Map<string, { rec: T; used: boolean }>, key: string): Consumed<T> => {
    const e = m.get(key);
    if (!e) return { status: "unknown" };
    if (e.used || revokedFamilies.has((e.rec as { familyId: string }).familyId)) {
      return { status: "used", record: e.rec };
    }
    e.used = true;
    return { status: "ok", record: e.rec };
  };

  return {
    async putCode(key, rec) {
      codes.set(key, { rec, used: revokedFamilies.has(rec.familyId) });
    },
    async consumeCode(key) {
      return consume(codes, key);
    },
    async putRefresh(key, rec) {
      refresh.set(key, { rec, used: revokedFamilies.has(rec.familyId) });
    },
    async consumeRefresh(key) {
      return consume(refresh, key);
    },
    async revokeFamily(familyId) {
      revokedFamilies.add(familyId);
      for (const e of refresh.values()) if (e.rec.familyId === familyId) e.used = true;
      for (const e of codes.values()) if (e.rec.familyId === familyId) e.used = true;
    },
    async revokeUser(sub) {
      for (const e of refresh.values()) if (e.rec.sub === sub) ((e.used = true), revokedFamilies.add(e.rec.familyId));
      for (const e of codes.values()) if (e.rec.sub === sub) ((e.used = true), revokedFamilies.add(e.rec.familyId));
      for (const [k, v] of sessions) if (v.sub === sub) sessions.delete(k);
    },
    async putSession(key, rec) {
      sessions.set(key, rec);
    },
    async getSession(key) {
      return sessions.get(key);
    },
    async deleteSession(key) {
      sessions.delete(key);
    },
    async putMagic(k, rec) {
      magic.set(k, rec);
    },
    async getMagic(k) {
      return magic.get(k);
    },
    async deleteMagic(k) {
      magic.delete(k);
    },
    async tryHit(key, windowMs, max, minGapMs, nowMs) {
      const hits = (counters.get(key) ?? []).filter((t) => t > nowMs - windowMs);
      const last = hits[hits.length - 1];
      const waits: number[] = [];
      if (hits.length >= max) waits.push(hits[hits.length - max]! + windowMs - nowMs);
      if (minGapMs > 0 && last !== undefined && nowMs - last < minGapMs) waits.push(last + minGapMs - nowMs);
      if (waits.length > 0) {
        counters.set(key, hits);
        return { ok: false, retryAfterMs: Math.max(...waits) };
      }
      // Sorted, because callers on different machines arrive out of clock order and the wait is read from the ends.
      hits.push(nowMs);
      hits.sort((a, b) => a - b);
      counters.set(key, hits);
      return { ok: true };
    },
    async clearCounter(key) {
      counters.delete(key);
    },
  };
}
