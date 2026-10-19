import { describe, expect, it } from "vitest";
import { getServiceToken } from "../src/oauthFlow";
import { A, BASE, NOW, RESOURCE, callBody, connect, makeEnv, rpc } from "./helpers";

const init = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } },
};
const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };
const hero = callBody("check_coverage", { asset: "dishwasher", issue: "leaking" });

describe("auth on /mcp", () => {
  it("no token: bare 401, no WWW-Authenticate, for every method", async () => {
    const env = await makeEnv();
    for (const body of [init, list, hero]) {
      const res = await rpc(env, null, body);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBeNull();
    }
  });

  it("wrong tokens are 401 with no WWW-Authenticate", async () => {
    const env = await makeEnv();
    for (const t of ["garbage", "a.b.c", "x".repeat(300)]) {
      const res = await rpc(env, t, hero);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBeNull();
    }
    const res = await rpc(env, null, hero, { authorization: "Basic abc" });
    expect(res.status).toBe(401);
  });

  it("a token signed with another key is refused", async () => {
    const a = await makeEnv();
    const other = await makeEnv();
    const { createAuth } = await import("@hippo/auth");
    const foreign = createAuth({
      issuer: BASE,
      resource: RESOURCE,
      signingKey: "another-signing-key-another-signing-key-99",
      clients: [{ clientId: "hippo-demo", redirectUris: ["http://localhost:5173/callback"] }],
      resolveHousehold: () => A,
      log: () => {},
      demoUser: { email: "demo@hippo.test", code: "424242" },
      now: () => NOW,
    });
    const { getTokens } = await import("../src/oauthFlow");
    const t = await getTokens({
      base: BASE,
      clientId: "hippo-demo",
      redirectUri: "http://localhost:5173/callback",
      resource: RESOURCE,
      fetch: (u, i) => Promise.resolve(foreign.app.request(u, i)),
    });
    expect((await rpc(a, t.accessToken, hero)).status).toBe(401);
    expect(other).toBeTruthy();
  });

  it("an expired token is 401", async () => {
    const env = await makeEnv();
    const token = await env.tokenA();
    expect((await rpc(env, token, hero)).status).toBe(200);
    env.clock.t += 16 * 60 * 1000;
    const res = await rpc(env, token, hero);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  it("a token in the query string does not count", async () => {
    const env = await makeEnv();
    const token = await env.tokenA();
    const res = await env.fetch(`${RESOURCE}?access_token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(hero),
    });
    expect(res.status).toBe(401);
  });

  it("a service token (client_credentials) may initialize and list tools but never call one", async () => {
    const env = await makeEnv();
    const svc = await getServiceToken({
      base: BASE,
      clientId: "svc",
      clientSecret: "svc-secret-value",
      resource: RESOURCE,
      fetch: env.fetch,
    });
    expect((await rpc(env, svc, init)).status).toBe(200);
    const listed = await rpc(env, svc, list);
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as any).result.tools).toHaveLength(12);
    for (const name of ["whats_coming_up", "check_coverage", "undo_last"]) {
      const res = await rpc(
        env,
        svc,
        callBody(name, name === "check_coverage" ? { asset: "dishwasher", issue: "x" } : {}),
      );
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBeNull();
    }
    // a batch that hides a tools/call among allowed methods is refused as a whole
    expect((await rpc(env, svc, [list, hero])).status).toBe(401);
    expect((await rpc(env, svc, { jsonrpc: "2.0", id: 3, method: "prompts/list" })).status).toBe(401);
  });

  it("a user token with only mcp:resources scope cannot call tools", async () => {
    const env = await makeEnv();
    const { getTokens } = await import("../src/oauthFlow");
    const t = await getTokens({
      base: BASE,
      clientId: "hippo-demo",
      redirectUri: "http://localhost:5173/callback",
      resource: RESOURCE,
      scope: "mcp:resources",
      fetch: env.fetch,
    });
    expect((await rpc(env, t.accessToken, hero)).status).toBe(401);
    expect((await rpc(env, t.accessToken, list)).status).toBe(200);
  });

  it("GET and DELETE /mcp are 405 and there is no SSE stream", async () => {
    const env = await makeEnv();
    const token = await env.tokenA();
    for (const method of ["GET", "DELETE"]) {
      const res = await env.fetch(RESOURCE, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
      });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
      expect(res.headers.get("content-type")).not.toContain("event-stream");
    }
  });

  it("the OAuth app is mounted and discovery works", async () => {
    const env = await makeEnv();
    const prm = (await (await env.fetch(`${BASE}/.well-known/oauth-protected-resource`)).json()) as any;
    expect(prm.resource).toBe(RESOURCE);
    const meta = (await (await env.fetch(`${BASE}/.well-known/oauth-authorization-server`)).json()) as any;
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    expect((await env.fetch(`${BASE}/healthz`)).status).toBe(200);
  });
});

describe("household id comes only from the token", () => {
  it("rejects householdId in the tool arguments and does not act on it", async () => {
    const env = await makeEnv();
    const tokenB = await env.tokenB();
    const body = callBody("whats_coming_up", { window_days: 30, householdId: A });
    const res = await rpc(env, tokenB, body);
    const out = (await res.json()) as any;
    expect(out.result.isError).toBe(true);
    expect(JSON.stringify(out)).not.toContain("Kestrel");
    for (const key of ["household_id", "HouseholdId", "hh"]) {
      const r = (await (await rpc(env, tokenB, callBody("get_history", { asset: "car", [key]: A }))).json()) as any;
      expect(r.result.isError, key).toBe(true);
    }
  });

  it("ignores householdId placed in the JSON-RPC params envelope", async () => {
    const env = await makeEnv();
    const tokenB = await env.tokenB();
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "whats_coming_up", arguments: {}, householdId: A, _meta: { householdId: A } },
    };
    const out = (await (await rpc(env, tokenB, body)).json()) as any;
    expect(JSON.stringify(out)).not.toContain("Kestrel");
    expect(out.result.structuredContent.items.map((i: any) => i.label)).toEqual([
      "Orbit Streaming cancel-by date",
      "Orbit Streaming next charge",
    ]);
  });

  it("a householdId beside the JSON-RPC envelope is a 400", async () => {
    const env = await makeEnv();
    const res = await rpc(env, await env.tokenB(), { ...callBody("whats_coming_up", {}), householdId: A });
    expect(res.status).toBe(400);
  });

  it("ignores a householdId header or query", async () => {
    const env = await makeEnv();
    const tokenB = await env.tokenB();
    const res = await env.fetch(`${RESOURCE}?householdId=${A}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${tokenB}`,
        "x-household-id": A,
      },
      body: JSON.stringify(callBody("whats_coming_up", {})),
    });
    expect(JSON.stringify(await res.json())).not.toContain("Kestrel");
  });

  it("the SDK client cannot reach another household either", async () => {
    const env = await makeEnv();
    const c = await connect(env, await env.tokenB());
    const r = await c.client.callTool({ name: "get_agreement", arguments: { about: "car insurance", householdId: A } });
    expect(r.isError).toBe(true);
    await c.close();
  });
});

describe("origin and CORS", () => {
  it("rejects a browser origin that is not allowed and answers an allowed one", async () => {
    const env = await makeEnv({ allowedOrigins: ["http://localhost:5173"] });
    const token = await env.tokenA();
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    };
    const bad = await env.fetch(RESOURCE, {
      method: "POST",
      headers: { ...headers, origin: "https://evil.example" },
      body: JSON.stringify(list),
    });
    expect(bad.status).toBe(403);
    const good = await env.fetch(RESOURCE, {
      method: "POST",
      headers: { ...headers, origin: "http://localhost:5173" },
      body: JSON.stringify(list),
    });
    expect(good.status).toBe(200);
    expect(good.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    const pre = await env.fetch(RESOURCE, {
      method: "OPTIONS",
      headers: { origin: "http://localhost:5173", "access-control-request-method": "POST" },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")).toContain("Authorization");
    const preBad = await env.fetch(RESOURCE, { method: "OPTIONS", headers: { origin: "https://evil.example" } });
    expect(preBad.status).toBe(403);
  });
});
