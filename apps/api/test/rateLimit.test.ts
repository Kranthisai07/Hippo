import { describe, expect, it } from "vitest";
import { EXT_PER_MINUTE, OAUTH_PER_MINUTE } from "../src/app";
import { createMemoryLimiter } from "../src/api/limiter";
import { BASE } from "./helpers";
import { makeWeb } from "./webHelpers";

describe("the memory limiter", () => {
  it("allows max hits per window, then says how long to wait, then forgets", async () => {
    let t = 1_000_000;
    const limit = createMemoryLimiter(() => t);
    for (let i = 0; i < 3; i++) expect(await limit("k", 60_000, 3)).toEqual({ ok: true });
    expect(await limit("k", 60_000, 3)).toEqual({ ok: false, retryAfterSec: 60 });
    expect(await limit("other", 60_000, 3)).toEqual({ ok: true });
    t += 60_001;
    expect(await limit("k", 60_000, 3)).toEqual({ ok: true });
  });
});

describe("per address limits in front of the sign-in and extension routes", () => {
  const from = (ip: string) => ({ headers: { "cf-connecting-ip": ip } });

  it(`/ext answers 429 with Retry-After after ${EXT_PER_MINUTE} calls a minute from one address, and only that address`, async () => {
    const w = await makeWeb({ app: { clientIpHeader: "cf-connecting-ip" } });
    for (let i = 0; i < EXT_PER_MINUTE; i++) {
      expect((await w.app.request(`${BASE}/ext/subscriptions`, from("203.0.113.1"))).status).toBe(401);
    }
    const blocked = await w.app.request(`${BASE}/ext/subscriptions`, from("203.0.113.1"));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(blocked.headers.get("cache-control")).toBe("no-store");
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
    expect((await w.app.request(`${BASE}/ext/subscriptions`, from("203.0.113.2"))).status).toBe(401);
  });

  it(`/oauth answers 429 in the OAuth error shape after ${OAUTH_PER_MINUTE} calls a minute`, async () => {
    const w = await makeWeb({ app: { clientIpHeader: "cf-connecting-ip" } });
    const hit = () => w.app.request(`${BASE}/oauth/token`, { method: "POST", ...from("203.0.113.9") });
    for (let i = 0; i < OAUTH_PER_MINUTE; i++) expect((await hit()).status).not.toBe(429);
    const blocked = await hit();
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: "rate_limited" });
    expect(blocked.headers.get("retry-after")).not.toBeNull();
  });

  it("ignores the proxy header unless the host names it, so a client cannot pick its own bucket", async () => {
    const w = await makeWeb();
    for (let i = 0; i < EXT_PER_MINUTE; i++)
      await w.app.request(`${BASE}/ext/subscriptions`, from(`198.51.100.${i % 250}`));
    expect((await w.app.request(`${BASE}/ext/subscriptions`, from("198.51.100.250"))).status).toBe(429);
  });
});
