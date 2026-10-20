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
