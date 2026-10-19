import { describe, expect, it } from "vitest";
import {
  REDIRECT,
  RESOURCE,
  authzParams,
  cookieHeader,
  cookiesOf,
  form,
  lastMagic,
  makeEnv,
  openAuthorize,
  pkce,
  postAuthorize,
  tokenReq,
  type Env,
} from "./helpers";

const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

async function webLogin(env: Env, email = "web@example.com") {
  await env.req("/oauth/magic-code", json({ email }));
  return env.req("/oauth/session", json({ email, code: lastMagic(env) }));
}

describe("web session", () => {
  it("logs in with a magic code and sets a secure HttpOnly SameSite=Lax cookie", async () => {
    const env = makeEnv();
    const res = await webLogin(env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "web@example.com", householdId: "hh_web" });
    const line = res.headers.getSetCookie().find((c) => c.startsWith("hippo_session="))!;
    expect(line).toMatch(/HttpOnly/i);
    expect(line).toMatch(/Secure/i);
    expect(line).toMatch(/SameSite=Lax/i);
    expect(line).toMatch(/Path=\//i);
    expect(line).toMatch(/Max-Age=604800/i);
  });

  it("the cookie is not marked Secure for a plain http local issuer by default", async () => {
    const env = makeEnv({ issuer: "http://localhost:8787", resource: "http://localhost:8787/mcp" });
    const res = await env.auth.app.request("http://localhost:8787/oauth/session", json({ demo: true }));
    expect(res.headers.getSetCookie()[0]).not.toMatch(/Secure/i);
  });

  it("GET /oauth/session returns the session and verifySession agrees", async () => {
    const env = makeEnv();
    const c = cookiesOf(await webLogin(env));
    const res = await env.req("/oauth/session", { headers: { cookie: cookieHeader(c) } });
    expect(await res.json()).toEqual({ email: "web@example.com", householdId: "hh_web" });
    expect(await env.auth.verifySession(cookieHeader(c))).toEqual({ email: "web@example.com", householdId: "hh_web" });
  });

  it("demo login works when configured", async () => {
    const env = makeEnv();
    const res = await env.req("/oauth/session", json({ demo: true }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { householdId: string }).householdId).toBe("hh_demo");
  });

  it("demo login is refused when not configured", async () => {
    const env = makeEnv({ demoUser: undefined });
    expect((await env.req("/oauth/session", json({ demo: true }))).status).toBe(401);
  });

  it("the fixed demo code works", async () => {
    const env = makeEnv();
    const res = await env.req("/oauth/session", json({ email: "demo@hippo.test", code: "424242" }));
    expect(res.status).toBe(200);
  });

  it("rejects a wrong code, an unknown email and no code", async () => {
    const env = makeEnv();
    await env.req("/oauth/magic-code", json({ email: "web@example.com" }));
    expect((await env.req("/oauth/session", json({ email: "web@example.com", code: "000000" }))).status).toBe(401);
    expect((await env.req("/oauth/session", json({ email: "nobody@example.com", code: "123456" }))).status).toBe(401);
    expect((await env.req("/oauth/session", json({ email: "web@example.com" }))).status).toBe(401);
  });

  it("a household id in the login body is ignored", async () => {
    const env = makeEnv();
    await env.req("/oauth/magic-code", json({ email: "web@example.com" }));
    const res = await env.req(
      "/oauth/session",
      json({ email: "web@example.com", code: lastMagic(env), householdId: "hh_victim", household_id: "hh_victim" }),
    );
    expect(((await res.json()) as { householdId: string }).householdId).toBe("hh_web");
  });

  it("the session expires after seven days (injected clock)", async () => {
    const env = makeEnv();
    const c = cookieHeader(cookiesOf(await webLogin(env)));
    env.clock.t += 7 * 24 * 3600_000 - 1000;
    expect(await env.auth.verifySession(c)).not.toBeNull();
    env.clock.t += 2000;
    expect(await env.auth.verifySession(c)).toBeNull();
    expect((await env.req("/oauth/session", { headers: { cookie: c } })).status).toBe(401);
  });

  it("logout destroys the server side session, not just the cookie", async () => {
    const env = makeEnv();
    const c = cookieHeader(cookiesOf(await webLogin(env)));
    const out = await env.req("/oauth/logout", json({}, { cookie: c }));
    expect(out.status).toBe(200);
    expect(out.headers.getSetCookie()[0]).toMatch(/hippo_session=;/);
    expect(await env.auth.verifySession(c)).toBeNull();
  });

  it("the magic-code endpoint answers the same for any valid address", async () => {
    const env = makeEnv();
    const a = await env.req("/oauth/magic-code", json({ email: "one@example.com" }));
    const b = await env.req("/oauth/magic-code", json({ email: "two@example.com" }));
    expect(await a.json()).toEqual(await b.json());
    expect((await env.req("/oauth/magic-code", json({ email: "bad" }))).status).toBe(400);
  });

  it("an unknown or forged cookie gives no session", async () => {
    const env = makeEnv();
    expect(await env.auth.verifySession("hippo_session=forged")).toBeNull();
    expect(await env.auth.verifySession("other=1; hippo_session=")).toBeNull();
    expect(await env.auth.verifySession("hippo_session=" + "a".repeat(500))).toBeNull();
    expect((await env.req("/oauth/session")).status).toBe(401);
  });

  it("401 on the session endpoint has no WWW-Authenticate", async () => {
    const env = makeEnv();
    expect((await env.req("/oauth/session")).headers.has("www-authenticate")).toBe(false);
  });

  it("a web session does not authenticate the token endpoint or the bearer check", async () => {
    const env = makeEnv();
    const c = cookiesOf(await webLogin(env));
    expect(await env.auth.verifyBearer("Bearer " + c.hippo_session)).toBeNull();
    expect(
      await env.auth.verifyRequest(new Request("https://x/mcp", { headers: { cookie: cookieHeader(c) } })),
    ).toBeNull();
  });
});

describe("web session: CSRF and content type", () => {
  it("rejects a form encoded POST (what a cross site form would send)", async () => {
    const env = makeEnv();
    const res = await env.req("/oauth/session", form({ demo: "true" }));
    expect(res.status).toBe(415);
  });

  it("rejects text/plain, the other simple content type", async () => {
    const env = makeEnv();
    const res = await env.req("/oauth/session", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: '{"demo":true}',
    });
    expect(res.status).toBe(415);
  });

  it("rejects a foreign Origin on every session endpoint", async () => {
    const env = makeEnv();
    for (const path of ["/oauth/session", "/oauth/logout", "/oauth/magic-code"]) {
      const res = await env.req(path, json({ demo: true, email: "a@example.com" }, { origin: "https://evil.example" }));
      expect(res.status).toBe(403);
    }
  });

  it("accepts the issuer origin and any configured allowed origin", async () => {
    const env = makeEnv({ allowedOrigins: ["https://app.hippo.test"] });
    expect((await env.req("/oauth/session", json({ demo: true }, { origin: "https://app.hippo.test" }))).status).toBe(
      200,
    );
    expect((await env.req("/oauth/session", json({ demo: true }, { origin: "https://api.hippo.test" }))).status).toBe(
      403,
    );
  });

  it("origin null (sandboxed iframe) is refused", async () => {
    const env = makeEnv();
    expect((await env.req("/oauth/session", json({ demo: true }, { origin: "null" }))).status).toBe(403);
  });

  it("emits no CORS headers", async () => {
    const env = makeEnv();
    const res = await env.req("/oauth/session", json({ demo: true }));
    expect(res.headers.has("access-control-allow-origin")).toBe(false);
  });

  it.each(["not json", "[]", "null", "5", '"x"'])("rejects the body %j", async (b) => {
    const env = makeEnv();
    expect((await env.req("/oauth/session", json(b))).status).toBe(400);
  });
});

describe("hostile input", () => {
  it("rejects huge bodies with 413 on every POST endpoint", async () => {
    const env = makeEnv();
    const big = "x=" + "a".repeat(20_000);
    const f = { "content-type": "application/x-www-form-urlencoded" };
    expect((await env.req("/oauth/token", { method: "POST", headers: f, body: big })).status).toBe(413);
    expect((await env.req("/oauth/authorize", { method: "POST", headers: f, body: big })).status).toBe(413);
    const j = { "content-type": "application/json" };
    expect(
      (await env.req("/oauth/session", { method: "POST", headers: j, body: JSON.stringify({ a: big }) })).status,
    ).toBe(413);
    expect(
      (await env.req("/oauth/logout", { method: "POST", headers: j, body: JSON.stringify({ a: big }) })).status,
    ).toBe(413);
    expect(
      (await env.req("/oauth/magic-code", { method: "POST", headers: j, body: JSON.stringify({ a: big }) })).status,
    ).toBe(413);
  });

  it("a huge Content-Length that does not match is refused", async () => {
    const env = makeEnv();
    const res = await env.req("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "content-length": "999999" },
      body: "grant_type=x",
    });
    expect([400, 413]).toContain(res.status);
  });

  it("a huge query string on authorize does not crash and does not redirect", async () => {
    const env = makeEnv();
    const { challenge } = await pkce();
    const res = await env.req(
      "/oauth/authorize?" +
        new URLSearchParams({ ...(authzParams(challenge) as Record<string, string>), junk: "a".repeat(100_000) }),
    );
    expect(res.status).toBeLessThan(500);
  });

  it("an XSS payload in email is escaped in the page", async () => {
    const env = makeEnv();
    const { challenge } = await pkce();
    const p = authzParams(challenge);
    const page = await openAuthorize(env, p);
    const res = await postAuthorize(env, page, p, { action: "login", email: '"><script>alert(1)</script>', code: "1" });
    const html = await res.text();
    expect(html).not.toContain("<script>alert");
  });

  it("an XSS payload in client_id or redirect_uri never reaches the page unescaped", async () => {
    const env = makeEnv();
    const { challenge } = await pkce();
    for (const over of [{ client_id: '"><img src=x onerror=1>' }, { redirect_uri: '"><img src=x onerror=1>' }]) {
      const res = await env.req(
        "/oauth/authorize?" + new URLSearchParams({ ...(authzParams(challenge, over) as Record<string, string>) }),
      );
      expect(await res.text()).not.toContain("<img");
    }
  });

  it("hostile Host, X-Forwarded-Host and Origin headers do not change the issuer in metadata", async () => {
    const env = makeEnv();
    const res = await env.auth.app.request("https://evil.example/.well-known/oauth-authorization-server", {
      headers: {
        host: "evil.example",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "http",
        origin: "https://evil.example",
      },
    });
    const b = (await res.json()) as Record<string, string>;
    expect(b.issuer).toBe("https://api.hippo.test");
    expect(b.token_endpoint).toBe("https://api.hippo.test/oauth/token");
  });

  it("the authorize redirect target comes from the registry, not from Host or Referer", async () => {
    const env = makeEnv();
    const { challenge } = await pkce();
    const p = authzParams(challenge);
    const page = await openAuthorize(env, p);
    const res = await env.req("/oauth/authorize", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookieHeader(page.cookies),
        referer: "https://evil.example/",
        host: "evil.example",
        "x-forwarded-host": "evil.example",
      },
      body: new URLSearchParams({ ...(p as Record<string, string>), csrf: page.csrf, action: "demo" }).toString(),
    });
    expect(new URL(res.headers.get("location")!).origin).toBe(new URL(REDIRECT).origin);
  });

  it.each([
    "//evil.example",
    "https://evil.example",
    "/\\evil.example",
    "https:evil.example",
    "javascript:alert(1)",
    "https://alexa.example/auth/callback\r\nSet-Cookie: a=b",
    "https://alexa.example/auth/callback%0d%0aSet-Cookie:a=b",
  ])("open redirect attempt %j never produces a Location", async (uri) => {
    const env = makeEnv();
    const { challenge } = await pkce();
    const res = await env.req(
      "/oauth/authorize?" +
        new URLSearchParams({ ...(authzParams(challenge, { redirect_uri: uri }) as Record<string, string>) }),
    );
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(400);
  });

  it("state cannot inject headers or extra parameters into the redirect", async () => {
    const env = makeEnv();
    const { challenge } = await pkce();
    const p = authzParams(challenge, { state: "x&code=evil\r\nSet-Cookie: a=b" });
    const page = await openAuthorize(env, p);
    const res = await postAuthorize(env, page, p, { action: "demo" });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.getAll("code")).toHaveLength(1);
    expect(loc.searchParams.get("code")).not.toBe("evil");
    expect(res.headers.getSetCookie().some((c) => c.startsWith("a="))).toBe(false);
  });

  it("an email with header injection characters is rejected", async () => {
    const env = makeEnv();
    const res = await env.req("/oauth/magic-code", json({ email: "a@example.com\r\nBcc: x@evil.example" }));
    expect(res.status).toBe(400);
    expect(env.logs).toHaveLength(0);
  });

  it("an over long email is rejected", async () => {
    const env = makeEnv();
    const res = await env.req("/oauth/magic-code", json({ email: "a".repeat(300) + "@example.com" }));
    expect(res.status).toBe(400);
  });

  it("an unknown route is 404 and unsupported methods are not served", async () => {
    const env = makeEnv();
    expect((await env.req("/oauth/register", { method: "POST" })).status).toBe(404);
    expect((await env.req("/.well-known/openid-configuration")).status).toBe(404);
    expect((await env.req("/oauth/userinfo")).status).toBe(404);
    expect((await env.req("/oauth/token", { method: "PUT" })).status).toBe(404);
    expect((await env.req("/oauth/authorize", { method: "DELETE" })).status).toBe(404);
  });

  it("random injected function drives the codes (deterministic stores)", async () => {
    let n = 0;
    const env = makeEnv({ random: (len) => new Uint8Array(len).fill(++n % 250) });
    const res = await env.req("/oauth/magic-code", json({ email: "a@example.com" }));
    expect(res.status).toBe(200);
    expect(env.logs[0]).toMatch(/\d{6}$/);
  });

  it("two concurrent exchanges of one code produce at most one token pair", async () => {
    const env = makeEnv();
    const { verifier, challenge } = await pkce();
    const page = await openAuthorize(env, authzParams(challenge));
    const r = await postAuthorize(env, page, authzParams(challenge), { action: "demo" });
    const code = new URL(r.headers.get("location")!).searchParams.get("code")!;
    const g = {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: "alexa",
      code_verifier: verifier,
      resource: RESOURCE,
    };
    const results = await Promise.all([tokenReq(env, g), tokenReq(env, g), tokenReq(env, g)]);
    expect(results.filter((x) => x.status === 200)).toHaveLength(1);
  });

  it("two concurrent refreshes of one token produce at most one new token", async () => {
    const env = makeEnv();
    const { verifier, challenge } = await pkce();
    const page = await openAuthorize(env, authzParams(challenge));
    const r = await postAuthorize(env, page, authzParams(challenge), { action: "demo" });
    const code = new URL(r.headers.get("location")!).searchParams.get("code")!;
    const t = (await (
      await tokenReq(env, {
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: "alexa",
        code_verifier: verifier,
        resource: RESOURCE,
      })
    ).json()) as { refresh_token: string };
    const g = { grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: "alexa" };
    const results = await Promise.all([tokenReq(env, g), tokenReq(env, g)]);
    expect(results.filter((x) => x.status === 200)).toHaveLength(1);
  });
});
