import { extractSubscriptionRules } from "obligation-kit";
import { describe, expect, it } from "vitest";

// Mail is hostile text up to 200k characters. The rules must not take long on it, whatever it repeats.
describe("the subscription rules on hostile text", () => {
  const SHAPES: [string, string][] = [
    ["dollar signs", "$".repeat(200_000)],
    ["digits and separators", "1,".repeat(100_000)],
    ["price fragments", "$1.".repeat(66_000)],
    ["month names", "Jan ".repeat(50_000)],
    ["month and day", "December 3, ".repeat(18_000)],
    ["per month", "per month ".repeat(20_000)],
    ["spaces", " ".repeat(200_000)],
    ["newlines and words", "renews\n".repeat(28_000)],
    ["trial words", "free trial ends ".repeat(12_000)],
    ["long word", "a".repeat(200_000)],
  ];
  for (const [name, text] of SHAPES) {
    it(`finishes quickly on ${name}`, () => {
      const t = performance.now();
      extractSubscriptionRules(`Vendor\n${text}`);
      expect(performance.now() - t).toBeLessThan(2000);
    });
  }
});
