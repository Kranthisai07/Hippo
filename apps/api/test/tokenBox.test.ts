import { describe, expect, it } from "vitest";
import { createTokenBox } from "../src/import/tokenBox";

const KEY = "token-box-test-key-token-box-test-key-0123456";

describe("the token box", () => {
  it("gives the token back, and the sealed text holds nothing readable of it", async () => {
    const box = createTokenBox(KEY);
    const sealed = await box.seal("ya29.a0Secret-Token_value");
    expect(sealed).not.toContain("ya29");
    expect(sealed).not.toContain("Secret");
    expect(await box.open(sealed)).toBe("ya29.a0Secret-Token_value");
  });

  it("uses a fresh nonce each time", async () => {
    const box = createTokenBox(KEY);
    expect(await box.seal("same")).not.toBe(await box.seal("same"));
  });

  it("opens nothing that was changed, cut, made with another key, or is not ours", async () => {
    const box = createTokenBox(KEY);
    const sealed = await box.seal("ya29.token");
    const [v, iv, ct] = sealed.split(".");
    const flipped = `${v}.${iv}.${ct!.slice(0, -2)}${ct!.endsWith("A") ? "B" : "A"}${ct!.slice(-1)}`;
    for (const bad of [
      flipped,
      `${v}.${iv}`,
      `${v}.${iv}.${ct}.x`,
      "v2." + sealed.slice(3),
      "",
      "plain",
      "v1..",
      `v1.${iv}.${"A".repeat(10)}`,
      "%".repeat(20),
      "v1.!!.??",
    ]) {
      expect(await box.open(bad), bad.slice(0, 30)).toBeNull();
    }
    expect(await createTokenBox("another-key-another-key-another-key-0123456").open(sealed)).toBeNull();
  });

  it("handles a long token and any characters", async () => {
    const box = createTokenBox(KEY);
    const long = "ya29." + "é☕-_".repeat(400);
    expect(await box.open(await box.seal(long))).toBe(long);
  });
});
