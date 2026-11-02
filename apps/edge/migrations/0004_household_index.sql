-- The daily job looks up households by their record (sk = 'HOUSEHOLD') every 15 minutes. The primary key is (pk, sk), so
-- without this a lookup reads every row of the table. This index holds one entry per household only.
CREATE INDEX IF NOT EXISTS items_households ON items (pk) WHERE sk = 'HOUSEHOLD';
