import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/api/hash";

describe("sha256Hex", () => {
  it("matches node:crypto, so saved page ids do not change", async () => {
    for (const text of ["", "abc", "Billing | Fernwood\nYour plan costs $15.99/month.", "café ☃ \u{1F427}"]) {
      expect(await sha256Hex(text)).toBe(createHash("sha256").update(text).digest("hex"));
    }
  });
});
