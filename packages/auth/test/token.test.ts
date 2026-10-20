import { describe, expect, it } from "vitest";
import { decodeJwt, decodeProtectedHeader } from "jose";
import {
  REDIRECT,
  RESOURCE,
  authzParams,
  bearer,
  codeGrant,
  fullTokens,
  getCode,
  makeEnv,
  openAuthorize,
  pkce,
  postAuthorize,
  refreshGrant,
  tokenReq,
} from "./helpers";

const err = async (res: Response) => ((await res.json()) as { error: string }).error;

describe("authorization_code grant: success shape", () => {
  it("returns no-store, Bearer, 900s, a refresh token and the granted scope", async () => {
    const env = makeEnv();
    const { res, body } = await fullTokens(env, { scope: "mcp:tools mcp:resources" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("pragma")).toBe("no-cache");
    expect(body.token_type).toBe("Bearer");
    expect(body.scope).toBe("mcp:tools mcp:resources");
    expect(body.refresh_token).toBeTruthy();
    expect(body.refresh_token).not.toBe(body.access_token);
  });

  it("the access token carries sub, householdId, scope, aud, iss, exp, jti", async () => {
    const env = makeEnv();
    const { body } = await fullTokens(env);
    const c = decodeJwt(body.access_token!);
    expect(decodeProtectedHeader(body.access_token!)).toEqual({ alg: "HS256", typ: "at+jwt" });
    expect(c.sub).toMatch(/^u_/);
    expect(c.householdId).toBe("hh_demo");
    expect(c.scope).toBe("mcp:tools");
    expect(c.aud).toBe(RESOURCE);
    expect(c.iss).toBe("https://api.hippo.test");
    expect(c.jti).toBeTruthy();
    expect(c.exp! - c.iat!).toBe(900);
  });

  it("the token does not contain the email", async () => {
    const env = makeEnv();
    const { body } = await fullTokens(env);
    expect(JSON.stringify(decodeJwt(body.access_token!))).not.toContain("demo@hippo.test");
  });

  it("each token has a unique jti", async () => {
    const env = makeEnv();
    const a = decodeJwt((await fullTokens(env)).body.access_token!);
    const b = decodeJwt((await fullTokens(env)).body.access_token!);
    expect(a.jti).not.toBe(b.jti);
  });

  it("the audience is the resource without a slash even if the client sent a trailing slash", async () => {
    const env = makeEnv();
    const { verifier, challenge } = await pkce();
    const { code } = await getCode(env, authzParams(challenge, { resource: RESOURCE + "/" }));
    const res = await tokenReq(env, codeGrant(code, verifier, { resource: RESOURCE }));
    expect(res.status).toBe(200);
    expect(decodeJwt(((await res.json()) as { access_token: string }).access_token).aud).toBe(RESOURCE);
  });

  it("accepts the token request resource with a trailing slash when the code was bound without one", async () => {
    const env = makeEnv();
    const { verifier, challenge } = await pkce();
    const { code } = await getCode(env, authzParams(challenge));
    expect((await tokenReq(env, codeGrant(code, verifier, { resource: RESOURCE + "/" }))).status).toBe(200);
  });

  it("household id comes from the server mapping for the logged in email", async () => {
    const env = makeEnv({ resolveHousehold: (e) => "H:" + e.toUpperCase() });
    const { body } = await fullTokens(env);
    expect(decodeJwt(body.access_token!).householdId).toBe("H:DEMO@HIPPO.TEST");
  });
});

describe("authorization_code grant: PKCE", () => {
  it("rejects a wrong code_verifier (S256 mismatch)", async () => {
    const env = makeEnv();
    const { challenge } = await pkce();
    const other = await pkce();
    const { code } = await getCode(env, authzParams(challenge));
    const res = await tokenReq(env, codeGrant(code, other.verifier));
    expect(res.status).toBe(400);
    expect(await err(res)).toBe("invalid_grant");
  });

  it("rejects the challenge itself used as the verifier (plain style downgrade)", async () => {
    const env = makeEnv();
    const { challenge } = await pkce();
    const { code } = await getCode(env, authzParams(challenge));
    const res = await tokenReq(env, codeGrant(code, challenge));
    expect(await err(res)).toBe("invalid_grant");
  });

  it("rejects a missing code_verifier", async () => {
    const env = makeEnv();
    const { challenge } = await pkce();
    const { code } = await getCode(env, authzParams(challenge));
    const res = await tokenReq(env, codeGrant(code, "x", { code_verifier: undefined }));
    expect(res.status).toBe(400);
    expect(await err(res)).toBe("invalid_request");
  });

  it.each(["short", "a".repeat(129), "a".repeat(43) + "!", "a".repeat(43) + " ", ""])(
    "rejects malformed verifier %j",
    async (v) => {
      const env = makeEnv();
      const { challenge } = await pkce();
      const { code } = await getCode(env, authzParams(challenge));
      const res = await tokenReq(env, codeGrant(code, v));
      expect(res.status).toBe(400);
    },
  );

  it("a failed PKCE attempt still burns the code", async () => {
    const env = makeEnv();
    const { verifier, challenge } = await pkce();
    const { code } = await getCode(env, authzParams(challenge));
    await tokenReq(env, codeGrant(code, (await pkce()).verifier));
    const res = await tokenReq(env, codeGrant(code, verifier));
    expect(res.status).toBe(400);
  });
});

describe("authorization_code grant: resource", () => {
  it("requires resource on the token request", async () => {
    const env = makeEnv();
    const { verifier, challenge } = await pkce();
    const { code } = await getCode(env, authzParams(challenge));
    const res = await tokenReq(env, codeGrant(code, verifier, { resource: undefined }));
    expect(res.status).toBe(400);
    expect(await err(res)).toBe("invalid_target");
  });

  it.each(["https://evil.example/mcp", "https://api.hippo.test/other", "", "https://api.hippo.test/MCP"])(
    "rejects wrong resource %j",
    async (resource) => {
      const env = makeEnv();
      const { verifier, challenge } = await pkce();
      const { code } = await getCode(env, authzParams(challenge));
      const res = await tokenReq(env, codeGrant(code, verifier, { resource }));
      expect(await err(res)).toBe("invalid_target");
    },
  );
});

describe("authorization_code grant: code binding", () => {
  it("a code is single use", async () => {
    const env = makeEnv();
    const { verifier, challenge } = await pkce();
    const { code } = await getCode(env, authzParams(challenge));
    expect((await tokenReq(env, codeGrant(code, verifier))).status).toBe(200);
    const again = await tokenReq(env, codeGrant(code, verifier));
    expect(again.status).toBe(400);
    expect(await err(again)).toBe("invalid_grant");
  });

  it("replaying a used code revokes the refresh token it produced", async () => {
    const env = makeEnv();
    const { verifier, challenge } = await pkce();
    const { code } = await getCode(env, authzParams(challenge));
    const first = (await (await tokenReq(env, codeGrant(code, verifier))).json()) as Record<string, string>;
    await tokenReq(env, codeGrant(code, verifier));
    const r = await tokenReq(env, refreshGrant(first.refresh_token!));
    expect(r.status).toBe(400);
  });

  it("an expired code (injected clock) is refused at 60 seconds", async () => {
    const env = makeEnv();
    const { verifier, challenge } = await pkce();
    const { code } = await getCode(env, authzParams(challenge));
    env.clock.t += 60_000;
    const res = await tokenReq(env, codeGrant(code, verifier));
    expect(await err(res)).toBe("invalid_grant");
  });

  it("a code is still good at 59 seconds", async () => {
    const env = makeEnv();
    const { verifier, challenge } = await pkce();
    const { code } = await getCode(env, authzParams(challenge));
    env.clock.t += 59_000;
    expect((await tokenReq(env, codeGrant(code, verifier))).status).toBe(200);
  });

  it("a code bound to another redirect_uri is refused", async () => {
    const env = makeEnv();
    const { verifier, challenge } = await pkce();
    const { code } = await getCode(env, authzParams(challenge));
    const res = await tokenReq(env, codeGrant(code, verifier, { redirect_uri: "https://alexa.example/other" }));
    expect(await err(res)).toBe("invalid_grant");
  });

  it.each([REDIRECT + "/", REDIRECT + "?a=1", "https://evil.example/cb", ""])(
    "token redirect_uri near miss %j",
    async (uri) => {
      const env = makeEnv();
      const { verifier, challenge } = await pkce();
      const { code } = await getCode(env, authzParams(challenge));
      const res = await tokenReq(env, codeGrant(code, verifier, { redirect_uri: uri }));
      expect(res.status).toBe(400);
    },
  );

  it("a missing redirect_uri on the token request is refused", async () => {
    const env = makeEnv();
    const { verifier, challenge } = await pkce();
    const { code } = await getCode(env, authzParams(challenge));
    const res = await tokenReq(env, codeGrant(code, verifier, { redirect_uri: undefined }));
    expect(res.status).toBe(400);
  });

  it("a code bound to another client is refused", async () => {
    const env = makeEnv({
      clients: [
        { clientId: "alexa", redirectUris: [REDIRECT] },
        { clientId: "other", redirectUris: [REDIRECT] },
      ],
    });
    const { verifier, challenge } = await pkce();
    const { code } = await getCode(env, authzParams(challenge));
    const res = await tokenReq(env, codeGrant(code, verifier, { client_id: "other" }));
    expect(await err(res)).toBe("invalid_grant");
  });

  it("an unknown client is invalid_client with 401", async () => {
    const env = makeEnv();
    const { verifier, challenge } = await pkce();
    const { code } = await getCode(env, authzParams(challenge));
    const res = await tokenReq(env, codeGrant(code, verifier, { client_id: "nobody" }));
    expect(res.status).toBe(401);
    expect(await err(res)).toBe("invalid_client");
  });

  it("a missing client_id is invalid_client", async () => {
    const env = makeEnv();
    const { verifier, challenge } = await pkce();
    const { code } = await getCode(env, authzParams(challenge));
    const res = await tokenReq(env, codeGrant(code, verifier, { client_id: undefined }));
    expect(res.status).toBe(401);
  });

  it.each(["", "garbage", "a".repeat(500), undefined])("an unknown code %j", async (code) => {
    const env = makeEnv();
    const { verifier } = await pkce();
    const res = await tokenReq(env, codeGrant(code as string, verifier));
    expect(res.status).toBe(400);
  });

  it("the 401 from the token endpoint has no WWW-Authenticate", async () => {
    const env = makeEnv();
    const res = await tokenReq(env, { grant_type: "authorization_code", client_id: "nobody" });
    expect(res.status).toBe(401);
    expect(res.headers.has("www-authenticate")).toBe(false);
  });
});

describe("refresh_token grant", () => {
  it("issues a new pair, rotates, and keeps the household", async () => {
    const env = makeEnv();
    const { body } = await fullTokens(env);
    const res = await tokenReq(env, refreshGrant(body.refresh_token!));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const b = (await res.json()) as Record<string, string>;
    expect(b.refresh_token).toBeTruthy();
    expect(b.refresh_token).not.toBe(body.refresh_token);
    expect(await env.auth.verifyBearer(bearer(b.access_token!))).toEqual({
      householdId: "hh_demo",
      scope: "mcp:tools",
    });
  });

  it("does not need the resource parameter", async () => {
    const env = makeEnv();
    const { body } = await fullTokens(env);
    expect((await tokenReq(env, refreshGrant(body.refresh_token!))).status).toBe(200);
  });

  it("a wrong resource, if sent, is refused", async () => {
    const env = makeEnv();
    const { body } = await fullTokens(env);
    const res = await tokenReq(env, refreshGrant(body.refresh_token!, { resource: "https://evil.example/mcp" }));
    expect(await err(res)).toBe("invalid_target");
  });

  it("the old token is invalid after use", async () => {
    const env = makeEnv();
    const { body } = await fullTokens(env);
    await tokenReq(env, refreshGrant(body.refresh_token!));
    expect((await tokenReq(env, refreshGrant(body.refresh_token!))).status).toBe(400);
  });

  it("reuse of a used token revokes the whole family including the newest token", async () => {
    const env = makeEnv();
    const { body } = await fullTokens(env);
    const second = (await (await tokenReq(env, refreshGrant(body.refresh_token!))).json()) as Record<string, string>;
    const third = (await (await tokenReq(env, refreshGrant(second.refresh_token!))).json()) as Record<string, string>;
    expect((await tokenReq(env, refreshGrant(body.refresh_token!))).status).toBe(400); // reuse
    expect((await tokenReq(env, refreshGrant(third.refresh_token!))).status).toBe(400); // family is dead
  });

  it("revoking one family does not touch another", async () => {
    const env = makeEnv();
    const a = (await fullTokens(env)).body;
    const b = (await fullTokens(env)).body;
    await tokenReq(env, refreshGrant(a.refresh_token!));
    await tokenReq(env, refreshGrant(a.refresh_token!)); // reuse kills family a
    expect((await tokenReq(env, refreshGrant(b.refresh_token!))).status).toBe(200);
  });

  it("an expired refresh token is refused", async () => {
    const env = makeEnv();
    const { body } = await fullTokens(env);
    env.clock.t += 31 * 24 * 3600_000;
    expect((await tokenReq(env, refreshGrant(body.refresh_token!))).status).toBe(400);
  });

  it("a refresh token for another client is refused and kills the family", async () => {
    const env = makeEnv({
      clients: [
        { clientId: "alexa", redirectUris: [REDIRECT] },
        { clientId: "other", redirectUris: [REDIRECT] },
      ],
    });
    const { body } = await fullTokens(env);
    expect((await tokenReq(env, refreshGrant(body.refresh_token!, { client_id: "other" }))).status).toBe(400);
    expect((await tokenReq(env, refreshGrant(body.refresh_token!))).status).toBe(400);
  });

  it("scope can be narrowed but not widened", async () => {
    const env = makeEnv();
    const { body } = await fullTokens(env, { scope: "mcp:tools mcp:resources" });
    const narrow = await tokenReq(env, refreshGrant(body.refresh_token!, { scope: "mcp:tools" }));
    const nb = (await narrow.json()) as Record<string, string>;
    expect(nb.scope).toBe("mcp:tools");
    const wide = await tokenReq(env, refreshGrant(nb.refresh_token!, { scope: "mcp:tools mcp:resources" }));
    expect(await err(wide)).toBe("invalid_scope");
  });

  it("scope mcp:service cannot be obtained by refreshing", async () => {
    const env = makeEnv();
    const { body } = await fullTokens(env);
    const res = await tokenReq(env, refreshGrant(body.refresh_token!, { scope: "mcp:service" }));
    expect(await err(res)).toBe("invalid_scope");
  });

  it.each(["", "nope", "a".repeat(300), undefined])("garbage refresh token %j", async (rt) => {
    const env = makeEnv();
    expect((await tokenReq(env, refreshGrant(rt as string))).status).toBe(400);
  });

  it("an access token is not accepted as a refresh token", async () => {
    const env = makeEnv();
    const { body } = await fullTokens(env);
    expect((await tokenReq(env, refreshGrant(body.access_token!))).status).toBe(400);
  });
});

describe("client_credentials grant", () => {
  const cc = (over: Record<string, string | undefined> = {}) => ({
    grant_type: "client_credentials",
    client_id: "alexa-svc",
    client_secret: "svc-secret-value",
    resource: RESOURCE,
    ...over,
  });

  it("issues an mcp:service token with no refresh token that is not a user token", async () => {
    const env = makeEnv();
    const res = await tokenReq(env, cc());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const b = (await res.json()) as Record<string, string | number>;
    expect(b.scope).toBe("mcp:service");
    expect(b.refresh_token).toBeUndefined();
    expect(b.expires_in).toBeLessThanOrEqual(3600);
    expect(await env.auth.verifyServiceBearer(bearer(b.access_token as string))).toBe(true);
    expect(await env.auth.verifyBearer(bearer(b.access_token as string))).toBeNull();
    expect(decodeJwt(b.access_token as string).householdId).toBeUndefined();
  });

  it("works with HTTP Basic authentication", async () => {
    const env = makeEnv();
    const basic = "Basic " + Buffer.from("alexa-svc:svc-secret-value").toString("base64");
    const res = await tokenReq(env, cc({ client_id: undefined, client_secret: undefined }), { authorization: basic });
    expect(res.status).toBe(200);
  });

  it("refuses Basic plus body credentials together", async () => {
    const env = makeEnv();
    const basic = "Basic " + Buffer.from("alexa-svc:svc-secret-value").toString("base64");
    const res = await tokenReq(env, cc(), { authorization: basic });
    expect(res.status).toBe(400);
  });

  it.each([
    ["wrong secret", { client_secret: "nope" }],
    ["missing secret", { client_secret: undefined }],
    ["wrong client", { client_id: "alexa" }],
  ])("%s is invalid_client", async (_n, over) => {
    const env = makeEnv();
    const res = await tokenReq(env, cc(over));
    expect(res.status).toBe(401);
    expect(await err(res)).toBe("invalid_client");
  });

  it("is invalid_client when no serviceClient is configured", async () => {
    const env = makeEnv({ serviceClient: undefined });
    expect((await tokenReq(env, cc())).status).toBe(401);
  });

  it("requires a matching resource", async () => {
    const env = makeEnv();
    expect(await err(await tokenReq(env, cc({ resource: undefined })))).toBe("invalid_target");
    expect(await err(await tokenReq(env, cc({ resource: "https://evil.example/" })))).toBe("invalid_target");
  });

  it("only grants mcp:service", async () => {
    const env = makeEnv();
    expect(await err(await tokenReq(env, cc({ scope: "mcp:tools" })))).toBe("invalid_scope");
    expect((await tokenReq(env, cc({ scope: "mcp:service" }))).status).toBe(200);
  });

  it("the public client cannot use client_credentials", async () => {
    const env = makeEnv();
    const res = await tokenReq(env, cc({ client_id: "alexa", client_secret: undefined }));
    expect(res.status).toBe(401);
  });

  it("a user token is not a service token", async () => {
    const env = makeEnv();
    const { body } = await fullTokens(env);
    expect(await env.auth.verifyServiceBearer(bearer(body.access_token!))).toBe(false);
  });
});

describe("token endpoint: malformed requests", () => {
  it("rejects an unsupported grant type", async () => {
    const env = makeEnv();
    for (const g of ["password", "implicit", "", "urn:ietf:params:oauth:grant-type:device_code"]) {
      const res = await tokenReq(env, { grant_type: g, client_id: "alexa" });
      expect(res.status).toBe(400);
      expect(await err(res)).toBe("unsupported_grant_type");
    }
  });

  it("rejects a JSON body", async () => {
    const env = makeEnv();
    const res = await env.req("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects GET on the token endpoint", async () => {
    const env = makeEnv();
    const res = await env.req(
      "/oauth/token?grant_type=client_credentials&client_id=alexa-svc&client_secret=svc-secret-value",
    );
    expect(res.status).toBe(404);
  });

  it("rejects a duplicated parameter", async () => {
    const env = makeEnv();
    const { verifier, challenge } = await pkce();
    const { code } = await getCode(env, authzParams(challenge));
    const body = new URLSearchParams(codeGrant(code, verifier) as Record<string, string>);
    body.append("code", "other");
    const res = await env.req("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed Basic header", async () => {
    const env = makeEnv();
    for (const h of ["Basic", "Basic !!!", "Basic " + Buffer.from("nocolon").toString("base64"), "Bearer abc"]) {
      const res = await tokenReq(env, { grant_type: "client_credentials", resource: RESOURCE }, { authorization: h });
      expect(res.status).toBe(401);
    }
  });

  it("a confidential client needs its secret", async () => {
    const env = makeEnv({ clients: [{ clientId: "alexa", redirectUris: [REDIRECT], secret: "client-secret-1" }] });
    const { verifier, challenge } = await pkce();
    const { code } = await getCode(env, authzParams(challenge));
    const bad = await tokenReq(env, codeGrant(code, verifier));
    expect(bad.status).toBe(401);
  });

  it("a confidential client with the right secret succeeds (the failed attempt above did not consume the code)", async () => {
    const env = makeEnv({ clients: [{ clientId: "alexa", redirectUris: [REDIRECT], secret: "client-secret-1" }] });
    const { verifier, challenge } = await pkce();
    const { code } = await getCode(env, authzParams(challenge));
    await tokenReq(env, codeGrant(code, verifier));
    const ok = await tokenReq(env, codeGrant(code, verifier, { client_secret: "client-secret-1" }));
    expect(ok.status).toBe(200);
  });
});

describe("authorize page is not a token source", () => {
  it("the page never contains a code or token before login", async () => {
    const env = makeEnv();
    const { challenge } = await pkce();
    const page = await openAuthorize(env, authzParams(challenge));
    expect(page.html).not.toMatch(/access_token|refresh_token/);
    const res = await postAuthorize(env, page, authzParams(challenge), {
      action: "login",
      email: "a@b.co",
      code: "123456",
    });
    expect(res.headers.get("location")).toBeNull();
  });
});
