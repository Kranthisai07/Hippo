import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import type { AuditEvent } from "../src";
import { sha256b64url } from "../src/crypto";
import {
  REDIRECT,
  cookieHeader,
  cookiesOf,
  authzParams,
  codeGrant,
  fullTokens,
  makeEnv,
  openAuthorize,
  pkce,
  postAuthorize,
  tokenReq,
  type Env,
  ISSUER,
} from "./helpers";

// The flow end to end with a fake Google that plays the protocol: it checks the client id, the client secret, the redirect
// address and the PKCE verifier, refuses a code that was used before, and signs ID tokens with a key of its own.

const CLIENT_ID = "1234-test.apps.googleusercontent.com";
const SECRET = "google-client-secret-value";
const WEB = "https://app.hippo.test";

let keys: ReturnType<typeof createLocalJWKSet>;
let signer: CryptoKey;
let stranger: CryptoKey;

beforeAll(async () => {
  const good = await generateKeyPair("RS256", { extractable: true });
  stranger = (await generateKeyPair("RS256", { extractable: true })).privateKey;
  signer = good.privateKey;
  const jwk: JWK = { ...(await exportJWK(good.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  keys = createLocalJWKSet({ keys: [jwk] });
});

interface Issued {
  email: string;
  nonce: string;
  challenge: string;
  redirectUri: string;
  used: boolean;
  claims: Record<string, unknown>;
  key?: CryptoKey;
  expSec?: number;
  aud?: string;
}

function setup(over: { google?: false; tokenEndpoint?: "ok" | "http500" | "html" | "hang"; timeoutMs?: number } = {}) {
  const codes = new Map<string, Issued>();
  const audit: AuditEvent[] = [];
  let n = 0;
  const now = () => Date.UTC(2026, 9, 18, 12, 0, 0);
  const mint = (r: Issued) =>
    new SignJWT({ email: r.email, email_verified: true, nonce: r.nonce, ...r.claims })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer("https://accounts.google.com")
      .setAudience(r.aud ?? CLIENT_ID)
      .setSubject("google-sub-1")
      .setIssuedAt(Math.floor(now() / 1000))
      .setExpirationTime(r.expSec ?? Math.floor(now() / 1000) + 3600)
      .sign(r.key ?? signer);
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    if (over.tokenEndpoint === "http500") return new Response("{}", { status: 500 });
    if (over.tokenEndpoint === "html") return new Response("<html>x</html>", { status: 200 });
    if (over.tokenEndpoint === "hang") {
      return new Promise((_r, rej) =>
        init.signal!.addEventListener("abort", () => rej(new DOMException("a", "AbortError"))),
      );
    }
    const b = init.body as URLSearchParams;
    const rec = codes.get(b.get("code") ?? "");
    const verifierOk = rec && (await sha256b64url(b.get("code_verifier") ?? "")) === rec.challenge;
    if (
      !rec ||
      rec.used ||
      b.get("client_id") !== CLIENT_ID ||
      b.get("client_secret") !== SECRET ||
      b.get("redirect_uri") !== rec.redirectUri ||
      b.get("grant_type") !== "authorization_code" ||
      !verifierOk
    ) {
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }
    rec.used = true;
    return new Response(JSON.stringify({ id_token: await mint(rec) }), { status: 200 });
  }) as unknown as typeof fetch;

  const env: Env = makeEnv({
    logMagicCodes: false,
    allowedOrigins: [ISSUER, WEB],
    audit: (e) => audit.push(e),
    ...(over.google === false
      ? {}
      : {
          google: {
            clientId: CLIENT_ID,
            clientSecret: SECRET,
            jwks: keys,
            fetch: fetchImpl,
            ...(over.timeoutMs ? { timeoutMs: over.timeoutMs } : {}),
          },
        }),
  });

  /** Plays Google's side of one attempt: reads what our server sent, and hands back a code and the state. */
  function issue(
    location: string,
    o: {
      email?: string;
      claims?: Record<string, unknown>;
      key?: CryptoKey;
      expSec?: number;
      nonce?: string;
      aud?: string;
    } = {},
  ) {
    const u = new URL(location);
    const code = `gcode-${++n}`;
    codes.set(code, {
      email: o.email ?? "alice@example.com",
      nonce: o.nonce ?? u.searchParams.get("nonce")!,
      challenge: u.searchParams.get("code_challenge")!,
      redirectUri: u.searchParams.get("redirect_uri")!,
      used: false,
      claims: o.claims ?? {},
      ...(o.key ? { key: o.key } : {}),
      ...(o.expSec ? { expSec: o.expSec } : {}),
      ...(o.aud ? { aud: o.aud } : {}),
    });
    return { code, state: u.searchParams.get("state")! };
  }

  /** The browser clicks "Continue with Google" on the authorize page. */
  async function clickGoogle(p = authzParams("A".repeat(43))) {
    const page = await openAuthorize(env, p);
    const res = await postAuthorize(env, page, p, { action: "google" });
    return { page, res, location: res.headers.get("location") ?? "", pending: cookiesOf(res).hippo_gpending ?? "" };
  }
  const callback = (query: Record<string, string>, pending: string | undefined) =>
    env.req(`/oauth/google/callback?${new URLSearchParams(query)}`, {
      headers: pending === undefined ? {} : { cookie: `hippo_gpending=${pending}` },
    });

  return { env, audit, codes, issue, clickGoogle, callback, mint };
}

const FAILED_PAGE = "Google sign in did not work";
const householdOf = async (env: Env, access: string) => (await env.auth.verifyBearer(`Bearer ${access}`))?.householdId;

describe("the button", () => {
  it("shows only when Google is configured, and /oauth/providers says the same", async () => {
    const on = setup();
    const off = setup({ google: false });
    const p = authzParams("A".repeat(43));
    expect(
      await (await on.env.req("/oauth/authorize?" + new URLSearchParams(p as Record<string, string>))).text(),
    ).toContain("Continue with Google");
    expect(
      await (await off.env.req("/oauth/authorize?" + new URLSearchParams(p as Record<string, string>))).text(),
    ).not.toContain("Google");
    expect(await (await on.env.req("/oauth/providers")).json()).toEqual({ google: true });
    expect(await (await off.env.req("/oauth/providers")).json()).toEqual({ google: false });
  });
  it("does not run the email check first: the button works with an empty email box", async () => {
    const t = setup();
    const html = await (
      await t.env.req("/oauth/authorize?" + new URLSearchParams(authzParams("A".repeat(43)) as Record<string, string>))
    ).text();
    expect(html).toMatch(/<button[^>]*value="google"[^>]*formnovalidate/);
  });
  it("when Google is off, the action, the start and the callback are refused", async () => {
    const t = setup({ google: false });
    const page = await openAuthorize(t.env, authzParams("A".repeat(43)));
    expect((await postAuthorize(t.env, page, authzParams("A".repeat(43)), { action: "google" })).status).toBe(400);
    expect((await t.env.req("/oauth/google/start")).status).toBe(404);
    expect((await t.callback({ code: "x", state: "y" }, "z")).status).toBe(404);
  });
  it("is refused without the CSRF value", async () => {
    const t = setup();
    const p = authzParams("A".repeat(43));
    const page = await openAuthorize(t.env, p);
    const res = await postAuthorize(t.env, page, p, { action: "google", csrf: "forged" });
    expect(res.status).toBe(403);
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("signing in with Google from the authorize page", () => {
  it("sends the person to Google with the right request, and keeps the attempt in one short lived cookie", async () => {
    const t = setup();
    const { res, location } = await t.clickGoogle();
    expect(res.status).toBe(302);
    const u = new URL(location);
    expect(`${u.origin}${u.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(u.searchParams.get("redirect_uri")).toBe(`${ISSUER}/oauth/google/callback`);
    expect(u.searchParams.get("scope")).toBe("openid email");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    for (const k of ["state", "nonce", "code_challenge"]) expect(u.searchParams.get(k)).toBeTruthy();
    expect(location).not.toContain(SECRET);
    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith("hippo_gpending="))!;
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\/oauth\/google/i);
    expect(setCookie).toMatch(/Max-Age=600/i);
    expect(setCookie).toMatch(/Secure/i);
  });

  it("finishes by giving the client its own code and state, and the same household as an emailed code", async () => {
    const t = setup();
    const { verifier, challenge } = await pkce();
    const p = authzParams(challenge);
    const { res, location, pending } = await (async () => {
      const page = await openAuthorize(t.env, p);
      const r = await postAuthorize(t.env, page, p, { action: "google" });
      return { res: r, location: r.headers.get("location")!, pending: cookiesOf(r).hippo_gpending! };
    })();
    expect(res.status).toBe(302);
    const g = t.issue(location);
    const back = await t.callback({ code: g.code, state: g.state }, pending);
    expect(back.status).toBe(302);
    const to = new URL(back.headers.get("location")!);
    expect(`${to.origin}${to.pathname}`).toBe(REDIRECT);
    expect(to.searchParams.get("state")).toBe("st-123");
    const clientCode = to.searchParams.get("code")!;
    expect(
      back.headers
        .getSetCookie()
        .some((c) => /^hippo_gpending=;|hippo_gpending=; /i.test(c) || /hippo_gpending=.*Max-Age=0/i.test(c)),
    ).toBe(true);

    const tokens = (await (await tokenReq(t.env, codeGrant(clientCode, verifier))).json()) as { access_token: string };
    const viaGoogle = await householdOf(t.env, tokens.access_token);
    expect(viaGoogle).toBe("hh_alice");

    // The same address through an emailed code lands in the same household.
    const sent: string[] = [];
    const mail = makeEnv({ mailer: { send: async (_e, code) => void sent.push(code) } });
    await mail.req("/oauth/magic-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "alice@example.com" }),
    });
    const session = await mail.req("/oauth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "alice@example.com", code: sent[0] }),
    });
    expect(((await session.json()) as { householdId: string }).householdId).toBe(viaGoogle);
  });

  it("gives two different people two different households", async () => {
    const t = setup();
    const ids: (string | undefined)[] = [];
    for (const email of ["alice@example.com", "bob@example.com"]) {
      const { verifier, challenge } = await pkce();
      const p = authzParams(challenge);
      const page = await openAuthorize(t.env, p);
      const r = await postAuthorize(t.env, page, p, { action: "google" });
      const g = t.issue(r.headers.get("location")!, { email });
      const back = await t.callback({ code: g.code, state: g.state }, cookiesOf(r).hippo_gpending);
      const code = new URL(back.headers.get("location")!).searchParams.get("code")!;
      const tokens = (await (await tokenReq(t.env, codeGrant(code, verifier))).json()) as { access_token: string };
      ids.push(await householdOf(t.env, tokens.access_token));
    }
    expect(ids).toEqual(["hh_alice", "hh_bob"]);
  });
  it("writes the address the way our other sign ins do, whatever case Google used", async () => {
    const t = setup();
    const { verifier, challenge } = await pkce();
    const p = authzParams(challenge);
    const page = await openAuthorize(t.env, p);
    const r = await postAuthorize(t.env, page, p, { action: "google" });
    const g = t.issue(r.headers.get("location")!, { email: "Alice@Example.COM" });
    const back = await t.callback({ code: g.code, state: g.state }, cookiesOf(r).hippo_gpending);
    const clientCode = new URL(back.headers.get("location")!).searchParams.get("code")!;
    const tokens = (await (await tokenReq(t.env, codeGrant(clientCode, verifier))).json()) as { access_token: string };
    expect(await householdOf(t.env, tokens.access_token)).toBe("hh_alice");
  });
});

describe("signing in to the web app with Google", () => {
  async function web(t: ReturnType<typeof setup>, ret?: string) {
    const start = await t.env.req(
      `/oauth/google/start${ret === undefined ? "" : "?" + new URLSearchParams({ return: ret })}`,
    );
    expect(start.status).toBe(302);
    const g = t.issue(start.headers.get("location")!);
    return t.callback({ code: g.code, state: g.state }, cookiesOf(start).hippo_gpending);
  }

  it("sets the cookie session and returns to a page of the web app", async () => {
    const t = setup();
    const back = await web(t, `${WEB}/review/doc-1`);
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe(`${WEB}/review/doc-1`);
    const cookie = cookieHeader(
      Object.fromEntries(Object.entries(cookiesOf(back)).filter(([k]) => k === "hippo_session")),
    );
    expect(cookie).toContain("hippo_session=");
    const me = await t.env.req("/oauth/session", { headers: { cookie } });
    expect(await me.json()).toMatchObject({ email: "alice@example.com", householdId: "hh_alice" });
  });
  it("accepts a path on its own address", async () => {
    const t = setup();
    expect((await web(t, "/coming-up")).headers.get("location")).toBe(`${ISSUER}/coming-up`);
  });
  it.each([
    ["a protocol relative address", "//evil.example/x"],
    ["a backslash trick", "/\\evil.example"],
    ["another origin", "https://evil.example/x"],
    ["credentials in front", `${WEB}@evil.example/x`],
    ["a script address", "javascript:alert(1)"],
    ["nothing at all", undefined],
  ])("never redirects to %s: it goes to the home page instead", async (_n, ret) => {
    const t = setup();
    expect((await web(t, ret as string | undefined)).headers.get("location")).toBe(`${ISSUER}/`);
  });
});

describe("what is refused, and what the person sees", () => {
  async function attempt(
    t: ReturnType<typeof setup>,
    change: (
      g: { code: string; state: string },
      pending: string,
    ) => { query: Record<string, string>; pending?: string },
  ) {
    const { location, pending } = await t.clickGoogle();
    const g = t.issue(location);
    const { query, pending: sent } = change(g, pending);
    return t.callback(query, sent === undefined ? pending : sent === "" ? undefined : sent);
  }
  const refused = async (res: Response) => {
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    const html = await res.text();
    expect(html).toContain(FAILED_PAGE);
    expect(html).not.toMatch(/invalid_grant|nonce|signature|JWT|exception/i);
    // The attempt cookie is cleared even on a failure.
    expect(
      res.headers
        .getSetCookie()
        .some(
          (c) =>
            c.startsWith("hippo_gpending=") &&
            /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c) &&
            /Path=\/oauth\/google/i.test(c),
        ),
    ).toBe(true);
  };

  it("is never cached, whether it worked or not", async () => {
    const t = setup();
    const { location, pending } = await t.clickGoogle();
    const g = t.issue(location);
    const ok = await t.callback({ code: g.code, state: g.state }, pending);
    expect(ok.status).toBe(302);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    const bad = await t.callback({ code: "x", state: "y" }, "garbage");
    expect(bad.headers.get("cache-control")).toBe("no-store");
  });
  it("a callback with no cookie", async () => {
    const t = setup();
    await refused(await attempt(t, (g) => ({ query: { code: g.code, state: g.state }, pending: "" })));
  });
  it("a cookie that was changed", async () => {
    const t = setup();
    await refused(
      await attempt(t, (g, p) => ({
        query: { code: g.code, state: g.state },
        pending: p.slice(0, -3) + (p.endsWith("AAA") ? "BBB" : "AAA"),
      })),
    );
  });
  it("a cookie that has expired", async () => {
    const t = setup();
    const { location, pending } = await t.clickGoogle();
    const g = t.issue(location);
    t.env.clock.t += 601_000;
    await refused(await t.callback({ code: g.code, state: g.state }, pending));
  });
  it("a state that is not this attempt's", async () => {
    const t = setup();
    await refused(await attempt(t, (g) => ({ query: { code: g.code, state: "someone-elses-state" } })));
  });
  it("no state at all, and a repeated state parameter", async () => {
    const t = setup();
    await refused(await attempt(t, (g) => ({ query: { code: g.code } })));
    const t2 = setup();
    const { location, pending } = await t2.clickGoogle();
    const g = t2.issue(location);
    await refused(
      await t2.env.req(`/oauth/google/callback?code=${g.code}&state=${g.state}&state=${g.state}`, {
        headers: { cookie: `hippo_gpending=${pending}` },
      }),
    );
  });
  it("no code, an empty code and a code Google does not know", async () => {
    const t = setup();
    await refused(await attempt(t, (g) => ({ query: { state: g.state } })));
    await refused(await attempt(t, (g) => ({ query: { state: g.state, code: "" } })));
    await refused(await attempt(t, (g) => ({ query: { state: g.state, code: "made-up" } })));
  });
  it("an ID token made for another attempt (wrong nonce)", async () => {
    const t = setup();
    const { location, pending } = await t.clickGoogle();
    const g = t.issue(location, { nonce: "a-nonce-from-another-attempt" });
    await refused(await t.callback({ code: g.code, state: g.state }, pending));
  });
  it.each([
    ["an address Google has not verified", { claims: { email_verified: false } }],
    ["no verified flag", { claims: { email_verified: undefined } }],
    ["an address that is not an address", { email: "not an email" }],
    ["another client's audience", { aud: "someone-elses-client.apps.googleusercontent.com" }],
    ["a token signed with some other key", { key: "stranger" }],
    ["a token that has expired", { expSec: 1000 }],
  ])("%s", async (_n, o) => {
    const t = setup();
    const { location, pending } = await t.clickGoogle();
    const opts = o as {
      claims?: Record<string, unknown>;
      email?: string;
      aud?: string;
      key?: string;
      expSec?: number;
    };
    const g = t.issue(location, {
      ...(opts.email ? { email: opts.email } : {}),
      ...(opts.claims ? { claims: opts.claims } : {}),
      ...(opts.key ? { key: stranger } : {}),
      ...(opts.expSec ? { expSec: opts.expSec } : {}),
      ...(opts.aud ? { aud: opts.aud } : {}),
    });
    await refused(await t.callback({ code: g.code, state: g.state }, pending));
  });
  it("the token endpoint failing, answering with junk, or not answering", async () => {
    for (const mode of ["http500", "html"] as const) {
      const t = setup({ tokenEndpoint: mode });
      const { location, pending } = await t.clickGoogle();
      const g = t.issue(location);
      await refused(await t.callback({ code: g.code, state: g.state }, pending));
    }
    const t = setup({ tokenEndpoint: "hang", timeoutMs: 50 });
    const { location, pending } = await t.clickGoogle();
    const g = t.issue(location);
    const started = Date.now();
    await refused(await t.callback({ code: g.code, state: g.state }, pending));
    expect(Date.now() - started).toBeLessThan(3000);
  });
  it("a second use of the same callback, even with the cookie kept", async () => {
    const t = setup();
    const { location, pending } = await t.clickGoogle();
    const g = t.issue(location);
    expect((await t.callback({ code: g.code, state: g.state }, pending)).status).toBe(302);
    await refused(await t.callback({ code: g.code, state: g.state }, pending));
  });
  it("a person who says no on Google's page goes back to the client as access_denied with the client's state", async () => {
    const t = setup();
    const { location, pending } = await t.clickGoogle();
    const g = t.issue(location);
    const res = await t.callback({ error: "access_denied", state: g.state }, pending);
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!);
    expect(`${to.origin}${to.pathname}`).toBe(REDIRECT);
    expect(to.searchParams.get("error")).toBe("access_denied");
    expect(to.searchParams.get("state")).toBe("st-123");
    expect(to.searchParams.get("code")).toBeNull();
  });
  it("a denial with a wrong state is not passed on to the client", async () => {
    const t = setup();
    const { pending } = await t.clickGoogle();
    await refused(await t.callback({ error: "access_denied", state: "forged" }, pending));
  });
  it("an access token cannot stand in for the attempt cookie", async () => {
    const t = setup();
    const { location } = await t.clickGoogle();
    const g = t.issue(location);
    const { body } = await fullTokens(t.env);
    await refused(await t.callback({ code: g.code, state: g.state }, body.access_token));
  });
});

describe("logs and audit", () => {
  it("never hold the client secret, the code, the ID token or the email, and say who signed in by a hashed id", async () => {
    const t = setup();
    const { verifier, challenge } = await pkce();
    const p = authzParams(challenge);
    const page = await openAuthorize(t.env, p);
    const r = await postAuthorize(t.env, page, p, { action: "google" });
    const g = t.issue(r.headers.get("location")!);
    const idToken = await t.mint(t.codes.get(g.code)!);
    const back = await t.callback({ code: g.code, state: g.state }, cookiesOf(r).hippo_gpending);
    expect(back.status).toBe(302);
    // A failed one too.
    await t.callback({ code: "nope", state: "nope" }, "garbage");
    const all = JSON.stringify(t.audit) + t.env.logs.join("\n");
    for (const secret of [SECRET, g.code, idToken, "alice@example.com"]) expect(all).not.toContain(secret);
    expect(t.audit.find((e) => e.event === "login_ok")).toMatchObject({ reason: "google" });
    expect(t.audit.find((e) => e.event === "login_ok")!.sub).toMatch(/^u_[\w-]{22}$/);
    expect(t.audit.some((e) => e.event === "login_failed" && e.reason === "google_state")).toBe(true);
  });
});
