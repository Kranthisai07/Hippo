-- One mailbox import per row. `state` is the job as JSON (counts, the ids still to read, what was spotted); the rest are the
-- columns the code looks things up by. `token_cipher` holds the sealed Gmail access token until the job ends, then NULL.
CREATE TABLE IF NOT EXISTS import_jobs (
  id TEXT PRIMARY KEY,
  household TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  token_cipher TEXT,
  token_expires_at INTEGER NOT NULL,
  locked_until INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS import_jobs_household ON import_jobs (household, created_at);
