import { describe, expect, it } from "vitest";
import { createMemoryStore, type AuditEvent } from "../src";
import { cookiesOf, cookieHeader, form, fullTokens, makeEnv, refreshGrant, tokenReq } from "./helpers";

const revoke = (env: ReturnType<typeof makeEnv>, p: Record<string, string>) => env.req("/oauth/revoke", form(p));
const json = { "content-type": "application/json" };

async function demoSession(env: ReturnType<typeof makeEnv>): Promise<string> {
  const r = await env.req("/oauth/session", { method: "POST", headers: json, body: JSON.stringify({ demo: true }) });
  expect(r.status).toBe(200);
  return cookieHeader(cookiesOf(r));
}

describe("POST /oauth/revoke", () => {
  it("ends the refresh token, and the token a rotation handed out from it", async () => {
    const env = makeEnv();
    const { body } = await fullTokens(env);
    const rotated = (await (await tokenReq(env, refreshGrant(body.refresh_token!))).json()) as Record<string, string>;
    const r = await revoke(env, { token: body.refresh_token!, client_id: "alexa" });
    expect(r.status).toBe(200);
    expect((await tokenReq(env, refreshGrant(rotated.refresh_token!))).status).toBe(400);
  });
  it("is the same 200 for a token that never existed", async () => {
    const env = makeEnv();
    expect((await revoke(env, { token: "nope", client_id: "alexa" })).status).toBe(200);
  });
  it("does nothing when another client names the token", async () => {
    const env = makeEnv();
    const { body } = await fullTokens(env);
    expect((await revoke(env, { token: body.refresh_token!, client_id: "someone-else" })).status).toBe(200);
    // consumeRefresh used the token up, but the family was not revoked: its descendants still exist. Reuse is refused.
    expect((await tokenReq(env, refreshGrant(body.refresh_token!))).status).toBe(400);
  });
  it("is advertised in the metadata, and refuses a JSON body", async () => {
    const env = makeEnv();
    const meta = (await (await env.req("/.well-known/oauth-authorization-server")).json()) as Record<string, string>;
    expect(meta.revocation_endpoint).toMatch(/\/oauth\/revoke$/);
    const r = await env.req("/oauth/revoke", { method: "POST", headers: json, body: "{}" });
    expect(r.status).toBe(400);
  });
});

describe("POST /oauth/logout-all", () => {
  it("ends the web session and every refresh token of the person", async () => {
    const env = makeEnv();
    const cookie = await demoSession(env);
    const { body } = await fullTokens(env);
    const r = await env.req("/oauth/logout-all", { method: "POST", headers: { ...json, cookie }, body: "{}" });
    expect(r.status).toBe(200);
    expect((await env.req("/oauth/session", { headers: { cookie } })).status).toBe(401);
    expect((await tokenReq(env, refreshGrant(body.refresh_token!))).status).toBe(400);
  });
  it("needs a session", async () => {
    const env = makeEnv();
    const r = await env.req("/oauth/logout-all", { method: "POST", headers: json, body: "{}" });
    expect(r.status).toBe(401);
  });
});

describe("revokeUser", () => {
  it("touches only that user", async () => {
    const store = createMemoryStore();
    const rec = { clientId: "c", resource: "r", scope: "s", householdId: "h", expiresAt: 9e15 };
    await store.putRefresh("a", { ...rec, sub: "u1", familyId: "f1" });
    await store.putRefresh("b", { ...rec, sub: "u2", familyId: "f2" });
    await store.putSession("sa", { email: "a@x.example", sub: "u1", householdId: "h", expiresAt: 9e15 });
    await store.revokeUser("u1");
    expect((await store.consumeRefresh("a")).status).toBe("used");
    expect((await store.consumeRefresh("b")).status).toBe("ok");
    expect(await store.getSession("sa")).toBeUndefined();
  });
});

describe("audit events", () => {
  it("record what happened by hashed id, and never an email, a code or a token", async () => {
    const events: AuditEvent[] = [];
    const env = makeEnv({ audit: (e) => events.push(e), logMagicCodes: false });
    const send = () =>
      env.req("/oauth/magic-code", {
        method: "POST",
        headers: json,
        body: JSON.stringify({ email: "alice@example.com" }),
      });
    await send();
    await send(); // inside the 60 second gap
    const wrong = await env.req("/oauth/session", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email: "alice@example.com", code: "000000" }),
    });
    expect(wrong.status).toBe(401);
    const cookie = await demoSession(env);
    const { body } = await fullTokens(env);
    await tokenReq(env, refreshGrant(body.refresh_token!));
    await tokenReq(env, refreshGrant(body.refresh_token!)); // reuse
    await env.req("/oauth/logout", { method: "POST", headers: { ...json, cookie }, body: "{}" });
    expect(events.map((e) => e.event)).toEqual(
      expect.arrayContaining(["code_sent", "code_throttled", "login_failed", "login_ok", "refresh_reuse", "logout"]),
    );
    const all = JSON.stringify(events) + env.logs.join("\n");
    expect(all).not.toContain("alice@example.com");
    expect(all).not.toContain(body.refresh_token!);
    expect(all).not.toContain(body.access_token!);
    expect(events.every((e) => e.sub === undefined || /^u_[\w-]{22}$/.test(e.sub))).toBe(true);
  });
});
