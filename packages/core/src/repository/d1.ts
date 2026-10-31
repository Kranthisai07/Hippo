import type { Repository } from "../contracts";
import { createItemRepository, type Item, type ItemClient, type WriteRequest } from "./items";

// The repository on Cloudflare D1 (schema: apps/edge/migrations/0001_items.sql). It implements ItemClient, so the
// repository logic is the one in items.ts and the shared repository suite proves it. This file imports no AWS SDK.

/** The part of a D1 database binding this file uses. */
export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  all(): Promise<{ results?: unknown[] }>;
}
export interface D1Like {
  prepare(sql: string): D1Statement;
  /** All statements in one transaction: they all apply or none does. */
  batch(statements: D1Statement[]): Promise<{ results?: unknown[] }[]>;
}

const D1_BATCH = 25;

export function createD1ItemClient(db: D1Like): ItemClient {
  const rows = async (sql: string, ...values: unknown[]): Promise<Record<string, unknown>[]> =>
    (
      (
        await db
          .prepare(sql)
          .bind(...values)
          .all()
      ).results ?? []
    ).map((r) => r as Record<string, unknown>);
  const parse = (r: Record<string, unknown>): Item => JSON.parse(r.item as string) as Item;

  const upsert = (item: Item): D1Statement =>
    db
      .prepare("INSERT OR REPLACE INTO items (pk, sk, gsi1pk, gsi1sk, item) VALUES (?, ?, ?, ?, ?)")
      .bind(item.PK, item.SK, item.GSI1PK ?? null, item.GSI1SK ?? null, JSON.stringify(item));
  const remove = (pk: string, sk: string): D1Statement =>
    db.prepare("DELETE FROM items WHERE pk = ? AND sk = ?").bind(pk, sk);

  return {
    async put(item) {
      await upsert(item).all();
    },
    async get(pk, sk) {
      const [r] = await rows("SELECT item FROM items WHERE pk = ? AND sk = ?", pk, sk);
      return r ? parse(r) : null;
    },
    async delete(pk, sk) {
      await remove(pk, sk).all();
    },
    async deleteIfExists(pk, sk) {
      // One UPDATE can set the claim on a row, once, so only one caller can see its own value afterwards and go on to
      // delete. This does not depend on D1 treating a batch as isolated. If the Worker dies between the claim and the
      // delete, that row stays claimed (an undo record that can no longer be popped, and it expires anyway).
      const mine = crypto.randomUUID();
      await db.prepare("UPDATE items SET claim = ? WHERE pk = ? AND sk = ? AND claim IS NULL").bind(mine, pk, sk).all();
      const [row] = await rows("SELECT claim FROM items WHERE pk = ? AND sk = ?", pk, sk);
      if (row?.claim !== mine) return false;
      await db.prepare("DELETE FROM items WHERE pk = ? AND sk = ? AND claim = ?").bind(pk, sk, mine).all();
      return true;
    },
    async query({ index, hash, range, descending }) {
      const [hashCol, rangeCol] = index ? ["gsi1pk", "gsi1sk"] : ["pk", "sk"];
      const where = [`${hashCol} = ?`];
      const args: unknown[] = [hash];
      if (range && "beginsWith" in range) {
        // Not LIKE: a % or _ in a key must stay a plain character.
        where.push(`substr(${rangeCol}, 1, ?) = ?`);
        args.push([...range.beginsWith].length, range.beginsWith);
      } else if (range) {
        if (range.between[0] > range.between[1]) return [];
        where.push(`${rangeCol} BETWEEN ? AND ?`);
        args.push(...range.between);
      }
      // The index orders by its own sort key, then the table key, so equal sort keys come back in a fixed order.
      const order = (index ? [rangeCol, "pk", "sk"] : ["sk"]).map((c) => `${c} ${descending ? "DESC" : "ASC"}`);
      return (
        await rows(`SELECT item FROM items WHERE ${where.join(" AND ")} ORDER BY ${order.join(", ")}`, ...args)
      ).map(parse);
    },
    async write(requests: WriteRequest[]) {
      // shortcut: a fixed chunk of 25, like the DynamoDB client. D1's own limit on statements per batch is not verified.
      for (let i = 0; i < requests.length; i += D1_BATCH) {
        await db.batch(
          requests
            .slice(i, i + D1_BATCH)
            .map((r) =>
              "PutRequest" in r ? upsert(r.PutRequest.Item) : remove(r.DeleteRequest.Key.PK, r.DeleteRequest.Key.SK),
            ),
        );
      }
    },
  };
}

export const createD1Repository = (db: D1Like): Repository => createItemRepository(createD1ItemClient(db));
