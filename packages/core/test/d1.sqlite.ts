import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { D1Like, D1Statement } from "../src/repository/d1";

// A stand in for the D1 binding, on Node's built in SQLite. It proves our SQL and our logic. It is not Cloudflare's D1
// service: transaction behaviour and limits there are checked on a real database before launch.

const MIGRATION = readFileSync(new URL("../../../apps/edge/migrations/0001_items.sql", import.meta.url), "utf8");

export interface SqliteD1 extends D1Like {
  /** Every statement text that ran, to assert on. */
  ran: string[];
  count(): number;
}

export function createSqliteD1(): SqliteD1 {
  const db = new DatabaseSync(":memory:");
  db.exec(MIGRATION);
  const ran: string[] = [];
  const exec = (sql: string, values: unknown[]) => {
    ran.push(sql);
    return { results: db.prepare(sql).all(...(values as never[])) as unknown[] };
  };
  const stmt = (sql: string, values: unknown[] = []): D1Statement & { sql: string; values: unknown[] } => ({
    sql,
    values,
    bind: (...v) => stmt(sql, v),
    all: async () => exec(sql, values),
  });
  return {
    ran,
    count: () => (db.prepare("SELECT count(*) AS n FROM items").get() as { n: number }).n,
    prepare: (sql) => stmt(sql),
    async batch(statements) {
      db.exec("BEGIN");
      try {
        const out = (statements as ReturnType<typeof stmt>[]).map((s) => exec(s.sql, s.values));
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}
