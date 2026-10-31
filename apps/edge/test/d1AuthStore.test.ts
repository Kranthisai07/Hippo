import { describe, expect, it } from "vitest";
import {
  cookieHeader,
  cookiesOf,
  form,
  fullTokens,
  makeEnv,
  refreshGrant,
  tokenReq,
} from "../../../packages/auth/test/helpers";
import { runAuthStoreSuite } from "../../../packages/auth/test/store.suite";
import { createSqliteD1 } from "../../../packages/core/test/d1.sqlite";
import { createD1AuthStore } from "../src/d1AuthStore";

// The whole AuthStore contract, twice: with a batch as a transaction (what D1 documents), and in the worst case, where
// every statement of every caller interleaves and a batch is not a transaction.
runAuthStoreSuite("D1 on node:sqlite, batch as a transaction", () => createD1AuthStore(createSqliteD1()));
runAuthStoreSuite("D1 on node:sqlite, statements interleaved", () =>
  createD1AuthStore(createSqliteD1({ interleave: true })),
);

const json = { "content-type": "application/json" };

describe("createAuth on the D1 store", () => {
  for (const interleave of [false, true]) {
    it(`runs the whole sign in flow: tokens, rotation, reuse, revoke, sign out everywhere (interleave: ${interleave})`, async () => {
      const db = createSqliteD1({ interleave });
      const env = makeEnv({ store: createD1AuthStore(db) });

      // Authorize with the demo button, exchange the code, rotate the refresh token.
      const { body } = await fullTokens(env);
      expect(body.access_token).toBeTruthy();
      const rotated = (await (await tokenReq(env, refreshGrant(body.refresh_token!))).json()) as Record<string, string>;
      expect(rotated.refresh_token).toBeTruthy();

      // Showing the first refresh token again is reuse: it fails and kills the family, including the rotated token.
      expect((await tokenReq(env, refreshGrant(body.refresh_token!))).status).toBe(400);
      expect((await tokenReq(env, refreshGrant(rotated.refresh_token!))).status).toBe(400);

      // A new sign in, then revoke by token.
      const second = (await fullTokens(env)).body;
      const revoke = await env.req("/oauth/revoke", form({ token: second.refresh_token!, client_id: "alexa" }));
      expect(revoke.status).toBe(200);
      expect((await tokenReq(env, refreshGrant(second.refresh_token!))).status).toBe(400);

      // A third sign in and a web session, ended together by logout-all.
      const third = (await fullTokens(env)).body;
      const session = await env.req("/oauth/session", {
        method: "POST",
        headers: json,
        body: JSON.stringify({ demo: true }),
      });
      const cookie = cookieHeader(cookiesOf(session));
      expect((await env.req("/oauth/session", { headers: { cookie } })).status).toBe(200);
      expect(
        (await env.req("/oauth/logout-all", { method: "POST", headers: { ...json, cookie }, body: "{}" })).status,
      ).toBe(200);
      expect((await env.req("/oauth/session", { headers: { cookie } })).status).toBe(401);
      expect((await tokenReq(env, refreshGrant(third.refresh_token!))).status).toBe(400);
    });
  }

  it("keeps no secret in the database: keys are hashes, and the log holds no key, code or token", async () => {
    const db = createSqliteD1();
    const env = makeEnv({ store: createD1AuthStore(db), logMagicCodes: false });
    const { body, code } = await fullTokens(env);
    const dump = db.ran.join("\n");
    for (const secret of [body.access_token!, body.refresh_token!, code]) {
      expect(dump).not.toContain(secret);
      expect(env.logs.join("\n")).not.toContain(secret);
    }
  });
});

describe("purgeExpired", () => {
  it("removes expired records and old tombstones, and keeps live ones", async () => {
    const db = createSqliteD1();
    const store = createD1AuthStore(db, { now: () => 1000 });
    const rec = { clientId: "c", resource: "r", scope: "s", sub: "u", householdId: "h", familyId: "f" };
    await store.putRefresh("old", { ...rec, expiresAt: 500 });
    await store.putRefresh("live", { ...rec, expiresAt: 9e9 });
    await store.putSession("sold", { email: "a@x.example", sub: "u", householdId: "h", expiresAt: 500 });
    await store.revokeFamily("f");
    await store.purgeExpired(2000, 10_000);
    expect(db.count("auth_refresh")).toBe(1);
    expect(db.count("auth_sessions")).toBe(0);
    expect(db.count("auth_revoked_families")).toBe(1);
    await store.purgeExpired(20_000, 10_000);
    expect(db.count("auth_revoked_families")).toBe(0);
  });
});
