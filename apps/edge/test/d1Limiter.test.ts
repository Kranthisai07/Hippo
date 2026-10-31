import { describe, expect, it } from "vitest";
import { limiterFromStore } from "../../api/src/api/limiter";
import { EXT_PER_MINUTE, OAUTH_PER_MINUTE } from "../../api/src/app";
import { runLimiterSuite } from "../../api/test/limiter.suite";
import { BASE } from "../../api/test/helpers";
import { makeWeb } from "../../api/test/webHelpers";
import { createSqliteD1 } from "../../../packages/core/test/d1.sqlite";
import { createD1AuthStore } from "../src/d1AuthStore";

// The limiter table on D1, as documented and in the worst case (statements of different callers interleaved).
runLimiterSuite("D1 on node:sqlite", (now) => limiterFromStore(createD1AuthStore(createSqliteD1()), now));
runLimiterSuite("D1 on node:sqlite, interleaved", (now) =>
  limiterFromStore(createD1AuthStore(createSqliteD1({ interleave: true })), now),
);

describe("round trips", () => {
  it("a rate check is one trip to the database, and a consume is one", async () => {
    const db = createSqliteD1();
    const store = createD1AuthStore(db);
    await store.tryHit("k", 60_000, 5, 0, 1_000);
    expect(db.trips).toBe(1);
    await store.putCode("c", {
      clientId: "c",
      redirectUri: "u",
      codeChallenge: "x",
      resource: "r",
      scope: "s",
      sub: "u1",
      householdId: "h",
      familyId: "f",
      expiresAt: 9e9,
    });
    const before = db.trips;
    await store.consumeCode("c");
    expect(db.trips - before).toBe(1);
  });
});

describe("purgeExpired and rate hits", () => {
  it("removes hits older than the longest window and keeps recent ones", async () => {
    const db = createSqliteD1();
    const store = createD1AuthStore(db);
    await store.tryHit("old", 60_000, 5, 0, 1_000);
    await store.tryHit("new", 60_000, 5, 0, 3_000_000);
    await store.purgeExpired(3_601_500, 1_000_000_000);
    expect(db.count("auth_hits")).toBe(1);
  });
});

describe("the app with a D1 backed limiter", () => {
  const address = (a: string) => ({ incoming: { socket: { remoteAddress: a } } });

  it(`/ext answers 429 after ${EXT_PER_MINUTE} calls a minute from one address, and only that address`, async () => {
    const db = createSqliteD1();
    const w = await makeWeb({ app: { limiter: limiterFromStore(createD1AuthStore(db), () => Date.now()) } });
    for (let i = 0; i < EXT_PER_MINUTE; i++) {
      expect((await w.app.request(`${BASE}/ext/subscriptions`, {}, address("192.0.2.1"))).status).toBe(401);
    }
    const blocked = await w.app.request(`${BASE}/ext/subscriptions`, {}, address("192.0.2.1"));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await w.app.request(`${BASE}/ext/subscriptions`, {}, address("192.0.2.2"))).status).toBe(401);
  }, 60_000);

  it(`/oauth answers 429 in the OAuth shape after ${OAUTH_PER_MINUTE} calls a minute`, async () => {
    const w = await makeWeb({
      app: { limiter: limiterFromStore(createD1AuthStore(createSqliteD1()), () => Date.now()) },
    });
    const hit = () => w.app.request(`${BASE}/oauth/token`, { method: "POST" }, address("192.0.2.9"));
    for (let i = 0; i < OAUTH_PER_MINUTE; i++) expect((await hit()).status).not.toBe(429);
    const blocked = await hit();
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: "rate_limited" });
  }, 60_000);
});
