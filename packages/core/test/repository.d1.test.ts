import { describe, expect, it } from "vitest";
import { createD1ItemClient, createD1Repository } from "../src/repository/d1";
import type { Item } from "../src/repository/items";
import { createSqliteD1 } from "./d1.sqlite";
import { runRepositorySuite } from "./repository.suite";

// The whole shared suite, on D1 over SQLite.
runRepositorySuite("D1 on node:sqlite (not Cloudflare D1)", () => createD1Repository(createSqliteD1()));

const item = (pk: string, sk: string, extra: Partial<Item> = {}): Item =>
  ({ PK: pk, SK: sk, entity: "DOC", data: { sk }, ...extra }) as Item;
const skOf = (items: Item[]) => items.map((i) => i.SK);

describe("the D1 item client's own behaviour", () => {
  it("get returns what put stored, and nothing for a missing key or another partition", async () => {
    const c = createD1ItemClient(createSqliteD1());
    await c.put(item("H#a", "DOC#1"));
    expect(await c.get("H#a", "DOC#1")).toEqual(item("H#a", "DOC#1"));
    expect(await c.get("H#a", "DOC#2")).toBeNull();
    expect(await c.get("H#b", "DOC#1")).toBeNull();
  });

  it("deleteIfExists says false for a missing row and true for a present one, once", async () => {
    const c = createD1ItemClient(createSqliteD1());
    expect(await c.deleteIfExists("H#a", "U#1")).toBe(false);
    await c.put(item("H#a", "U#1"));
    expect(await c.deleteIfExists("H#a", "U#1")).toBe(true);
    expect(await c.deleteIfExists("H#a", "U#1")).toBe(false);
  });

  it("racing deleteIfExists: exactly one wins, even when statements of different callers interleave", async () => {
    for (const interleave of [false, true]) {
      const db = createSqliteD1({ interleave });
      const c = createD1ItemClient(db);
      await c.put(item("H#a", "U#1"));
      const wins = await Promise.all(Array.from({ length: 12 }, () => c.deleteIfExists("H#a", "U#1")));
      expect(wins.filter(Boolean)).toHaveLength(1);
      expect(db.count()).toBe(0);
    }
  });

  it("a row that was claimed and then written again is deletable again", async () => {
    const c = createD1ItemClient(createSqliteD1());
    await c.put(item("H#a", "U#1"));
    expect(await c.deleteIfExists("H#a", "U#1")).toBe(true);
    await c.put(item("H#a", "U#1"));
    expect(await c.deleteIfExists("H#a", "U#1")).toBe(true);
  });

  it("a write is all or nothing", async () => {
    const db = createSqliteD1();
    const c = createD1ItemClient(db);
    const bad = { PK: "H#a", SK: "X#2", entity: "DOC", data: 1n } as unknown as Item;
    await expect(
      c.write([{ PutRequest: { Item: item("H#a", "X#1") } }, { PutRequest: { Item: bad } }]),
    ).rejects.toThrow();
    expect(db.count()).toBe(0);
  });

  it("writes more than one chunk, puts and deletes together", async () => {
    const c = createD1ItemClient(createSqliteD1());
    const puts = Array.from({ length: 60 }, (_, i) => ({
      PutRequest: { Item: item("H#a", `X#${String(i).padStart(2, "0")}`) },
    }));
    await c.write(puts);
    expect(await c.query({ hash: "H#a" })).toHaveLength(60);
    await c.write([
      { DeleteRequest: { Key: { PK: "H#a", SK: "X#00" } } },
      { PutRequest: { Item: item("H#a", "Y#1") } },
    ]);
    expect((await c.query({ hash: "H#a" })).length).toBe(60);
  });

  it("orders keys as raw bytes (upper case before lower case), in both directions, and begins_with is exact", async () => {
    const c = createD1ItemClient(createSqliteD1());
    for (const sk of ["a#1", "B#1", "A#1", "%#1", "a_1", "ab1"]) await c.put(item("H#a", sk));
    expect(skOf(await c.query({ hash: "H#a" }))).toEqual(["%#1", "A#1", "B#1", "a#1", "a_1", "ab1"]);
    expect(skOf(await c.query({ hash: "H#a", descending: true }))).toEqual(["ab1", "a_1", "a#1", "B#1", "A#1", "%#1"]);
    expect(skOf(await c.query({ hash: "H#a", range: { beginsWith: "a_" } }))).toEqual(["a_1"]);
    expect(skOf(await c.query({ hash: "H#a", range: { beginsWith: "%" } }))).toEqual(["%#1"]);
    expect(skOf(await c.query({ hash: "H#a", range: { between: ["A#1", "B#1"] } }))).toEqual(["A#1", "B#1"]);
    expect(await c.query({ hash: "H#a", range: { between: ["z", "a"] } })).toEqual([]);
  });

  it("the index holds only rows that carry GSI1 attributes, and a rewrite without them drops the row out", async () => {
    const c = createD1ItemClient(createSqliteD1());
    const gsi = { GSI1PK: "OPEN#a", GSI1SK: "1#2026-01-01#1" };
    await c.put(item("H#a", "ALERT#1", gsi));
    await c.put(item("H#a", "ALERT#2"));
    expect(skOf(await c.query({ index: "GSI1", hash: "OPEN#a" }))).toEqual(["ALERT#1"]);
    await c.put(item("H#a", "ALERT#1"));
    expect(await c.query({ index: "GSI1", hash: "OPEN#a" })).toEqual([]);
  });

  it("never builds SQL from a value: a key full of quotes and SQL is stored and found as plain text", async () => {
    const db = createSqliteD1();
    const c = createD1ItemClient(db);
    const evil = "x'; DROP TABLE items; --";
    await c.put(item("H#a", evil));
    expect((await c.get("H#a", evil))?.SK).toBe(evil);
    expect(skOf(await c.query({ hash: "H#a", range: { beginsWith: "x'; DROP" } }))).toEqual([evil]);
    expect(db.ran.every((sql) => !sql.includes("DROP"))).toBe(true);
    expect(db.count()).toBe(1);
  });
});
