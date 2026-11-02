import { describe, expect, it } from "vitest";
import { authzParams, lastMagic, makeEnv, openAuthorize, pkce, postAuthorize } from "./helpers";

type Who = { email: string; sub: string; householdId: string };

const codeLogin = async (env: ReturnType<typeof makeEnv>, email: string) => {
  const { challenge } = await pkce();
  const p = authzParams(challenge);
  const page = await openAuthorize(env, p);
  await postAuthorize(env, page, p, { action: "send", email });
  return postAuthorize(env, page, p, { action: "login", email, code: lastMagic(env) });
};

describe("onLogin", () => {
  it("is told the verified address and the household it maps to, once per sign in", async () => {
    const seen: Who[] = [];
    const env = makeEnv({
      onLogin: async (w) => void seen.push(w),
    });
    const res = await codeLogin(env, "Sam@Example.com");
    expect(res.status).toBe(302);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ email: "sam@example.com", householdId: "hh_sam" });
    expect(seen[0]!.sub).toMatch(/^u_/);
  });

  it("is not called when the code is wrong", async () => {
    const seen: Who[] = [];
    const env = makeEnv({ onLogin: async (w) => void seen.push(w) });
    const { challenge } = await pkce();
    const p = authzParams(challenge);
    const page = await openAuthorize(env, p);
    await postAuthorize(env, page, p, { action: "send", email: "sam@example.com" });
    const res = await postAuthorize(env, page, p, { action: "login", email: "sam@example.com", code: "000000" });
    expect(res.status).toBe(401);
    expect(seen).toEqual([]);
  });

  it("is called for the cookie session of the web app too", async () => {
    const seen: Who[] = [];
    const env = makeEnv({ onLogin: async (w) => void seen.push(w) });
    const sent = await env.req("/oauth/magic-code", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://api.hippo.test" },
      body: JSON.stringify({ email: "web@example.com" }),
    });
    expect(sent.status).toBe(200);
    const res = await env.req("/oauth/session", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://api.hippo.test" },
      body: JSON.stringify({ email: "web@example.com", code: lastMagic(env) }),
    });
    expect(res.status).toBe(200);
    expect(seen.map((w) => w.email)).toEqual(["web@example.com"]);
  });

  it("a failing hook never stops the sign in, and the log names only the error", async () => {
    const env = makeEnv({
      onLogin: async () => {
        throw new TypeError("secret detail sam@example.com");
      },
    });
    const res = await codeLogin(env, "sam@example.com");
    expect(res.status).toBe(302);
    const log = env.logs.join("\n");
    expect(log).toContain("onLogin failed (TypeError)");
    expect(log).not.toContain("secret detail");
    expect(log).not.toMatch(/failed.*sam@example\.com/);
  });
});
