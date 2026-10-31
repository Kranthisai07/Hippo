-- Sign in state (packages/auth/src/store.ts). Every key is already a hash of the secret, so a dump holds no usable token.
-- `winner` is set once, by the single caller that consumes a record (a random value per call), so no statement has to
-- report how many rows it changed. A record in a revoked family is never usable.

CREATE TABLE IF NOT EXISTS auth_codes (
  key TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  sub TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  rec TEXT NOT NULL,
  winner TEXT
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS auth_codes_sub ON auth_codes (sub);
CREATE INDEX IF NOT EXISTS auth_codes_family ON auth_codes (family_id);

CREATE TABLE IF NOT EXISTS auth_refresh (
  key TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  sub TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  rec TEXT NOT NULL,
  winner TEXT
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS auth_refresh_sub ON auth_refresh (sub);
CREATE INDEX IF NOT EXISTS auth_refresh_family ON auth_refresh (family_id);

CREATE TABLE IF NOT EXISTS auth_revoked_families (
  family_id TEXT PRIMARY KEY,
  at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS auth_sessions (
  key TEXT PRIMARY KEY,
  sub TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  rec TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS auth_sessions_sub ON auth_sessions (sub);

CREATE TABLE IF NOT EXISTS auth_magic (
  key TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  rec TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS auth_hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  ts INTEGER NOT NULL,
  -- A random value per call, so a caller can tell whether its own hit was recorded.
  nonce TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_hits_key_ts ON auth_hits (key, ts);
