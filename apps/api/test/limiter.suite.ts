import { describe, expect, it } from "vitest";
import type { RateLimiter } from "../src/api/limiter";

// One table of cases for every RateLimiter: the memory one and the D1 one (apps/edge). `make` gets the clock.
export function runLimiterSuite(name: string, make: (now: () => number) => RateLimiter): void {
  describe(`RateLimiter: ${name}`, () => {
    it("allows max hits per window, then says how long to wait, then forgets", async () => {
      let t = 1_000_000;
      const limit = make(() => t);
      for (let i = 0; i < 3; i++) expect(await limit("k", 60_000, 3)).toEqual({ ok: true });
      expect(await limit("k", 60_000, 3)).toEqual({ ok: false, retryAfterSec: 60 });
      expect(await limit("other", 60_000, 3)).toEqual({ ok: true });
      t += 60_001;
      expect(await limit("k", 60_000, 3)).toEqual({ ok: true });
    });
    it("rounds the wait up to whole seconds, at least one", async () => {
      let t = 5_000_000;
      const limit = make(() => t);
      await limit("r", 60_000, 1);
      t += 59_500;
      expect(await limit("r", 60_000, 1)).toEqual({ ok: false, retryAfterSec: 1 });
      t -= 30_000;
      expect(await limit("r", 60_000, 1)).toEqual({ ok: false, retryAfterSec: 31 });
    });
    it("30 parallel calls against a limit of 5 let exactly 5 through", async () => {
      const limit = make(() => 9_000_000);
      const all = await Promise.all(Array.from({ length: 30 }, () => limit("p", 60_000, 5)));
      expect(all.filter((r) => r.ok)).toHaveLength(5);
    });
  });
}
