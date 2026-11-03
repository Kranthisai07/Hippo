-- Which households the daily job has finished today. The job works through a few households per run, so a run that comes
-- after another one the same day skips the ones already done. One row per household, overwritten each day.
CREATE TABLE IF NOT EXISTS daily_runs (
  pk TEXT PRIMARY KEY,
  day TEXT NOT NULL
) WITHOUT ROWID;
