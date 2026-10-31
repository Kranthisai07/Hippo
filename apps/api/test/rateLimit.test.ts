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

  const socket = (address: string) => ({ incoming: { socket: { remoteAddress: address } } });

  it("without a named header it uses the socket address: two addresses get separate buckets, and the header changes nothing", async () => {
    const w = await makeWeb();
    const hit = (address: string, spoof: string) =>
      w.app.request(`${BASE}/ext/subscriptions`, from(spoof), socket(address));
    for (let i = 0; i < EXT_PER_MINUTE; i++) await hit("192.0.2.1", `198.51.100.${i % 250}`);
    expect((await hit("192.0.2.1", "198.51.100.250")).status).toBe(429);
    expect((await hit("192.0.2.2", "198.51.100.250")).status).toBe(401);
  });

  it("a 429 on /ext lets the listed origin read it and Retry-After", async () => {
    const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
    const w = await makeWeb({ app: { allowedOrigins: [EXT] } });
    const hit = (origin: string) =>
      w.app.request(`${BASE}/ext/subscriptions`, { headers: { origin } }, socket("192.0.2.9"));
    for (let i = 0; i < EXT_PER_MINUTE; i++) await hit(EXT);
    const listed = await hit(EXT);
    expect(listed.status).toBe(429);
    expect(listed.headers.get("access-control-allow-origin")).toBe(EXT);
    expect(listed.headers.get("retry-after")).not.toBeNull();
    expect(listed.headers.get("x-content-type-options")).toBe("nosniff");
    expect(listed.headers.get("x-request-id")).not.toBeNull();
    const other = await hit("https://evil.example");
    expect(other.status).toBe(429);
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("CORS on /ext", () => {
  const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
  const setup = () => makeWeb({ app: { allowedOrigins: [EXT] } });
  const preflight = (w: Awaited<ReturnType<typeof setup>>, origin: string) =>
    w.app.request(`${BASE}/ext/captures`, {
      method: "OPTIONS",
      headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization" },
    });

  it("answers the preflight of the listed origin with that origin only, and no token", async () => {
    const r = await preflight(await setup(), EXT);
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBe(EXT);
    expect(r.headers.get("access-control-allow-headers")).toBe("Authorization, Content-Type");
    expect(r.headers.get("vary")).toContain("Origin");
  });
  it.each(["https://evil.example", "null", "http://localhost:5173"])("refuses the preflight of %s", async (origin) => {
    const r = await preflight(await setup(), origin);
    expect(r.status).toBe(403);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });
  it("lets the listed origin read a 401, and shows nothing to others", async () => {
    const w = await setup();
    const r = await w.app.request(`${BASE}/ext/subscriptions`, { headers: { origin: EXT } });
    expect(r.status).toBe(401);
    expect(r.headers.get("access-control-allow-origin")).toBe(EXT);
  });
  it("never allows credentials or a wildcard", async () => {
    const r = await preflight(await setup(), EXT);
    expect(r.headers.get("access-control-allow-credentials")).toBeNull();
    expect(r.headers.get("access-control-allow-origin")).not.toBe("*");
  });
});
