import { describe, expect, it } from "vitest";
import { createAuthApp, verifyBearer, verifyRequest, verifyServiceBearer, verifySession } from "../src";
import {
  ISSUER,
  KEY,
  REDIRECT,
  RESOURCE,
  authzParams,
  bearer,
  codeGrant,
  cookieHeader,
  cookiesOf,
  form,
  lastMagic,
  makeEnv,
  openAuthorize,
  pkce,
  postAuthorize,
  refreshGrant,
  tokenReq,
} from "./helpers";

describe("full flow", () => {
  it("discovery, authorize, magic code login, code exchange, verify, refresh, reuse detection", async () => {
    const env = makeEnv();

    const prm = (await (await env.req("/.well-known/oauth-protected-resource")).json()) as Record<string, unknown>;
    expect(prm.resource).toBe(RESOURCE);
    const as = (await (await env.req("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
    expect(as.issuer).toBe((prm.authorization_servers as string[])[0]);

    const { verifier, challenge } = await pkce();
    const p = authzParams(challenge);
    const page = await openAuthorize(env, p);
    expect(page.res.status).toBe(200);
    expect(page.csrf.length).toBeGreaterThan(20);

    const send = await postAuthorize(env, page, p, { action: "send", email: "Kim@Example.com" });
    expect(send.status).toBe(200);
    const magic = lastMagic(env);
    expect(env.logs[0]).toContain("kim@example.com");

    const login = await postAuthorize(env, page, p, { action: "login", email: "kim@example.com", code: magic });
    expect(login.status).toBe(302);
    const loc = new URL(login.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get("state")).toBe("st-123");
    const code = loc.searchParams.get("code")!;

    const tok = await tokenReq(env, codeGrant(code, verifier));
    expect(tok.status).toBe(200);
    expect(tok.headers.get("cache-control")).toBe("no-store");
    const body = (await tok.json()) as Record<string, string | number>;
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(900);
    expect(body.refresh_token).toBeTruthy();

    const who = await env.auth.verifyBearer(bearer(body.access_token as string));
    expect(who).toEqual({ householdId: "hh_kim", scope: "mcp:tools" });

    const r1 = await tokenReq(env, refreshGrant(body.refresh_token as string));
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as Record<string, string>;
    expect(b1.refresh_token).not.toBe(body.refresh_token);
    expect(await env.auth.verifyBearer(bearer(b1.access_token!))).toEqual({
      householdId: "hh_kim",
      scope: "mcp:tools",
    });

    // old refresh token is dead, and presenting it revokes the family
    const replay = await tokenReq(env, refreshGrant(body.refresh_token as string));
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: string }).error).toBe("invalid_grant");
    const newer = await tokenReq(env, refreshGrant(b1.refresh_token!));
    expect(newer.status).toBe(400);
  });

  it("module level verifyBearer works after createAuthApp", async () => {
    const logs: string[] = [];
    const app = createAuthApp({
      issuer: ISSUER,
      resource: RESOURCE,
      signingKey: KEY,
      clients: [{ clientId: "alexa", redirectUris: [REDIRECT] }],
      resolveHousehold: () => "hh_mod",
      log: (l) => logs.push(l),
      demoUser: { email: "demo@hippo.test", code: "111111" },
    });
    const { verifier, challenge } = await pkce();
    const p = authzParams(challenge) as Record<string, string>;
    const g = await app.request(`${ISSUER}/oauth/authorize?${new URLSearchParams(p)}`);
    const html = await g.text();
    const csrf = /name="csrf" value="([^"]*)"/.exec(html)![1]!;
    const post = await app.request(`${ISSUER}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieHeader(cookiesOf(g)) },
      body: new URLSearchParams({ ...p, csrf, action: "demo" }).toString(),
    });
    const code = new URL(post.headers.get("location")!).searchParams.get("code")!;
    const t = await app.request(`${ISSUER}/oauth/token`, form(codeGrant(code, verifier)));
    const access = ((await t.json()) as { access_token: string }).access_token;
    expect(await verifyBearer(bearer(access))).toEqual({ householdId: "hh_mod", scope: "mcp:tools" });
    expect(await verifyBearer(undefined)).toBeNull();
    expect(await verifyServiceBearer(bearer(access))).toBe(false);
    const viaReq = await verifyRequest(new Request("https://x/mcp", { headers: { authorization: bearer(access) } }));
    expect(viaReq?.householdId).toBe("hh_mod");
    expect(await verifySession(undefined)).toBeNull();
  });

  it("the demo user button logs in without a code", async () => {
    const env = makeEnv();
    const { challenge } = await pkce();
    const p = authzParams(challenge);
    const page = await openAuthorize(env, p);
    expect(page.html).toContain("demo household");
    const res = await postAuthorize(env, page, p, { action: "demo" });
    expect(res.status).toBe(302);
  });

  it("without demoUser the page has no demo button and the demo action is refused", async () => {
    const env = makeEnv({ demoUser: undefined });
    const { challenge } = await pkce();
    const p = authzParams(challenge);
    const page = await openAuthorize(env, p);
    expect(page.html).not.toContain("demo household");
    const res = await postAuthorize(env, page, p, { action: "demo" });
    expect(res.status).toBe(401);
  });

  it("the fixed demo code works through the normal login form and logs nothing", async () => {
    const env = makeEnv();
    const { challenge } = await pkce();
    const p = authzParams(challenge);
    const page = await openAuthorize(env, p);
    const res = await postAuthorize(env, page, p, { action: "login", email: "demo@hippo.test", code: "424242" });
    expect(res.status).toBe(302);
    expect(env.logs).toHaveLength(0);
  });

  it("works without state and then does not echo one", async () => {
    const env = makeEnv();
    const { challenge } = await pkce();
    const p = authzParams(challenge, { state: undefined });
    const page = await openAuthorize(env, p);
    const res = await postAuthorize(env, page, p, { action: "demo" });
    const u = new URL(res.headers.get("location")!);
    expect(u.searchParams.has("state")).toBe(false);
    expect(u.searchParams.get("code")).toBeTruthy();
  });

  it("state with special characters is echoed back intact and never injected into the page", async () => {
    const env = makeEnv();
    const { challenge } = await pkce();
    const state = "a b&c=d/é\"'<script>";
    const p = authzParams(challenge, { state });
    const page = await openAuthorize(env, p);
    expect(page.html).not.toContain("<script>");
    const res = await postAuthorize(env, page, p, { action: "demo" });
    expect(new URL(res.headers.get("location")!).searchParams.get("state")).toBe(state);
  });

  it("an existing web session can be continued on the authorize page", async () => {
    const env = makeEnv();
    const s = await env.req("/oauth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ demo: true }),
    });
    const sess = cookiesOf(s);
    const { challenge } = await pkce();
    const p = authzParams(challenge);
    const res = await env.req("/oauth/authorize?" + new URLSearchParams(p as Record<string, string>), {
      headers: { cookie: cookieHeader(sess) },
    });
    const html = await res.text();
    expect(html).toContain("Signed in as demo@hippo.test");
    const csrf = /name="csrf" value="([^"]*)"/.exec(html)![1]!;
    const page = { csrf, cookies: { ...sess, ...cookiesOf(res) }, html, res };
    const go = await postAuthorize(env, page, p, { action: "continue" });
    expect(go.status).toBe(302);
  });

  it("continue without a session is refused", async () => {
    const env = makeEnv();
    const { challenge } = await pkce();
    const p = authzParams(challenge);
    const page = await openAuthorize(env, p);
    const res = await postAuthorize(env, page, p, { action: "continue" });
    expect(res.status).toBe(401);
  });
});
