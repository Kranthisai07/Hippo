-- One table holds every repository item, the way the DynamoDB design does (packages/core/src/repository/keys.ts).
-- Text columns compare as raw bytes (the default BINARY collation), the same order DynamoDB uses for string keys.
CREATE TABLE IF NOT EXISTS items (
  pk TEXT NOT NULL,
  sk TEXT NOT NULL,
  gsi1pk TEXT,
  gsi1sk TEXT,
  item TEXT NOT NULL,
  PRIMARY KEY (pk, sk)
) WITHOUT ROWID;

-- The sparse index for open alerts: only rows that carry GSI1 attributes are in it.
CREATE INDEX IF NOT EXISTS items_gsi1 ON items (gsi1pk, gsi1sk) WHERE gsi1pk IS NOT NULL;
