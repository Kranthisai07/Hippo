import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../src";
import { normalizeEmail } from "../src/auth";
import { authzParams, lastMagic, makeEnv, openAuthorize, pkce, postAuthorize, type Env } from "./helpers";

const MIN = 60_000;
const EMAIL = "alice@example.com";

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const send = (env: Env, email = EMAIL) => env.req("/oauth/magic-code", json({ email }));
const guess = (env: Env, code: string, email = EMAIL) => env.req("/oauth/session", json({ email, code }));
const wrong = (n: number): string => String(n % 1_000_000).padStart(6, "0");

// The real code is random, so a guess loop avoids it by construction.
const miss = (env: Env, i = 0, email = EMAIL) => guess(env, wrong(i), email);

async function tenFailures(env: Env, email = EMAIL): Promise<void> {
  for (let i = 0; i < 10; i++) expect((await guess(env, "000000", email)).status).toBe(401);
}

describe("reviewer attack replay", () => {
  it("40 rounds of send plus 5 guesses never allow more than 10 evaluated guesses per 15 minutes", async () => {
    const env = makeEnv();
    const evaluated: number[] = [];
    let sawLimit = false;
    for (let round = 0; round < 40; round++) {
      env.clock.t += 61_000;
      await send(env);
      for (let g = 0; g < 5; g++) {
        const res = await miss(env, round * 5 + g + 1);
        if (res.status === 401) evaluated.push(env.clock.t);
        else {
          expect(res.status).toBe(429);
          sawLimit = true;
        }
      }
    }
    expect(sawLimit).toBe(true);
    for (const t of evaluated) {
      expect(evaluated.filter((u) => u > t - 15 * MIN && u <= t).length).toBeLessThanOrEqual(10);
    }
    expect(evaluated.length).toBeLessThanOrEqual(30);
  });

  it("the same attack without any clock movement ends in 429 after 10 guesses", async () => {
    const env = makeEnv();
    let ok = 0;
    let limited = 0;
    for (let round = 0; round < 40; round++) {
      await send(env);
      for (let g = 0; g < 5; g++) {
        const res = await miss(env, round * 5 + g + 1);
        if (res.status === 401) ok++;
        else if (res.status === 429) limited++;
      }
    }
    expect(ok).toBe(10);
    expect(limited).toBe(190);
  });

  it("the same attack through the HTML form is also limited", async () => {
    const env = makeEnv();
    const { challenge } = await pkce();
    const p = authzParams(challenge);
    const page = await openAuthorize(env, p);
    let ok = 0;
    let last = 0;
    for (let i = 0; i < 40; i++) {
      env.clock.t += 61_000;
      await postAuthorize(env, page, p, { action: "send", email: EMAIL });
      for (let g = 0; g < 5; g++) {
        const res = await postAuthorize(env, page, p, { action: "login", email: EMAIL, code: wrong(i * 5 + g + 1) });
        if (res.status === 401) ok++;
        last = res.status;
      }
    }
    expect(ok).toBeLessThanOrEqual(30);
    expect(last).toBe(429);
  });

  it("a correct code is refused while locked", async () => {
    const env = makeEnv();
    await send(env);
    const code = lastMagic(env);
    await tenFailures(env);
    const res = await guess(env, code);
    expect(res.status).toBe(429);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("send cooldown and hourly cap", () => {
  it("refuses a second send inside 60 seconds with Retry-After", async () => {
    const env = makeEnv();
    expect((await send(env)).status).toBe(200);
    env.clock.t += 20_000;
    const res = await send(env);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("40");
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(env.logs).toHaveLength(1);
  });

  it("allows the next send at exactly 60 seconds", async () => {
    const env = makeEnv();
    await send(env);
    env.clock.t += 60_000;
    expect((await send(env)).status).toBe(200);
    expect(env.logs).toHaveLength(2);
  });

  it("caps sends at 5 per rolling hour", async () => {
    const env = makeEnv();
    for (let i = 0; i < 5; i++) {
      expect((await send(env)).status).toBe(200);
      env.clock.t += 61_000;
    }
    const res = await send(env);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(60);
    expect(Number(res.headers.get("retry-after"))).toBeLessThanOrEqual(3600);
    expect(env.logs).toHaveLength(5);
  });

  it("releases the hourly cap once the oldest send ages out", async () => {
    const env = makeEnv();
    const t0 = env.clock.t;
    for (let i = 0; i < 5; i++) {
      await send(env);
      env.clock.t += 61_000;
    }
    env.clock.t = t0 + 3600_000 - 1;
    expect((await send(env)).status).toBe(429);
    env.clock.t = t0 + 3600_000;
    expect((await send(env)).status).toBe(200);
  });

  it("a refused send does not extend the cooldown", async () => {
    const env = makeEnv();
    await send(env);
    env.clock.t += 30_000;
    await send(env);
    env.clock.t += 30_000;
    expect((await send(env)).status).toBe(200);
  });

  it("sends for different emails do not share a cooldown", async () => {
    const env = makeEnv();
    expect((await send(env, "a@example.com")).status).toBe(200);
    expect((await send(env, "b@example.com")).status).toBe(200);
  });

  it("applies to the HTML form send action", async () => {
    const env = makeEnv();
    const { challenge } = await pkce();
    const p = authzParams(challenge);
    const page = await openAuthorize(env, p);
    expect((await postAuthorize(env, page, p, { action: "send", email: EMAIL })).status).toBe(200);
    const res = await postAuthorize(env, page, p, { action: "send", email: EMAIL });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(env.logs).toHaveLength(1);
  });
});

describe("lockout", () => {
  it("locks after 10 failures with a 15 minute Retry-After", async () => {
    const env = makeEnv();
    await tenFailures(env);
    const res = await miss(env);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("900");
    expect(await res.json()).toEqual({ error: "rate_limited" });
  });

  it("re-sending a code does not reset the failure counter", async () => {
    const env = makeEnv();
    for (let i = 0; i < 6; i++) await guess(env, "000000");
    env.clock.t += 61_000;
    await send(env);
    for (let i = 0; i < 4; i++) expect((await guess(env, "000000")).status).toBe(401);
    expect((await guess(env, "000000")).status).toBe(429);
  });

  it("stays locked until 15 minutes pass and then unlocks", async () => {
    const env = makeEnv();
    await tenFailures(env);
    env.clock.t += 15 * MIN - 1000;
    const res = await miss(env);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("1");
    env.clock.t += 1000;
    expect((await miss(env)).status).toBe(401);
  });

  it("attempts made while locked do not extend the lock", async () => {
    const env = makeEnv();
    await tenFailures(env);
    for (let i = 0; i < 5; i++) {
      env.clock.t += 2 * MIN;
      expect((await miss(env)).status).toBe(429);
    }
    env.clock.t += 5 * MIN; // 15 minutes after the tenth failure
    expect((await miss(env)).status).toBe(401);
  });

  it("a correct code after the lock expires signs in", async () => {
    const env = makeEnv();
    await tenFailures(env);
    env.clock.t += 15 * MIN;
    await send(env);
    const res = await guess(env, lastMagic(env));
    expect(res.status).toBe(200);
  });

  it("success resets the failure counter", async () => {
    const env = makeEnv();
    await send(env);
    for (let i = 0; i < 4; i++) await guess(env, "000000");
    expect((await guess(env, lastMagic(env))).status).toBe(200);
    for (let i = 0; i < 9; i++) expect((await guess(env, "000000")).status).toBe(401);
  });

  it("does not lock one email because of another", async () => {
    const env = makeEnv();
    await tenFailures(env, "a@example.com");
    expect((await miss(env, 0, "b@example.com")).status).toBe(401);
  });

  it("a lock on the HTML form login returns 429 with Retry-After", async () => {
    const env = makeEnv();
    const { challenge } = await pkce();
    const p = authzParams(challenge);
    const page = await openAuthorize(env, p);
    for (let i = 0; i < 10; i++) {
      await postAuthorize(env, page, p, { action: "login", email: EMAIL, code: "000000" });
    }
    const res = await postAuthorize(env, page, p, { action: "login", email: EMAIL, code: "000000" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("900");
  });

  it("a locked email can still not log in through the form with the right code", async () => {
    const env = makeEnv();
    const { challenge } = await pkce();
    const p = authzParams(challenge);
    const page = await openAuthorize(env, p);
    await postAuthorize(env, page, p, { action: "send", email: EMAIL });
    const code = lastMagic(env);
    await tenFailures(env);
    const res = await postAuthorize(env, page, p, { action: "login", email: EMAIL, code });
    expect(res.status).toBe(429);
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("demo user", () => {
  it("counts wrong demo codes and locks", async () => {
    const env = makeEnv();
    for (let i = 0; i < 10; i++) {
      expect((await guess(env, wrong(i + 1), "demo@hippo.test")).status).toBe(401);
    }
    expect((await guess(env, "111111", "demo@hippo.test")).status).toBe(429);
  });

  it("refuses even the right demo code while locked", async () => {
    const env = makeEnv();
    for (let i = 0; i < 10; i++) await guess(env, wrong(i + 1), "demo@hippo.test");
    expect((await guess(env, "424242", "demo@hippo.test")).status).toBe(429);
  });

  it("a right demo code resets the counter", async () => {
    const env = makeEnv();
    for (let i = 0; i < 9; i++) await guess(env, wrong(i + 1), "demo@hippo.test");
    expect((await guess(env, "424242", "demo@hippo.test")).status).toBe(200);
    for (let i = 0; i < 9; i++) expect((await guess(env, wrong(i + 1), "demo@hippo.test")).status).toBe(401);
  });

  it("demo failures and magic code failures share one counter", async () => {
    const env = makeEnv();
    await send(env, "demo@hippo.test");
    for (let i = 0; i < 5; i++) await guess(env, wrong(i + 1), "demo@hippo.test");
    for (let i = 0; i < 5; i++) expect((await guess(env, wrong(i + 9), "demo@hippo.test")).status).toBe(401);
    expect((await guess(env, "424242", "demo@hippo.test")).status).toBe(429);
  });

  it("the demo button still works and is not throttled by code failures", async () => {
    const env = makeEnv();
    for (let i = 0; i < 10; i++) await guess(env, wrong(i + 1), "demo@hippo.test");
    const res = await env.req("/oauth/session", json({ demo: true }));
    expect(res.status).toBe(200);
  });
});

describe("email normalisation", () => {
  it("applies NFKC, trim and lowercase", () => {
    expect(normalizeEmail("  ＡＬＩＣＥ@Example.COM ")).toBe(EMAIL);
  });

  it("case and spacing variants share the send cooldown", async () => {
    const env = makeEnv();
    await send(env, EMAIL);
    expect((await send(env, "ALICE@Example.com")).status).toBe(429);
    expect((await send(env, "  alice@example.com  ")).status).toBe(429);
  });

  it("unicode compatibility variants share the send cooldown", async () => {
    const env = makeEnv();
    await send(env, EMAIL);
    expect((await send(env, "ａｌｉｃｅ@example.com")).status).toBe(429);
  });

  it("case and unicode variants share the failure counter", async () => {
    const env = makeEnv();
    const variants = [EMAIL, "ALICE@example.com", " Alice@Example.com ", "ａｌｉｃｅ@example.com", "alice@EXAMPLE.com"];
    for (let i = 0; i < 10; i++) expect((await miss(env, i, variants[i % variants.length])).status).toBe(401);
    expect((await miss(env, 99, "aLiCe@example.com")).status).toBe(429);
  });
});

describe("no account enumeration", () => {
  const shape = async (res: Response) => ({
    status: res.status,
    body: await res.text(),
    type: res.headers.get("content-type"),
    retry: res.headers.get("retry-after"),
    cache: res.headers.get("cache-control"),
  });

  it("known and unknown emails get the same send, cooldown and lock responses", async () => {
    const env = makeEnv();
    const a = "known@example.com";
    const b = "unknown@example.com";
    const first = [await shape(await send(env, a)), await shape(await send(env, b))];
    expect(first[0]).toEqual(first[1]);
    const cool = [await shape(await send(env, a)), await shape(await send(env, b))];
    expect(cool[0]).toEqual(cool[1]);
    const locked = [];
    for (const e of [a, b]) {
      for (let i = 0; i < 10; i++) await guess(env, "000000", e);
      locked.push(await shape(await guess(env, "000000", e)));
    }
    expect(locked[0]).toEqual(locked[1]);
    expect(locked[0]!.status).toBe(429);
  });

  it("wrong code answers look the same for an email with and without a code on file", async () => {
    const env = makeEnv();
    await send(env, "known@example.com");
    const a = await shape(await guess(env, "000000", "known@example.com"));
    const b = await shape(await guess(env, "000000", "unknown@example.com"));
    expect(a).toEqual(b);
  });
});

describe("concurrency", () => {
  it("50 parallel wrong guesses evaluate at most 10", async () => {
    const env = makeEnv();
    const res = await Promise.all(Array.from({ length: 50 }, (_, i) => miss(env, i + 1)));
    const codes = res.map((r) => r.status);
    expect(codes.filter((s) => s === 401).length).toBe(10);
    expect(codes.filter((s) => s === 429).length).toBe(40);
  });

  it("parallel guesses including the right code cannot exceed the limit", async () => {
    const env = makeEnv();
    await send(env);
    const code = lastMagic(env);
    const res = await Promise.all([...Array.from({ length: 30 }, (_, i) => miss(env, i + 1)), guess(env, code)]);
    expect(res.filter((r) => r.status === 401).length).toBeLessThanOrEqual(10);
    expect(res.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);
  });

  it("10 parallel sends for one email allow exactly one", async () => {
    const env = makeEnv();
    const res = await Promise.all(Array.from({ length: 10 }, () => send(env)));
    expect(res.filter((r) => r.status === 200)).toHaveLength(1);
    expect(res.filter((r) => r.status === 429)).toHaveLength(9);
    expect(env.logs).toHaveLength(1);
  });
});

describe("memory store counters", () => {
  it("tryHit allows up to max inside the window and reports the wait", async () => {
    const s = createMemoryStore();
    for (let i = 0; i < 3; i++) expect(await s.tryHit("k", 1000, 3, 0, 100 + i)).toEqual({ ok: true });
    expect(await s.tryHit("k", 1000, 3, 0, 500)).toEqual({ ok: false, retryAfterMs: 600 });
    expect(await s.tryHit("k", 1000, 3, 0, 1100)).toEqual({ ok: true });
  });

  it("tryHit enforces the minimum gap and a refusal records nothing", async () => {
    const s = createMemoryStore();
    expect(await s.tryHit("k", 10_000, 5, 100, 0)).toEqual({ ok: true });
    expect(await s.tryHit("k", 10_000, 5, 100, 40)).toEqual({ ok: false, retryAfterMs: 60 });
    expect(await s.tryHit("k", 10_000, 5, 100, 100)).toEqual({ ok: true });
  });

  it("clearCounter resets a key and keys are independent", async () => {
    const s = createMemoryStore();
    await s.tryHit("a", 1000, 1, 0, 0);
    await s.tryHit("b", 1000, 1, 0, 0);
    await s.clearCounter("a");
    expect(await s.tryHit("a", 1000, 1, 0, 1)).toEqual({ ok: true });
    expect((await s.tryHit("b", 1000, 1, 0, 1)).ok).toBe(false);
  });

  it("is atomic under parallel calls", async () => {
    const s = createMemoryStore();
    const r = await Promise.all(Array.from({ length: 20 }, () => s.tryHit("k", 1000, 4, 0, 0)));
    expect(r.filter((x) => x.ok)).toHaveLength(4);
  });
});
