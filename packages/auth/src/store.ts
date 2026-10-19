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
  putSession(key: string, rec: SessionRecord): Promise<void>;
  getSession(key: string): Promise<SessionRecord | undefined>;
  deleteSession(key: string): Promise<void>;
  putMagic(emailKey: string, rec: MagicRecord): Promise<void>;
  getMagic(emailKey: string): Promise<MagicRecord | undefined>;
  deleteMagic(emailKey: string): Promise<void>;
}

export function createMemoryStore(): AuthStore {
  const codes = new Map<string, { rec: CodeRecord; used: boolean }>();
  const refresh = new Map<string, { rec: RefreshRecord; used: boolean }>();
  const sessions = new Map<string, SessionRecord>();
  const magic = new Map<string, MagicRecord>();

  const consume = <T>(m: Map<string, { rec: T; used: boolean }>, key: string): Consumed<T> => {
    const e = m.get(key);
    if (!e) return { status: "unknown" };
    if (e.used) return { status: "used", record: e.rec };
    e.used = true;
    return { status: "ok", record: e.rec };
  };

  return {
    async putCode(key, rec) {
      codes.set(key, { rec, used: false });
    },
    async consumeCode(key) {
      return consume(codes, key);
    },
    async putRefresh(key, rec) {
      refresh.set(key, { rec, used: false });
    },
    async consumeRefresh(key) {
      return consume(refresh, key);
    },
    async revokeFamily(familyId) {
      for (const e of refresh.values()) if (e.rec.familyId === familyId) e.used = true;
      for (const e of codes.values()) if (e.rec.familyId === familyId) e.used = true;
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
  };
}
