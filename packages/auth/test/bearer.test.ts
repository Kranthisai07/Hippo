import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { unauthorized } from "../src";
import { ISSUER, KEY, RESOURCE, START, b64url, bearer, fullTokens, makeEnv } from "./helpers";

const enc = (s: string) => new TextEncoder().encode(s);
const secs = START / 1000;

async function forge(
  over: {
    key?: string;
    iss?: string;
    aud?: string | string[];
    exp?: number;
    iat?: number;
    typ?: string;
    claims?: Record<string, unknown>;
    omit?: string[];
    alg?: "HS256" | "HS384";
  } = {},
): Promise<string> {
  const claims: Record<string, unknown> = { scope: "mcp:tools", householdId: "hh_forged", ...over.claims };
  const payload: Record<string, unknown> = {
    ...claims,
    sub: "u_x",
    iss: over.iss ?? ISSUER,
    aud: over.aud ?? RESOURCE,
    iat: over.iat ?? secs,
    exp: over.exp ?? secs + 900,
    jti: "j1",
  };
  for (const k of over.omit ?? []) delete payload[k];
  return new SignJWT(payload)
    .setProtectedHeader({ alg: over.alg ?? "HS256", typ: over.typ ?? "at+jwt" })
    .sign(enc(over.key ?? KEY));
}

describe("verifyBearer: a good token", () => {
  it("accepts a forged-with-the-real-key token (control for the negative cases)", async () => {
    const env = makeEnv();
    expect(await env.auth.verifyBearer(bearer(await forge()))).toEqual({
      householdId: "hh_forged",
      scope: "mcp:tools",
    });
  });

  it("accepts the scheme in any letter case (RFC 7235)", async () => {
    const env = makeEnv();
    const t = await forge();
    expect(await env.auth.verifyBearer(`bearer ${t}`)).not.toBeNull();
    expect(await env.auth.verifyBearer(`BEARER ${t}`)).not.toBeNull();
  });

  it("accepts the audience with a trailing slash", async () => {
    const env = makeEnv();
    expect(await env.auth.verifyBearer(bearer(await forge({ aud: RESOURCE + "/" })))).not.toBeNull();
  });

  it("is valid until exp and not after (injected clock)", async () => {
    const env = makeEnv();
    const { body } = await fullTokens(env);
    env.clock.t += 899_000;
    expect(await env.auth.verifyBearer(bearer(body.access_token!))).not.toBeNull();
    env.clock.t += 2_000;
    expect(await env.auth.verifyBearer(bearer(body.access_token!))).toBeNull();
  });
});

describe("verifyBearer: header handling", () => {
  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["scheme only", "Bearer"],
    ["scheme and space", "Bearer "],
    ["basic scheme", "Basic dXNlcjpwYXNz"],
    ["no scheme", "abc.def.ghi"],
    ["token scheme", "Token abc.def.ghi"],
    ["double space", "Bearer  abc.def.ghi"],
    ["two tokens", "Bearer a.b.c, Bearer d.e.f"],
    ["control chars", "Bearer abc\r\nX-Evil: 1"],
    ["quotes", 'Bearer "abc.def.ghi"'],
    ["huge", "Bearer " + "a".repeat(5000)],
    ["null byte", "Bearer abc\u0000def"],
    ["unicode", "Bearer abc‮def"],
  ])("returns null for %s", async (_n, h) => {
    const env = makeEnv();
    expect(await env.auth.verifyBearer(h)).toBeNull();
  });

  it("returns null for a garbage token", async () => {
    const env = makeEnv();
    expect(await env.auth.verifyBearer("Bearer not.a.jwt")).toBeNull();
    expect(await env.auth.verifyBearer("Bearer a.b")).toBeNull();
  });

  it("ignores a token placed in the query string", async () => {
    const env = makeEnv();
    const { body } = await fullTokens(env);
    const viaQuery = new Request(`https://x/mcp?access_token=${body.access_token}`);
    expect(await env.auth.verifyRequest(viaQuery)).toBeNull();
    const viaForm = new Request("https://x/mcp", { method: "POST", body: `access_token=${body.access_token}` });
    expect(await env.auth.verifyRequest(viaForm)).toBeNull();
    const viaHeader = new Request("https://x/mcp", { headers: { authorization: bearer(body.access_token!) } });
    expect(await env.auth.verifyRequest(viaHeader)).not.toBeNull();
  });

  it("ignores a token in a cookie", async () => {
    const env = makeEnv();
    const { body } = await fullTokens(env);
    expect(
      await env.auth.verifyRequest(new Request("https://x/mcp", { headers: { cookie: `token=${body.access_token}` } })),
    ).toBeNull();
  });
});

describe("verifyBearer: invalid tokens", () => {
  it("rejects a token signed with another key", async () => {
    const env = makeEnv();
    expect(
      await env.auth.verifyBearer(bearer(await forge({ key: "another-key-another-key-another-key-123" }))),
    ).toBeNull();
  });

  it("rejects a tampered payload (household swapped, signature kept)", async () => {
    const env = makeEnv();
    const { body } = await fullTokens(env);
    const [h, p, s] = body.access_token!.split(".");
    const payload = JSON.parse(Buffer.from(p!, "base64url").toString());
    payload.householdId = "hh_victim";
    const tampered = [h, b64url(enc(JSON.stringify(payload))), s].join(".");
    expect(await env.auth.verifyBearer(bearer(tampered))).toBeNull();
  });

  it("rejects a flipped signature byte", async () => {
    const env = makeEnv();
    const { body } = await fullTokens(env);
    const t = body.access_token!;
    const flipped = t.slice(0, -2) + (t.endsWith("AA") ? "BB" : "AA");
    expect(await env.auth.verifyBearer(bearer(flipped))).toBeNull();
  });

  it("rejects alg=none", async () => {
    const env = makeEnv();
    const header = b64url(enc(JSON.stringify({ alg: "none", typ: "at+jwt" })));
    const payload = b64url(
      enc(
        JSON.stringify({
          sub: "u",
          householdId: "hh_x",
          scope: "mcp:tools",
          iss: ISSUER,
          aud: RESOURCE,
          iat: secs,
          exp: secs + 900,
          jti: "j",
        }),
      ),
    );
    expect(await env.auth.verifyBearer(bearer(`${header}.${payload}.`))).toBeNull();
    expect(await env.auth.verifyBearer(bearer(`${header}.${payload}`))).toBeNull();
    expect(await env.auth.verifyBearer(bearer(`${header}.${payload}.AAAA`))).toBeNull();
  });

  it("rejects other algorithms even with the right key (HS384)", async () => {
    const env = makeEnv();
    expect(await env.auth.verifyBearer(bearer(await forge({ alg: "HS384" })))).toBeNull();
  });

  it("rejects an expired token", async () => {
    const env = makeEnv();
    expect(await env.auth.verifyBearer(bearer(await forge({ exp: secs - 1, iat: secs - 901 })))).toBeNull();
  });

  it("rejects a token issued in the future", async () => {
    const env = makeEnv();
    expect(await env.auth.verifyBearer(bearer(await forge({ iat: secs + 3600, exp: secs + 4500 })))).toBeNull();
  });

  it.each([
    ["other audience", { aud: "https://evil.example/mcp" }],
    ["audience is the issuer", { aud: ISSUER }],
    ["audience case", { aud: "https://api.hippo.test/MCP" }],
  ])("rejects %s", async (_n, over) => {
    const env = makeEnv();
    expect(await env.auth.verifyBearer(bearer(await forge(over)))).toBeNull();
  });

  it("rejects the wrong issuer", async () => {
    const env = makeEnv();
    expect(await env.auth.verifyBearer(bearer(await forge({ iss: "https://evil.example" })))).toBeNull();
  });

  it("rejects a token with the wrong typ (an ID token style JWT)", async () => {
    const env = makeEnv();
    expect(await env.auth.verifyBearer(bearer(await forge({ typ: "JWT" })))).toBeNull();
  });

  it.each(["sub", "exp", "iat", "jti", "iss", "aud", "scope"])("rejects a token missing %s", async (claim) => {
    const env = makeEnv();
    expect(await env.auth.verifyBearer(bearer(await forge({ omit: [claim] })))).toBeNull();
  });

  it.each([
    ["empty household", { householdId: "" }],
    ["numeric household", { householdId: 5 }],
    ["object household", { householdId: { id: "x" } }],
    ["numeric scope", { scope: 5 }],
  ])("rejects %s", async (_n, claims) => {
    const env = makeEnv();
    expect(await env.auth.verifyBearer(bearer(await forge({ claims })))).toBeNull();
  });

  it("a service token (no household) never authenticates a user", async () => {
    const env = makeEnv();
    expect(
      await env.auth.verifyBearer(bearer(await forge({ omit: ["householdId"], claims: { scope: "mcp:service" } }))),
    ).toBeNull();
  });

  it("a refresh token is not a bearer", async () => {
    const env = makeEnv();
    const { body } = await fullTokens(env);
    expect(await env.auth.verifyBearer(bearer(body.refresh_token!))).toBeNull();
  });
});

describe("unauthorized()", () => {
  it("is a bare 401 with no WWW-Authenticate", async () => {
    const r = unauthorized();
    expect(r.status).toBe(401);
    expect(r.headers.has("www-authenticate")).toBe(false);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("does not leak details in its body", async () => {
    expect(await unauthorized().json()).toEqual({ error: "unauthorized" });
  });
});

describe("configuration", () => {
  it("refuses a short signing key", () => {
    expect(() => makeEnv({ signingKey: "short" })).toThrow(/32 bytes/);
    expect(() => makeEnv({ signingKey: new Uint8Array(16) })).toThrow(/32 bytes/);
  });

  it("accepts a Uint8Array key", async () => {
    const env = makeEnv({ signingKey: crypto.getRandomValues(new Uint8Array(32)) });
    const { body } = await fullTokens(env);
    expect(await env.auth.verifyBearer(bearer(body.access_token!))).not.toBeNull();
  });

  it("tokens from one key do not verify under another", async () => {
    const a = makeEnv({ signingKey: "a".repeat(40) });
    const b = makeEnv({ signingKey: "b".repeat(40) });
    const { body } = await fullTokens(a);
    expect(await b.auth.verifyBearer(bearer(body.access_token!))).toBeNull();
  });

  it("the signing key never appears in logs or responses", async () => {
    const env = makeEnv();
    const { res, body } = await fullTokens(env);
    expect(JSON.stringify(env.logs)).not.toContain(KEY);
    expect(JSON.stringify(body)).not.toContain(KEY);
    expect(res.headers.get("set-cookie") ?? "").not.toContain(KEY);
  });

  it("logs contain no access, refresh or authorization code values", async () => {
    const env = makeEnv();
    const { body, code } = await fullTokens(env);
    const all = env.logs.join("\n");
    for (const secret of [body.access_token!, body.refresh_token!, code]) expect(all).not.toContain(secret);
  });
});
