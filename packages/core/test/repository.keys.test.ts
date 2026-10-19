import { describe, expect, it } from "vitest";
import type { Alert } from "../src";
import { GSI1, TTL_ATTRIBUTE, alertGsi, enc, obligationRange, pk, sk } from "../src/repository/keys";
import { TABLE_DEFINITION, TTL_SPECIFICATION, createDynamoRepository, stripUndefined } from "../src/repository/dynamo";
import { createFakeDynamo } from "./dynamo.fake";

const alert = (over: Partial<Alert> = {}): Alert => ({
  id: "al1",
  source: "deadline",
  severity: "high",
  status: "pending",
  label: "x",
  dueDate: "2026-11-01",
  refId: "o1",
  ...over,
});

describe("key building", () => {
  it.each([
    ["plain", "plain"],
    ["a#b", "a%23b"],
    ["HH#x", "HH%23x"],
    ["100%", "100%25"],
    ["%23", "%2523"],
    ["#%#", "%23%25%23"],
    ["", ""],
  ])("enc(%j) is %j", (raw, want) => {
    expect(enc(raw)).toBe(want);
  });

  it.each(["a#b", "HH#x", "%", "%23", "#", "a%23#b", "x#y#z"])("enc(%j) never contains # and is injective", (raw) => {
    expect(enc(raw)).not.toContain("#");
    expect(enc(raw)).not.toBe(enc(`${raw}x`));
  });

  it("builds the SPEC section 3 sort keys", () => {
    expect(pk("h1")).toBe("HH#h1");
    expect(sk.asset("a1")).toBe("ASSET#a1");
    expect(sk.doc("d1")).toBe("DOC#d1");
    expect(sk.agreement("g1")).toBe("AGREEMENT#g1");
    expect(sk.obligation("2026-11-01", "o1")).toBe("OBLIGATION#2026-11-01#o1");
    expect(sk.event("a1", "2026-01-01T00:00:00.000Z", "e1")).toBe("EVENT#a1#2026-01-01T00:00:00.000Z#e1");
    expect(sk.alert("al1")).toBe("ALERT#al1");
    expect(sk.suppress("cpsc", "R1", "a1")).toBe("SUPPRESS#cpsc#R1#a1");
    expect(sk.chunkMeta("d1")).toBe("CHUNKMETA#d1");
    expect(sk.undo("2026-10-18T10:00:00.000Z")).toBe("UNDO#2026-10-18T10:00:00.000Z");
  });

  it("a household id with HH# cannot look like another household's key", () => {
    expect(pk("HH#other")).toBe("HH#HH%23other");
    expect(pk("a#b")).not.toBe(pk("a"));
  });

  it("two suppressions that differ only by where # falls get different keys", () => {
    expect(sk.suppress("cpsc", "a#b", "c")).not.toBe(sk.suppress("cpsc", "a", "b#c"));
  });

  it("an asset id never produces a prefix of another asset's event keys", () => {
    expect(sk.event("a#b", "t", "e").startsWith(sk.eventPrefix("a"))).toBe(false);
    expect(sk.event("a", "t", "e").startsWith(sk.eventPrefix("a"))).toBe(true);
  });

  it("obligation range bounds bracket exactly the keys of the days asked for", () => {
    const { lo, hi } = obligationRange("2026-06-10", "2026-06-30");
    const inside = [
      sk.obligation("2026-06-10", ""),
      sk.obligation("2026-06-10", "a"),
      sk.obligation("2026-06-30", "zzz￿"),
    ];
    const outside = [sk.obligation("2026-06-09", "zzz"), sk.obligation("2026-07-01", "")];
    for (const k of inside) expect(k >= lo && k <= hi).toBe(true);
    for (const k of outside) expect(k >= lo && k <= hi).toBe(false);
  });
});

describe("GSI1 keys", () => {
  it("indexes only open alerts", () => {
    expect(alertGsi("h", alert({ status: "pending" }))).not.toBeNull();
    expect(alertGsi("h", alert({ status: "announced" }))).not.toBeNull();
    expect(alertGsi("h", alert({ status: "done" }))).toBeNull();
    expect(alertGsi("h", alert({ status: "dismissed" }))).toBeNull();
  });
  it("sorts high before possible, then by due date, with no date last", () => {
    const k = (a: Alert) => alertGsi("h", a)!.GSI1SK;
    const order = [
      k(alert({ id: "a", severity: "high", dueDate: "2026-01-01" })),
      k(alert({ id: "a", severity: "high", dueDate: "2026-02-01" })),
      k(alert({ id: "a", severity: "high", dueDate: null })),
      k(alert({ id: "a", severity: "possible", dueDate: "2025-01-01" })),
    ];
    expect([...order].sort()).toEqual(order);
  });
  it("scopes the partition to the household", () => {
    expect(alertGsi("h1", alert())!.GSI1PK).not.toBe(alertGsi("h2", alert())!.GSI1PK);
    expect(alertGsi("a", alert())!.GSI1PK).not.toBe(alertGsi("a#b", alert())!.GSI1PK);
  });
});

describe("table definition", () => {
  it("declares the keys and GSI1 that the code uses", () => {
    expect(TABLE_DEFINITION.KeySchema).toEqual([
      { AttributeName: "PK", KeyType: "HASH" },
      { AttributeName: "SK", KeyType: "RANGE" },
    ]);
    expect(TABLE_DEFINITION.GlobalSecondaryIndexes?.[0]?.IndexName).toBe(GSI1);
    expect(TABLE_DEFINITION.AttributeDefinitions?.map((a) => a.AttributeName).sort()).toEqual([
      "GSI1PK",
      "GSI1SK",
      "PK",
      "SK",
    ]);
  });
  it("turns TTL on for the attribute undo records use", () => {
    expect(TTL_SPECIFICATION).toEqual({ Enabled: true, AttributeName: TTL_ATTRIBUTE });
  });
});

describe("item mapping (on the in-process fake)", () => {
  const setup = () => {
    const fake = createFakeDynamo();
    return { fake, repo: createDynamoRepository({ client: fake.client, tableName: "t" }) };
  };

  it("stores the undo expiry as a numeric ttl attribute", async () => {
    const { fake, repo } = setup();
    await repo.pushUndo("h", {
      ts: "2026-10-18T10:00:00.000Z",
      summary: "s",
      inverse: { type: "delete_asset", assetId: "a" },
      expiresAt: 1_800_086_400,
    });
    const row = [...fake.rows.values()][0]!;
    expect(row.SK).toBe("UNDO#2026-10-18T10:00:00.000Z");
    expect(row.ttl).toBe(1_800_086_400);
    expect(typeof row.ttl).toBe("number");
  });

  it("builds every key from the first argument, never from the record body", async () => {
    const { fake, repo } = setup();
    await repo.putHousehold("real", { id: "forged", digestOn: true, createdAt: "t" });
    await repo.putAsset("real", {
      id: "a",
      name: "n",
      createdAt: "t",
      householdId: "forged",
      PK: "HH#forged",
    } as never);
    const pks = new Set([...fake.rows.values()].map((r) => r.PK));
    expect([...pks]).toEqual(["HH#real"]);
    expect(await repo.getHousehold("forged")).toBeNull();
  });

  it("keeps a body that carries key-like fields from overwriting key attributes", async () => {
    const { fake, repo } = setup();
    await repo.putAsset("h", { id: "a", name: "n", createdAt: "t", SK: "DOC#x", GSI1PK: "evil" } as never);
    const row = [...fake.rows.values()][0]!;
    expect(row.SK).toBe("ASSET#a");
    expect(row.GSI1PK).toBeUndefined();
  });

  it("sets GSI1 attributes only on open alerts and on obligations", async () => {
    const { fake, repo } = setup();
    await repo.putAlert("h", alert({ id: "open" }));
    await repo.putAlert("h", alert({ id: "closed", status: "done" }));
    await repo.replaceObligations("h", null, [
      { id: "o", type: "expires", dueDate: "2026-01-01", label: "l", confirmed: true, severity: null },
    ]);
    const bySk = new Map([...fake.rows.values()].map((r) => [r.SK, r]));
    expect(bySk.get("ALERT#open")?.GSI1PK).toBe("HH#h#ALERT_OPEN");
    expect(bySk.get("ALERT#closed")?.GSI1PK).toBeUndefined();
    expect(bySk.get("OBLIGATION#2026-01-01#o")?.GSI1PK).toBe("HH#h#OBLIGATION");
  });

  it("never sends undefined to the table", () => {
    expect(
      stripUndefined({ a: 1, b: undefined, c: { d: undefined, e: [1, undefined, { f: undefined }] }, g: null }),
    ).toEqual({
      a: 1,
      c: { e: [1, undefined, {}] },
      g: null,
    });
  });

  it("an expired undo record is not deleted by popUndo", async () => {
    const { fake, repo } = setup();
    await repo.pushUndo("h", { ts: "t", summary: "s", inverse: { type: "delete_asset", assetId: "a" }, expiresAt: 10 });
    expect(await repo.popUndo("h", 10)).toBeNull();
    expect(fake.rows.size).toBe(1);
  });
});
