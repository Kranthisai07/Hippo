import { describe, expect, it } from "vitest";
import { makeEnv } from "./helpers";

// Round 2 review: the magic code is a login credential and was written to the log in every environment.
const send = (env: ReturnType<typeof makeEnv>, email = "alice@example.com") =>
  env.req("/oauth/magic-code", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });

describe("logging the magic code", () => {
  it("by default the demo line is written, as before", async () => {
    const env = makeEnv();
    expect((await send(env)).status).toBeLessThan(300);
    expect(env.logs.some((l) => /magic code for alice@example\.com: \d{6}/.test(l))).toBe(true);
  });

  it("with logMagicCodes false the code and the email never reach the log", async () => {
    const env = makeEnv({ logMagicCodes: false });
    const res = await send(env);
    expect(res.status).toBeLessThan(300);
    expect(env.logs.join("\n")).not.toMatch(/\d{6}/);
    expect(env.logs.join("\n")).not.toContain("alice@example.com");
  });

  it("with logMagicCodes false a code cannot be learned, so the email login cannot succeed", async () => {
    const env = makeEnv({ logMagicCodes: false });
    await send(env);
    const res = await env.req("/oauth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "alice@example.com", code: "000000" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("a mailer", () => {
  it("receives the code, and nothing is logged", async () => {
    const sent: [string, string][] = [];
    const env = makeEnv({ mailer: { send: async (e, c) => void sent.push([e, c]) } });
    expect((await send(env)).status).toBeLessThan(300);
    expect(sent).toHaveLength(1);
    expect(sent[0]![0]).toBe("alice@example.com");
    expect(sent[0]![1]).toMatch(/^\d{6}$/);
    expect(env.logs.join("\n")).not.toContain(sent[0]![1]);
    const login = await env.req("/oauth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "alice@example.com", code: sent[0]![1] }),
    });
    expect(login.status).toBe(200);
  });

  it("a provider failure gives the same answer, and the log holds the error name only", async () => {
    const ok = makeEnv({ mailer: { send: async () => undefined } });
    const bad = makeEnv({
      mailer: {
        send: async () => {
          throw new TypeError("smtp said alice@example.com 123456");
        },
      },
    });
    const a = await send(ok);
    const b = await send(bad);
    expect(b.status).toBe(a.status);
    expect(await b.json()).toEqual(await a.json());
    expect(bad.logs.join("\n")).toContain("mail failed: TypeError");
    expect(bad.logs.join("\n")).not.toMatch(/alice@|\d{6}/);
  });

  it("the sign in form answers the same for an address that is malformed and one that is not", async () => {
    const env = makeEnv({ mailer: { send: async () => undefined } });
    const msg = async (email: string) => {
      const page = await env.req(
        "/oauth/authorize?" +
          new URLSearchParams({
            client_id: "alexa",
            redirect_uri: "https://alexa.example/auth/callback",
            response_type: "code",
            code_challenge: "A".repeat(43),
            code_challenge_method: "S256",
            resource: "https://api.hippo.test/mcp",
          }),
      );
      const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())![1]!;
      const res = await env.req("/oauth/authorize", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: `hippo_csrf=${csrf}` },
        body: new URLSearchParams({
          action: "send",
          email,
          csrf,
          client_id: "alexa",
          redirect_uri: "https://alexa.example/auth/callback",
          response_type: "code",
          code_challenge: "A".repeat(43),
          code_challenge_method: "S256",
          resource: "https://api.hippo.test/mcp",
        }).toString(),
      });
      return /If that address can sign in[^<]*/.exec(await res.text())?.[0];
    };
    expect(await msg("real@example.com")).toBe("If that address can sign in, a code was sent. Enter it below.");
    expect(await msg("not an email")).toBe("If that address can sign in, a code was sent. Enter it below.");
  });
});
