import { SignJWT, UnsecuredJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from "jose";
import { describe, expect, it, vi } from "vitest";
import {
  GOOGLE,
  derivePendingKey,
  exchangeCode,
  googleAuthUrl,
  googleKeys,
  readPending,
  safeReturnTo,
  signPending,
  verifyIdToken,
  type GoogleOptions,
  type Pending,
} from "../src/google";
import { keyBytes, signAccess } from "../src/tokens";
import { KEY } from "./helpers";

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const SEC = Math.floor(NOW / 1000);
const CLIENT_ID = "1234-test.apps.googleusercontent.com";
const NONCE = "nonce-nonce-nonce-nonce-nonce-nonce-0";

async function makeGoogle() {
  const good = await generateKeyPair("RS256", { extractable: true });
  const other = await generateKeyPair("RS256", { extractable: true });
  const jwk: JWK = { ...(await exportJWK(good.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const keys = createLocalJWKSet({ keys: [jwk] });
  const o: GoogleOptions = { clientId: CLIENT_ID, clientSecret: "client-secret-value", jwks: keys };
  const idToken = (claims: Record<string, unknown> = {}, over: { key?: CryptoKey; alg?: string; kid?: string } = {}) =>
    new SignJWT({
      email: "alice@example.com",
      email_verified: true,
      nonce: NONCE,
      ...claims,
    })
      .setProtectedHeader({ alg: over.alg ?? "RS256", kid: over.kid ?? "k1" })
      .setIssuer("https://accounts.google.com")
      .setAudience(CLIENT_ID)
      .setSubject("google-sub-1")
      .setIssuedAt(SEC)
      .setExpirationTime(SEC + 3600)
      .sign(over.key ?? good.privateKey);
  return { o, keys, idToken, good, other };
}

const verify = (t: Awaited<ReturnType<typeof makeGoogle>>, jwt: string, nowMs = NOW) =>
  verifyIdToken(t.o, t.keys, jwt, { nonce: NONCE, nowMs });

describe("googleAuthUrl", () => {
  it("asks for openid and email only, with state, nonce and an S256 challenge, and no secret", async () => {
    const url = new URL(
      await googleAuthUrl(
        { clientId: CLIENT_ID, clientSecret: "client-secret-value" },
        {
          redirectUri: "https://api.hippo.test/oauth/google/callback",
          gstate: "st",
          nonce: "nn",
          verifier: "v".repeat(43),
        },
      ),
    );
    expect(`${url.origin}${url.pathname}`).toBe(GOOGLE.auth);
    const q = url.searchParams;
    expect(q.get("client_id")).toBe(CLIENT_ID);
    expect(q.get("redirect_uri")).toBe("https://api.hippo.test/oauth/google/callback");
    expect(q.get("response_type")).toBe("code");
    expect(q.get("scope")).toBe("openid email");
    expect(q.get("state")).toBe("st");
    expect(q.get("nonce")).toBe("nn");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    expect(url.toString()).not.toContain("client-secret-value");
    expect(url.toString()).not.toContain("v".repeat(43));
  });
});

describe("the pending cookie", () => {
  const pending: Pending = {
    mode: "authorize",
    params: { client_id: "c", redirect_uri: "https://x.example/cb", state: "s1" },
    gstate: "g-state",
    nonce: "g-nonce",
    verifier: "g-verifier",
  };

  it("round trips, and is valid for ten minutes", async () => {
    const key = await derivePendingKey(keyBytes(KEY));
    const jwt = await signPending(key, pending, NOW);
    expect(await readPending(key, jwt, NOW + 599_000)).toEqual(pending);
    expect(await readPending(key, jwt, NOW + 601_000)).toBeNull();
  });
  it("keeps a return address for a web sign in", async () => {
    const key = await derivePendingKey(keyBytes(KEY));
    const jwt = await signPending(
      key,
      { mode: "session", returnTo: "https://app.hippo.test/review/doc-1", gstate: "a", nonce: "b", verifier: "c" },
      NOW,
    );
    expect(await readPending(key, jwt, NOW)).toMatchObject({
      mode: "session",
      returnTo: "https://app.hippo.test/review/doc-1",
    });
  });
  it.each([
    ["nothing", undefined],
    ["an empty string", ""],
    ["garbage", "not.a.jwt"],
  ])("refuses %s", async (_n, jwt) => {
    expect(await readPending(await derivePendingKey(keyBytes(KEY)), jwt, NOW)).toBeNull();
  });
  it("refuses a changed cookie and one made with another key", async () => {
    const key = await derivePendingKey(keyBytes(KEY));
    const jwt = await signPending(key, pending, NOW);
    const parts = jwt.split(".");
    const flipped = `${parts[0]}.${parts[1]}.${parts[2]!.slice(0, -2)}${parts[2]!.endsWith("AA") ? "BB" : "AA"}`;
    expect(await readPending(key, flipped, NOW)).toBeNull();
    const otherKey = await derivePendingKey(keyBytes("another-signing-key-another-signing-key-01"));
    expect(await readPending(otherKey, jwt, NOW)).toBeNull();
  });
  it("refuses a cookie with every claim right but the wrong type or the wrong audience", async () => {
    const key = await derivePendingKey(keyBytes(KEY));
    const claims = { m: "authorize", s: "g", n: "n", v: "v" };
    const make = (typ: string, aud: string) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "HS256", typ })
        .setAudience(aud)
        .setIssuedAt(SEC)
        .setExpirationTime(SEC + 600)
        .sign(key);
    expect(await readPending(key, await make("hippo-google+jwt", "hippo-google-pending"), NOW)).not.toBeNull();
    expect(await readPending(key, await make("at+jwt", "hippo-google-pending"), NOW)).toBeNull();
    expect(await readPending(key, await make("hippo-google+jwt", "https://api.hippo.test/mcp"), NOW)).toBeNull();
  });
  it("is not an access token, and an access token is not a pending cookie", async () => {
    const signing = keyBytes(KEY);
    const key = await derivePendingKey(signing);
    expect(key).not.toEqual(signing);
    const access = await signAccess(
      signing,
      { sub: "u", householdId: "h", scope: "mcp:tools", clientId: "c" },
      {
        issuer: "https://api.hippo.test",
        audience: "https://api.hippo.test/mcp",
        nowMs: NOW,
        ttlSec: 900,
        jti: "j",
      },
    );
    expect(await readPending(key, access, NOW)).toBeNull();
    expect(await readPending(signing, await signPending(signing, pending, NOW), NOW)).not.toBeNull(); // sanity: same key reads it
    // A pending cookie made with the raw signing key must not verify as an access token (wrong typ and audience).
    const asAccess = await signPending(signing, pending, NOW);
    const { verifyAccess } = await import("../src/tokens");
    expect(
      await verifyAccess(signing, asAccess, {
        issuer: "https://api.hippo.test",
        audiences: ["https://api.hippo.test/mcp"],
        now: new Date(NOW),
      }),
    ).toBeNull();
  });
});

describe("verifyIdToken", () => {
  it("accepts a good token and gives the id and the email", async () => {
    const t = await makeGoogle();
    expect(await verify(t, await t.idToken())).toEqual({ sub: "google-sub-1", email: "alice@example.com" });
  });
  it("accepts the second form of the issuer", async () => {
    const t = await makeGoogle();
    const jwt = await new SignJWT({ email: "a@example.com", email_verified: true, nonce: NONCE })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer("accounts.google.com")
      .setAudience(CLIENT_ID)
      .setSubject("s")
      .setIssuedAt(SEC)
      .setExpirationTime(SEC + 3600)
      .sign(t.good.privateKey);
    expect(await verify(t, jwt)).not.toBeNull();
  });
  it.each([
    ["a wrong nonce", { nonce: "someone-elses-nonce" }],
    ["email_verified false", { email_verified: false }],
    ["email_verified as the string true", { email_verified: "true" }],
    ["email_verified missing", { email_verified: undefined }],
    ["no email", { email: undefined }],
    ["an email that is not text", { email: 42 }],
    ["no nonce", { nonce: undefined }],
  ])("refuses %s", async (_n, claims) => {
    const t = await makeGoogle();
    expect(await verify(t, await t.idToken(claims))).toBeNull();
  });
  it("refuses another audience, another issuer and an expired token, with a 30 second tolerance", async () => {
    const t = await makeGoogle();
    const make = (f: (j: SignJWT) => SignJWT) =>
      f(
        new SignJWT({ email: "a@example.com", email_verified: true, nonce: NONCE })
          .setProtectedHeader({ alg: "RS256", kid: "k1" })
          .setIssuer("https://accounts.google.com")
          .setAudience(CLIENT_ID)
          .setSubject("s")
          .setIssuedAt(SEC)
          .setExpirationTime(SEC + 3600),
      ).sign(t.good.privateKey);
    expect(await verify(t, await make((j) => j.setAudience("someone-elses-client")))).toBeNull();
    expect(await verify(t, await make((j) => j.setIssuer("https://evil.example")))).toBeNull();
    expect(await verify(t, await make((j) => j.setExpirationTime(SEC - 60)))).toBeNull();
    expect(await verify(t, await make((j) => j.setExpirationTime(SEC - 10)))).not.toBeNull();
  });
  it("refuses a token signed with another key, one with no signature, and one whose algorithm is swapped", async () => {
    const t = await makeGoogle();
    expect(await verify(t, await t.idToken({}, { key: t.other.privateKey }))).toBeNull();
    const unsecured = new UnsecuredJWT({ email: "a@example.com", email_verified: true, nonce: NONCE })
      .setIssuer("https://accounts.google.com")
      .setAudience(CLIENT_ID)
      .setSubject("s")
      .setIssuedAt(SEC)
      .setExpirationTime(SEC + 3600)
      .encode();
    expect(await verify(t, unsecured)).toBeNull();
    // HS256 with the public key as the secret: the classic key confusion. The algorithm is pinned to RS256.
    const publicJwk = JSON.stringify(await exportJWK(t.good.publicKey));
    const hs = await new SignJWT({ email: "a@example.com", email_verified: true, nonce: NONCE })
      .setProtectedHeader({ alg: "HS256", kid: "k1" })
      .setIssuer("https://accounts.google.com")
      .setAudience(CLIENT_ID)
      .setSubject("s")
      .setIssuedAt(SEC)
      .setExpirationTime(SEC + 3600)
      .sign(new TextEncoder().encode(publicJwk.padEnd(32, "x")));
    expect(await verify(t, hs)).toBeNull();
  });
  it("refuses an HS256 token even when whoever resolves the key hands out a symmetric secret (the algorithm is pinned)", async () => {
    const t = await makeGoogle();
    const secret = new TextEncoder().encode("a-shared-secret-of-at-least-32-bytes!");
    const hs = await new SignJWT({ email: "a@example.com", email_verified: true, nonce: NONCE })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("https://accounts.google.com")
      .setAudience(CLIENT_ID)
      .setSubject("s")
      .setIssuedAt(SEC)
      .setExpirationTime(SEC + 3600)
      .sign(secret);
    const confused = async () => secret;
    expect(await verifyIdToken(t.o, confused as never, hs, { nonce: NONCE, nowMs: NOW })).toBeNull();
  });
  it("refuses a token whose key id Google does not publish, and plain garbage", async () => {
    const t = await makeGoogle();
    expect(await verify(t, await t.idToken({}, { kid: "unknown" }))).toBeNull();
    expect(await verify(t, "x.y.z")).toBeNull();
    expect(await verify(t, "")).toBeNull();
  });
  it("builds the check of Google's real keys without fetching anything until it is used", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      expect(typeof googleKeys({ clientId: CLIENT_ID, clientSecret: "x" })).toBe("function");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("exchangeCode", () => {
  const args = {
    code: "the-code",
    redirectUri: "https://api.hippo.test/oauth/google/callback",
    verifier: "v".repeat(43),
  };
  const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it("sends the code, the secret, the verifier and the redirect address together, and gives back the ID token", async () => {
    let seen: { url: string; body: URLSearchParams; method: string } | undefined;
    const o: GoogleOptions = {
      clientId: CLIENT_ID,
      clientSecret: "client-secret-value",
      fetch: (async (url: string, init: RequestInit) => {
        seen = { url, body: init.body as URLSearchParams, method: init.method! };
        return jsonResponse({ id_token: "the.id.token", access_token: "ignored" });
      }) as typeof fetch,
    };
    expect(await exchangeCode(o, args)).toBe("the.id.token");
    expect(seen!.url).toBe(GOOGLE.token);
    expect(seen!.method).toBe("POST");
    expect(Object.fromEntries(seen!.body)).toEqual({
      grant_type: "authorization_code",
      code: "the-code",
      client_id: CLIENT_ID,
      client_secret: "client-secret-value",
      redirect_uri: args.redirectUri,
      code_verifier: args.verifier,
    });
  });
  it.each([
    ["an error status", () => jsonResponse({ error: "invalid_grant" }, 400)],
    ["a server error", () => jsonResponse({}, 500)],
    ["text that is not JSON", () => new Response("<html>nope</html>", { status: 200 })],
    ["JSON with no id_token", () => jsonResponse({ access_token: "x" })],
    ["an id_token that is not text", () => jsonResponse({ id_token: 7 })],
    ["an empty id_token", () => jsonResponse({ id_token: "" })],
    ["an oversized id_token", () => jsonResponse({ id_token: "a".repeat(9000) })],
    ["an oversized body", () => new Response("a".repeat(30_000), { status: 200 })],
  ])("gives null for %s", async (_n, make) => {
    const o: GoogleOptions = {
      clientId: CLIENT_ID,
      clientSecret: "s",
      fetch: (async () => make()) as unknown as typeof fetch,
    };
    expect(await exchangeCode(o, args)).toBeNull();
  });
  it("gives null when the request fails or never answers, within the timeout", async () => {
    const down: GoogleOptions = {
      clientId: CLIENT_ID,
      clientSecret: "s",
      fetch: (async () => {
        throw new TypeError("network");
      }) as unknown as typeof fetch,
    };
    expect(await exchangeCode(down, args)).toBeNull();
    const hung: GoogleOptions = {
      clientId: CLIENT_ID,
      clientSecret: "s",
      timeoutMs: 50,
      fetch: ((_u: string, init: RequestInit) =>
        new Promise((_res, rej) =>
          init.signal!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))),
        )) as unknown as typeof fetch,
    };
    const started = Date.now();
    expect(await exchangeCode(hung, args)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("safeReturnTo", () => {
  const own = "https://api.hippo.test";
  const allowed = new Set(["https://api.hippo.test", "https://app.hippo.test"]);

  it.each([
    ["/review/doc-1", "https://api.hippo.test/review/doc-1"],
    ["/", "https://api.hippo.test/"],
    ["/coming-up?x=1", "https://api.hippo.test/coming-up?x=1"],
    ["https://app.hippo.test/review/doc-1#frag", "https://app.hippo.test/review/doc-1"],
  ])("accepts %s", (raw, out) => {
    expect(safeReturnTo(raw, own, allowed)).toBe(out);
  });
  it.each([
    ["nothing", undefined],
    ["a protocol relative address", "//evil.example/x"],
    ["a backslash trick", "/\\evil.example"],
    ["a backslash host", "\\\\evil.example"],
    ["another origin", "https://evil.example/x"],
    ["a look alike origin", "https://app.hippo.test.evil.example/x"],
    ["credentials in front", "https://app.hippo.test@evil.example/x"],
    ["credentials on an allowed origin", "https://user:pw@app.hippo.test/x"],
    ["a script address", "javascript:alert(1)"],
    ["a data address", "data:text/html,hi"],
    ["a control character", "/ok\n/evil"],
    ["a plain http copy of an https origin", "http://app.hippo.test/x"],
    ["something very long", "/" + "a".repeat(3000)],
  ])("refuses %s", (_n, raw) => {
    expect(safeReturnTo(raw as string | undefined, own, allowed)).toBeNull();
  });
});
