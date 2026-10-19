import { describe, expect, it } from "vitest";
import { REDIRECT, RESOURCE, authzParams, cookiesOf, makeEnv, openAuthorize, pkce, postAuthorize, qs } from "./helpers";

async function get(over: Record<string, string | undefined>) {
  const env = makeEnv();
  const { challenge } = await pkce();
  const res = await env.req("/oauth/authorize?" + qs(authzParams(challenge, over)));
  return { env, res, loc: res.headers.get("location") };
}

describe("metadata", () => {
  it("protected resource metadata has the RFC 9728 fields", async () => {
    const env = makeEnv();
    const res = await env.req("/.well-known/oauth-protected-resource");
    expect(res.status).toBe(200);
    const b = (await res.json()) as Record<string, unknown>;
    expect(b.resource).toBe(RESOURCE);
    expect(b.authorization_servers).toEqual(["https://api.hippo.test"]);
    expect(b.scopes_supported).toEqual(expect.arrayContaining(["mcp:tools", "mcp:service"]));
    expect(b.bearer_methods_supported).toEqual(["header"]);
  });

  it("authorization server metadata", async () => {
    const env = makeEnv();
    const b = (await (await env.req("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
    expect(b.issuer).toBe("https://api.hippo.test");
    expect(b.authorization_endpoint).toBe("https://api.hippo.test/oauth/authorize");
    expect(b.token_endpoint).toBe("https://api.hippo.test/oauth/token");
    expect(b.response_types_supported).toEqual(["code"]);
    expect(b.grant_types_supported).toEqual(
      expect.arrayContaining(["authorization_code", "refresh_token", "client_credentials"]),
    );
    expect(b.token_endpoint_auth_methods_supported).toEqual(expect.arrayContaining(["none"]));
  });

  it("advertises S256 only, and no registration, userinfo or OIDC fields", async () => {
    const env = makeEnv();
    const b = (await (await env.req("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
    expect(b.code_challenge_methods_supported).toEqual(["S256"]);
    for (const k of [
      "registration_endpoint",
      "userinfo_endpoint",
      "jwks_uri",
      "client_id_metadata_document_supported",
    ]) {
      expect(b).not.toHaveProperty(k);
    }
  });

  it("trailing slash on the configured resource is normalised in the metadata", async () => {
    const env = makeEnv({ resource: RESOURCE + "/", issuer: "https://api.hippo.test/" });
    const b = (await (await env.req("/.well-known/oauth-protected-resource")).json()) as Record<string, unknown>;
    expect(b.resource).toBe(RESOURCE);
    expect(b.authorization_servers).toEqual(["https://api.hippo.test"]);
  });
});

describe("authorize: valid requests", () => {
  it("renders the login page with hardened headers", async () => {
    const { res } = await get({});
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("sets a secure HttpOnly SameSite=Lax csrf cookie", async () => {
    const { res } = await get({});
    const line = res.headers.getSetCookie().find((c) => c.startsWith("hippo_csrf="))!;
    expect(line).toMatch(/HttpOnly/i);
    expect(line).toMatch(/Secure/i);
    expect(line).toMatch(/SameSite=Lax/i);
  });

  it("accepts the second registered redirect uri", async () => {
    const { res } = await get({ redirect_uri: "https://alexa.example/other" });
    expect(res.status).toBe(200);
  });

  it.each([RESOURCE, RESOURCE + "/"])("accepts resource %s", async (resource) => {
    const { res } = await get({ resource });
    expect(res.status).toBe(200);
  });

  it("default scope is applied when none is sent", async () => {
    const { res } = await get({ scope: undefined });
    expect(await res.text()).toContain('name="scope" value="mcp:tools mcp:resources"');
  });
});

describe("authorize: PKCE", () => {
  it("rejects a missing code_challenge by redirecting an error with state", async () => {
    const { loc } = await get({ code_challenge: undefined });
    const u = new URL(loc!);
    expect(u.origin + u.pathname).toBe(REDIRECT);
    expect(u.searchParams.get("error")).toBe("invalid_request");
    expect(u.searchParams.get("state")).toBe("st-123");
    expect(u.searchParams.has("code")).toBe(false);
  });

  it("rejects code_challenge_method=plain", async () => {
    const { loc } = await get({ code_challenge_method: "plain" });
    expect(new URL(loc!).searchParams.get("error")).toBe("invalid_request");
  });

  it("rejects a missing code_challenge_method (no default to plain)", async () => {
    const { loc } = await get({ code_challenge_method: undefined });
    expect(new URL(loc!).searchParams.get("error")).toBe("invalid_request");
  });

  it.each(["s256", "S512", "", "S256 "])("rejects method %j", async (m) => {
    const { loc } = await get({ code_challenge_method: m });
    expect(new URL(loc!).searchParams.get("error")).toBe("invalid_request");
  });

  it.each(["short", "a".repeat(44), "a".repeat(42) + "!", "a".repeat(42) + " "])(
    "rejects malformed challenge %j",
    async (c) => {
      const { loc } = await get({ code_challenge: c });
      expect(new URL(loc!).searchParams.get("error")).toBe("invalid_request");
    },
  );
});

describe("authorize: resource", () => {
  it("requires the resource parameter", async () => {
    const { loc } = await get({ resource: undefined });
    expect(new URL(loc!).searchParams.get("error")).toBe("invalid_target");
  });

  it.each([
    "https://evil.example/mcp",
    "https://api.hippo.test/mcp2",
    "https://api.hippo.test/MCP",
    "http://api.hippo.test/mcp",
    "https://api.hippo.test/mcp//",
    "https://api.hippo.test",
    "",
  ])("rejects resource %j", async (resource) => {
    const { loc } = await get({ resource });
    expect(new URL(loc!).searchParams.get("error")).toBe("invalid_target");
  });
});

describe("authorize: redirect_uri exact match, never redirects on a bad one", () => {
  it.each([
    ["trailing slash", REDIRECT + "/"],
    ["case change in path", "https://alexa.example/auth/Callback"],
    ["case change in host", "https://ALEXA.example/auth/callback"],
    ["extra query", REDIRECT + "?x=1"],
    ["fragment", REDIRECT + "#frag"],
    ["different host", "https://alexa.evil.example/auth/callback"],
    ["suffix host", "https://alexa.example.evil.com/auth/callback"],
    ["userinfo trick", "https://alexa.example@evil.example/auth/callback"],
    ["http scheme", "http://alexa.example/auth/callback"],
    ["prefix match", "https://alexa.example/auth"],
    ["longer path", REDIRECT + "/extra"],
    ["different port", "https://alexa.example:8443/auth/callback"],
    ["wildcard", "https://*.example/auth/callback"],
    ["javascript scheme", "javascript:alert(1)"],
    ["data scheme", "data:text/html,hi"],
    ["protocol relative", "//evil.example/auth/callback"],
    ["empty", ""],
    ["encoded slash", "https://alexa.example/auth%2fcallback"],
    ["leading space", " " + REDIRECT],
    ["trailing space", REDIRECT + " "],
  ])("%s", async (_n, uri) => {
    const { res, loc } = await get({ redirect_uri: uri });
    expect(res.status).toBe(400);
    expect(loc).toBeNull();
    expect(await res.text()).toContain("not registered");
  });

  it("missing redirect_uri is a page error, not a redirect", async () => {
    const { res, loc } = await get({ redirect_uri: undefined });
    expect(res.status).toBe(400);
    expect(loc).toBeNull();
  });

  it("duplicated redirect_uri is rejected without redirect", async () => {
    const env = makeEnv();
    const { challenge } = await pkce();
    const q = qs(authzParams(challenge)) + "&redirect_uri=" + encodeURIComponent("https://evil.example/");
    const res = await env.req("/oauth/authorize?" + q);
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it.each([undefined, "", "unknown", "alexa ", "ALEXA"])("unknown client %j is a page error", async (id) => {
    const { res, loc } = await get({ client_id: id });
    expect(res.status).toBe(400);
    expect(loc).toBeNull();
  });
});

describe("authorize: other parameters", () => {
  it.each(["token", "id_token", "code token", "", undefined])("rejects response_type %j", async (rt) => {
    const { loc } = await get({ response_type: rt });
    expect(new URL(loc!).searchParams.get("error")).toBe("unsupported_response_type");
  });

  it.each(["mcp:service", "admin", "mcp:tools mcp:service", " "])("rejects scope %j", async (scope) => {
    const { loc } = await get({ scope });
    expect(new URL(loc!).searchParams.get("error")).toBe("invalid_scope");
  });

  it("rejects an oversized state", async () => {
    const { loc } = await get({ state: "x".repeat(513) });
    expect(new URL(loc!).searchParams.get("error")).toBe("invalid_request");
  });

  it("rejects duplicated resource", async () => {
    const env = makeEnv();
    const { challenge } = await pkce();
    const q = qs(authzParams(challenge)) + "&resource=" + encodeURIComponent("https://evil.example/");
    const res = await env.req("/oauth/authorize?" + q);
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");
  });
});

describe("authorize: login form", () => {
  it("rejects a POST without the csrf cookie", async () => {
    const env = makeEnv();
    const { challenge } = await pkce();
    const p = authzParams(challenge);
    const page = await openAuthorize(env, p);
    const res = await postAuthorize(env, { ...page, cookies: {} }, p, { action: "demo" });
    expect(res.status).toBe(403);
  });

  it("rejects a POST without the csrf field", async () => {
    const env = makeEnv();
    const { challenge } = await pkce();
    const p = authzParams(challenge);
    const page = await openAuthorize(env, p);
    const res = await postAuthorize(env, { ...page, csrf: "" }, p, { action: "demo" });
    expect(res.status).toBe(403);
  });

  it("rejects a csrf field that does not match the cookie", async () => {
    const env = makeEnv();
    const { challenge } = await pkce();
    const p = authzParams(challenge);
    const page = await openAuthorize(env, p);
    const res = await postAuthorize(env, { ...page, csrf: "forged" }, p, { action: "demo" });
    expect(res.status).toBe(403);
  });

  it("a csrf token from another page view does not match this cookie", async () => {
    const env = makeEnv();
    const { challenge } = await pkce();
    const p = authzParams(challenge);
    const a = await openAuthorize(env, p);
    const b = await openAuthorize(env, p);
    const res = await postAuthorize(env, { ...a, csrf: b.csrf }, p, { action: "demo" });
    expect(res.status).toBe(403);
  });

  it("a wrong magic code is refused and no redirect happens", async () => {
    const env = makeEnv();
    const { challenge } = await pkce();
    const p = authzParams(challenge);
    const page = await openAuthorize(env, p);
    await postAuthorize(env, page, p, { action: "send", email: "a@example.com" });
    const res = await postAuthorize(env, page, p, { action: "login", email: "a@example.com", code: "000000" });
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
  });

  it("a magic code for one email does not work for another", async () => {
    const env = makeEnv();
    const { challenge } = await pkce();
    const p = authzParams(challenge);
    const page = await openAuthorize(env, p);
    await postAuthorize(env, page, p, { action: "send", email: "a@example.com" });
    const code = /: (\d{6})$/.exec(env.logs[0]!)![1]!;
    const res = await postAuthorize(env, page, p, { action: "login", email: "b@example.com", code });
    expect(res.status).toBe(401);
  });

  it("a magic code is single use", async () => {
    const env = makeEnv();
    const { challenge } = await pkce();
    const p = authzParams(challenge);
    const page = await openAuthorize(env, p);
    await postAuthorize(env, page, p, { action: "send", email: "a@example.com" });
    const code = /: (\d{6})$/.exec(env.logs[0]!)![1]!;
    expect((await postAuthorize(env, page, p, { action: "login", email: "a@example.com", code })).status).toBe(302);
    expect((await postAuthorize(env, page, p, { action: "login", email: "a@example.com", code })).status).toBe(401);
  });

  it("a magic code expires after ten minutes", async () => {
    const env = makeEnv();
    const { challenge } = await pkce();
    const p = authzParams(challenge);
    const page = await openAuthorize(env, p);
    await postAuthorize(env, page, p, { action: "send", email: "a@example.com" });
    const code = /: (\d{6})$/.exec(env.logs[0]!)![1]!;
    env.clock.t += 10 * 60_000 + 1;
    expect((await postAuthorize(env, page, p, { action: "login", email: "a@example.com", code })).status).toBe(401);
  });

  it("five wrong guesses burn the magic code even if the sixth is right", async () => {
    const env = makeEnv();
    const { challenge } = await pkce();
    const p = authzParams(challenge);
    const page = await openAuthorize(env, p);
    await postAuthorize(env, page, p, { action: "send", email: "a@example.com" });
    const code = /: (\d{6})$/.exec(env.logs[0]!)![1]!;
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++)
      await postAuthorize(env, page, p, { action: "login", email: "a@example.com", code: wrong });
    expect((await postAuthorize(env, page, p, { action: "login", email: "a@example.com", code })).status).toBe(401);
  });

  it("the send action gives the same answer for an invalid email and never logs", async () => {
    const env = makeEnv();
    const { challenge } = await pkce();
    const p = authzParams(challenge);
    const page = await openAuthorize(env, p);
    const res = await postAuthorize(env, page, p, { action: "send", email: "not-an-email" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("a code was sent");
    expect(env.logs).toHaveLength(0);
  });

  it("the magic code is the only thing logged, once per request", async () => {
    const env = makeEnv();
    const { challenge } = await pkce();
    const p = authzParams(challenge);
    const page = await openAuthorize(env, p);
    await postAuthorize(env, page, p, { action: "send", email: "a@example.com" });
    expect(env.logs).toHaveLength(1);
    expect(env.logs[0]).toMatch(/^\[hippo-auth\] magic code for a@example.com: \d{6}$/);
  });

  it("an unknown action is a bad request", async () => {
    const env = makeEnv();
    const { challenge } = await pkce();
    const p = authzParams(challenge);
    const page = await openAuthorize(env, p);
    expect((await postAuthorize(env, page, p, { action: "hack" })).status).toBe(400);
    expect((await postAuthorize(env, page, p, {})).status).toBe(400);
  });

  it("a POST re-validates the parameters: tampered redirect_uri gets a page, not a redirect", async () => {
    const env = makeEnv();
    const { challenge } = await pkce();
    const p = authzParams(challenge);
    const page = await openAuthorize(env, p);
    const res = await postAuthorize(env, page, { ...p, redirect_uri: "https://evil.example/cb" }, { action: "demo" });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("a POST re-validates PKCE: stripped challenge is refused", async () => {
    const env = makeEnv();
    const { challenge } = await pkce();
    const p = authzParams(challenge);
    const page = await openAuthorize(env, p);
    const res = await postAuthorize(env, page, { ...p, code_challenge: undefined }, { action: "demo" });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("invalid_request");
    expect(loc.searchParams.has("code")).toBe(false);
  });

  it("a POST with a JSON content type is refused", async () => {
    const env = makeEnv();
    const res = await env.req("/oauth/authorize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
  });

  it("the csrf cookie is cleared after a successful login", async () => {
    const env = makeEnv();
    const { challenge } = await pkce();
    const p = authzParams(challenge);
    const page = await openAuthorize(env, p);
    const res = await postAuthorize(env, page, p, { action: "demo" });
    expect(cookiesOf(res).hippo_csrf).toBe("");
  });

  it("a household id sent in the form is ignored", async () => {
    const env = makeEnv();
    const { challenge } = await pkce();
    const p = authzParams(challenge);
    const page = await openAuthorize(env, p);
    const res = await postAuthorize(env, page, p, {
      action: "demo",
      householdId: "hh_victim",
      household_id: "hh_victim",
    });
    expect(res.status).toBe(302);
  });
});
