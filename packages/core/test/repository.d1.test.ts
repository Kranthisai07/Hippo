import { BatchWriteCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { createD1DocumentClient } from "../src/repository/d1";
import { createDynamoRepository } from "../src/repository/dynamo";
import { createSqliteD1 } from "./d1.sqlite";
import { runRepositorySuite } from "./repository.suite";

// The whole shared suite, on the D1 adapter over SQLite. A page size of 7 matches the DynamoDB fake, so every list in
// the suite crosses a page boundary.
runRepositorySuite("D1 adapter on node:sqlite (not Cloudflare D1)", () =>
  createDynamoRepository({ client: createD1DocumentClient(createSqliteD1(), { pageSize: 7 }), tableName: "t" }),
);

const T = "t";
const item = (pk: string, sk: string, extra: Record<string, unknown> = {}) => ({
  PK: pk,
  SK: sk,
  data: { sk },
  ...extra,
});
const queryPrefix = (
  client: ReturnType<typeof createD1DocumentClient>,
  p: string,
  start?: Record<string, unknown>,
  forward = true,
) =>
  client.send(
    new QueryCommand({
      TableName: T,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :p)",
      ExpressionAttributeValues: { ":pk": "H#a", ":p": p },
      ScanIndexForward: forward,
      ExclusiveStartKey: start,
    }),
  );
const delIfPresent = (client: ReturnType<typeof createD1DocumentClient>) =>
  client.send(
    new DeleteCommand({ TableName: T, Key: { PK: "H#a", SK: "U#1" }, ConditionExpression: "attribute_exists(PK)" }),
  );

describe("the D1 adapter's own behaviour", () => {
  it("get returns what put stored, and nothing for a missing key or another partition", async () => {
    const client = createD1DocumentClient(createSqliteD1());
    await client.send(new PutCommand({ TableName: T, Item: item("H#a", "DOC#1") }));
    const got = (pk: string, sk: string) => client.send(new GetCommand({ TableName: T, Key: { PK: pk, SK: sk } }));
    expect((await got("H#a", "DOC#1")).Item).toEqual(item("H#a", "DOC#1"));
    expect((await got("H#a", "DOC#2")).Item).toBeUndefined();
    expect((await got("H#b", "DOC#1")).Item).toBeUndefined();
  });

  it("a conditional delete fails with the DynamoDB error name on a missing row, and succeeds once on a present one", async () => {
    const client = createD1DocumentClient(createSqliteD1());
    await expect(delIfPresent(client)).rejects.toMatchObject({ name: "ConditionalCheckFailedException" });
    await client.send(new PutCommand({ TableName: T, Item: item("H#a", "U#1") }));
    await delIfPresent(client);
    await expect(delIfPresent(client)).rejects.toMatchObject({ name: "ConditionalCheckFailedException" });
  });

  it("three racing conditional deletes: exactly one wins", async () => {
    const client = createD1DocumentClient(createSqliteD1());
    await client.send(new PutCommand({ TableName: T, Item: item("H#a", "U#1") }));
    const results = await Promise.allSettled([delIfPresent(client), delIfPresent(client), delIfPresent(client)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("a batch is all or nothing", async () => {
    const db = createSqliteD1();
    const client = createD1DocumentClient(db);
    const bad = { PutRequest: { Item: { PK: "H#a", SK: "X#2", data: 1n } } };
    await expect(
      client.send(
        new BatchWriteCommand({ RequestItems: { [T]: [{ PutRequest: { Item: item("H#a", "X#1") } }, bad as never] } }),
      ),
    ).rejects.toThrow();
    expect(db.count()).toBe(0);
  });

  it("refuses more than 25 requests in a batch and a command it does not know", async () => {
    const client = createD1DocumentClient(createSqliteD1());
    const many = Array.from({ length: 26 }, (_, i) => ({ PutRequest: { Item: item("H#a", `X#${i}`) } }));
    await expect(client.send(new BatchWriteCommand({ RequestItems: { [T]: many } }))).rejects.toThrow(/25/);
    await expect(client.send({ input: {} } as never)).rejects.toThrow(/unsupported/);
  });

  it("pages a query across several pages in key order, in both directions", async () => {
    const client = createD1DocumentClient(createSqliteD1(), { pageSize: 3 });
    for (let i = 0; i < 8; i++) await client.send(new PutCommand({ TableName: T, Item: item("H#a", `U#${i}`) }));
    const all = async (forward: boolean) => {
      const keys: string[] = [];
      let start: Record<string, unknown> | undefined;
      let pages = 0;
      do {
        const out = await queryPrefix(client, "U#", start, forward);
        keys.push(...(out.Items ?? []).map((i) => i.SK as string));
        start = out.LastEvaluatedKey;
        pages++;
      } while (start);
      return { keys, pages };
    };
    expect(await all(true)).toEqual({ keys: ["U#0", "U#1", "U#2", "U#3", "U#4", "U#5", "U#6", "U#7"], pages: 3 });
    expect((await all(false)).keys).toEqual(["U#7", "U#6", "U#5", "U#4", "U#3", "U#2", "U#1", "U#0"]);
  });

  it("orders keys as raw bytes (upper case before lower case), and begins_with is exact, not a pattern", async () => {
    const client = createD1DocumentClient(createSqliteD1());
    for (const sk of ["a#1", "B#1", "A#1", "%#1", "a_1", "ab1"]) {
      await client.send(new PutCommand({ TableName: T, Item: item("H#a", sk) }));
    }
    const skOf = async (p: string) => ((await queryPrefix(client, p)).Items ?? []).map((i) => i.SK);
    expect(await skOf("")).toEqual(["%#1", "A#1", "B#1", "a#1", "a_1", "ab1"]);
    expect(await skOf("a_")).toEqual(["a_1"]);
    expect(await skOf("%")).toEqual(["%#1"]);
  });

  it("the index holds only rows that carry GSI1 attributes, and a rewrite without them drops the row out", async () => {
    const client = createD1DocumentClient(createSqliteD1());
    const open = async () =>
      (
        await client.send(
          new QueryCommand({
            TableName: T,
            IndexName: "GSI1",
            KeyConditionExpression: "GSI1PK = :g",
            ExpressionAttributeValues: { ":g": "OPEN#a" },
          }),
        )
      ).Items;
    const gsi = { GSI1PK: "OPEN#a", GSI1SK: "1#2026-01-01#1" };
    await client.send(new PutCommand({ TableName: T, Item: item("H#a", "ALERT#1", gsi) }));
    await client.send(new PutCommand({ TableName: T, Item: item("H#a", "ALERT#2") }));
    expect((await open())?.map((i) => i.SK)).toEqual(["ALERT#1"]);
    await client.send(new PutCommand({ TableName: T, Item: item("H#a", "ALERT#1") }));
    expect(await open()).toEqual([]);
  });

  it("never builds SQL from a value: a key full of quotes and SQL is stored and found as plain text", async () => {
    const db = createSqliteD1();
    const client = createD1DocumentClient(db);
    const evil = "x'; DROP TABLE items; --";
    await client.send(new PutCommand({ TableName: T, Item: item("H#a", evil) }));
    expect((await client.send(new GetCommand({ TableName: T, Key: { PK: "H#a", SK: evil } }))).Item?.SK).toBe(evil);
    expect(db.ran.every((sql) => !sql.includes("DROP"))).toBe(true);
    expect(db.count()).toBe(1);
  });
});
