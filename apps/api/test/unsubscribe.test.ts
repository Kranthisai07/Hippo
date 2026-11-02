import { createMemoryRepository } from "core/src/repository";
import { describe, expect, it } from "vitest";
import { UNSUBSCRIBE_PER_MINUTE } from "../src/app";
import { createUnsubscribe } from "../src/unsubscribe";
import { makeWeb } from "./webHelpers";

const ORIGIN = "https://api.hippo.test";
const KEY = "unsubscribe-test-key-unsubscribe-test-key-0123";
const T0 = Date.UTC(2026, 10, 2, 12, 0, 0);
const hh = (id: string, digestOn = true) => ({
  id,
  email: `${id}@x.test`,
  digestOn,
  createdAt: "2026-01-01T00:00:00.000Z",
});

async function setup(over: { now?: () => number } = {}) {
  const repo = createMemoryRepository();
  await repo.putHousehold("hh_a", hh("hh_a"));
  await repo.putHousehold("hh_b", hh("hh_b"));
  const clock = { t: T0 };
  const un = createUnsubscribe({ signingKey: KEY, repo, now: over.now ?? (() => clock.t) });
  const tokenOf = async (id: string) => new URL(await un.link(ORIGIN, id)).searchParams.get("t")!;
  const get = (t: string) => un.app.request(`/?t=${encodeURIComponent(t)}`);
  const post = (t: string, init: RequestInit = {}) =>
    un.app.request("/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ t }).toString(),
      ...init,
    });
  return { repo, clock, un, tokenOf, get, post };
}

describe("the turn off link", () => {
  it("is on the public address and ends in /unsubscribe", async () => {
    const { un } = await setup();
    const link = new URL(await un.link(`${ORIGIN}/`, "hh_a"));
    expect(link.origin).toBe(ORIGIN);
    expect(link.pathname).toBe("/unsubscribe");
    expect(link.searchParams.get("t")).toMatch(/^[\w-]+\.[\w-]+$/);
  });

  it("opening it only asks; the daily email stays on until the person presses the button", async () => {
    const s = await setup();
    const res = await s.get(await s.tokenOf("hh_a"));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Turn off the daily email?");
    expect(html).toContain('method="post"');
    expect((await s.repo.getHousehold("hh_a"))?.digestOn).toBe(true);
  });

  it("pressing the button turns off that household's email and no other", async () => {
    const s = await setup();
    const res = await s.post(await s.tokenOf("hh_a"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("The daily email is off");
    expect(await s.repo.getHousehold("hh_a")).toMatchObject({ digestOn: false, email: "hh_a@x.test" });
    expect((await s.repo.getHousehold("hh_b"))?.digestOn).toBe(true);
  });

  it("can be used twice without harm", async () => {
    const s = await setup();
    const t = await s.tokenOf("hh_a");
    expect((await s.post(t)).status).toBe(200);
    expect((await s.post(t)).status).toBe(200);
    expect((await s.repo.getHousehold("hh_a"))?.digestOn).toBe(false);
  });

  it("answers the same for a household that has no record, and creates nothing", async () => {
    const s = await setup();
    const res = await s.post(await s.tokenOf("hh_none"));
    expect(res.status).toBe(200);
    expect(await s.repo.getHousehold("hh_none")).toBeNull();
  });

  it("refuses a token that was changed, signed with another key, cut short, or is junk", async () => {
    const s = await setup();
    const t = await s.tokenOf("hh_a");
    const [body, mac] = t.split(".");
    const other = createUnsubscribe({
      signingKey: "another-key-another-key-another-key-0123456789",
      repo: s.repo,
      now: () => T0,
    });
    const forged = new URL(await other.link(ORIGIN, "hh_a")).searchParams.get("t")!;
    const swapped = `${Buffer.from(JSON.stringify({ h: "hh_b", e: T0 + 1e9 })).toString("base64url")}.${mac}`;
    for (const bad of [forged, swapped, `${body}.AAAA`, body!, "", "a.b.c", "x".repeat(700)]) {
      const res = await s.post(bad);
      expect(res.status, bad.slice(0, 20)).toBe(400);
      expect((await s.get(bad)).status).toBe(400);
    }
    expect((await s.repo.getHousehold("hh_a"))?.digestOn).toBe(true);
    expect((await s.repo.getHousehold("hh_b"))?.digestOn).toBe(true);
  });

  it("stops working after 90 days", async () => {
    const s = await setup();
    const t = await s.tokenOf("hh_a");
    s.clock.t = T0 + 90 * 24 * 3600_000 - 1000;
    expect((await s.post(t)).status).toBe(200);
    const s2 = await setup();
    const t2 = await s2.tokenOf("hh_a");
    s2.clock.t = T0 + 90 * 24 * 3600_000 + 1000;
    const res = await s2.post(t2);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("This link no longer works");
    expect((await s2.repo.getHousehold("hh_a"))?.digestOn).toBe(true);
  });

  it("a POST must be a form, and a huge body is refused", async () => {
    const s = await setup();
    const t = await s.tokenOf("hh_a");
    expect((await s.post(t, { headers: { "content-type": "application/json" } })).status).toBe(400);
    expect((await s.post(t, { body: `t=${"a".repeat(5000)}` })).status).toBe(400);
  });

  it("escapes the token it prints and sends the page headers", async () => {
    const s = await setup();
    const res = await s.get('"><script>alert(1)</script>');
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const ok = await s.get(await s.tokenOf("hh_a"));
    expect(await ok.text()).not.toContain("<script");
  });
});

describe("mounted in the app", () => {
  it("answers at /unsubscribe and is limited per address", async () => {
    const un = createUnsubscribe({ signingKey: KEY, repo: createMemoryRepository(), now: () => T0 });
    const w = await makeWeb({ app: { unsubscribe: un.app } });
    const first = await w.app.request(`${ORIGIN}/unsubscribe?t=nope`);
    expect(first.status).toBe(400);
    for (let i = 1; i < UNSUBSCRIBE_PER_MINUTE; i++) await w.app.request(`${ORIGIN}/unsubscribe?t=nope`);
    const over = await w.app.request(`${ORIGIN}/unsubscribe?t=nope`);
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBeTruthy();
  });
});
