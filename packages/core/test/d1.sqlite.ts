import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { D1Like, D1Statement } from "../src/repository/d1";

// A stand in for the D1 binding, on Node's built in SQLite, with every migration in apps/edge/migrations applied. It
// proves our SQL and our logic. It is not Cloudflare's D1 service: how D1 behaves under concurrent requests is checked
// on a real database before launch.
//
// Two modes:
// - default: a batch is a transaction (all or nothing), the documented D1 behaviour.
// - interleave: the worst case. Each statement is atomic, but a batch is NOT a transaction and every statement waits
//   for the event loop first, so statements of different requests mix at every step. Code that is correct here does not
//   depend on anything D1 has not promised.

const DIR = new URL("../../../apps/edge/migrations/", import.meta.url);
const MIGRATIONS = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(new URL(f, DIR), "utf8"));

export interface SqliteD1 extends D1Like {
  /** Every statement text that ran, to assert on. */
  ran: string[];
  count(table?: string): number;
}

export function createSqliteD1(opts: { interleave?: boolean } = {}): SqliteD1 {
  const db = new DatabaseSync(":memory:");
  for (const sql of MIGRATIONS) db.exec(sql);
  const ran: string[] = [];
  let turn = 0;
  const wait = async () => {
    if (!opts.interleave) return;
    // One to three trips round the event loop, varying, so concurrent callers drift apart and together.
    for (let i = 0; i <= turn++ % 3; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  const exec = (sql: string, values: unknown[]) => {
    ran.push(sql);
    return { results: db.prepare(sql).all(...(values as never[])) as unknown[] };
  };
  const stmt = (sql: string, values: unknown[] = []): D1Statement & { sql: string; values: unknown[] } => ({
    sql,
    values,
    bind: (...v) => stmt(sql, v),
    all: async () => {
      await wait();
      return exec(sql, values);
    },
  });
  return {
    ran,
    count: (table = "items") => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n,
    prepare: (sql) => stmt(sql),
    async batch(statements) {
      const list = statements as ReturnType<typeof stmt>[];
      if (opts.interleave) {
        const out = [];
        for (const s of list) {
          await wait();
          out.push(exec(s.sql, s.values));
        }
        return out;
      }
      db.exec("BEGIN");
      try {
        const out = list.map((s) => exec(s.sql, s.values));
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}
