import { describe, expect, it } from "vitest";
import { RESOURCE, makeEnv } from "./helpers";

// Review finding: the body was read and parsed before the bearer was checked, so an unauthenticated caller got 400 or
// 413 (and could make the server read a large body) instead of the bare 401.
const headers = (extra: Record<string, string> = {}) => ({
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  ...extra,
});

describe("the bearer is checked before the body is read", () => {
  it("answers 401 with no WWW-Authenticate to unparseable JSON without a token", async () => {
    const env = await makeEnv();
    const res = await env.fetch(RESOURCE, { method: "POST", headers: headers(), body: "{not json" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  it("answers 401 to a body over the limit without a token", async () => {
    const env = await makeEnv({ maxBodyBytes: 1024 });
    const res = await env.fetch(RESOURCE, { method: "POST", headers: headers(), body: "x".repeat(200_000) });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  it("answers 401 to a wrong token, a malformed header and a basic scheme, whatever the body is", async () => {
    const env = await makeEnv();
    for (const authorization of ["Bearer nonsense", "Bearer", "Basic dXNlcjpwYXNz", "bearer ", ""]) {
      const res = await env.fetch(RESOURCE, {
        method: "POST",
        headers: headers({ authorization }),
        body: "{not json",
      });
      expect(res.status, authorization).toBe(401);
      expect(res.headers.get("www-authenticate"), authorization).toBeNull();
    }
  });

  it("still tells an authenticated caller about bad JSON (400) and an oversize body (413)", async () => {
    const env = await makeEnv({ maxBodyBytes: 1024 });
    const authorization = `Bearer ${await env.tokenA()}`;
    const bad = await env.fetch(RESOURCE, { method: "POST", headers: headers({ authorization }), body: "{not json" });
    expect(bad.status).toBe(400);
    const big = await env.fetch(RESOURCE, {
      method: "POST",
      headers: headers({ authorization }),
      body: "x".repeat(200_000),
    });
    expect(big.status).toBe(413);
  });

  it("a service token may still reach initialize without a household", async () => {
    const env = await makeEnv();
    const bad = await env.fetch(RESOURCE, { method: "POST", headers: headers(), body: "{}" });
    expect(bad.status).toBe(401);
  });
});
