import { describe, expect, it } from "vitest";
import { okFit } from "../src/mcp/result";
import { countWords } from "../src/mcp/speak";

const DISCLAIMER = "This is what your document says, not a claim decision.";
const LOWER = DISCLAIMER.charAt(0).toLowerCase() + DISCLAIMER.slice(1);
const endsWithDisclaimer = (t: string) => t.toLowerCase().endsWith("not a claim decision.");
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
const text = (r: ReturnType<typeof okFit>) => r.content[0]!.text;

describe("okFit keeps the second sentence the answer must not lose", () => {
  it("keeps both sentences when they fit", () => {
    const t = text(okFit("Yes, it is covered.", ["Report within 30 days; this is what it says.", DISCLAIMER], {}));
    expect(t).toBe("Yes, it is covered. Report within 30 days; this is what it says.");
  });

  it("falls back to the minimal second sentence when the richest does not fit", () => {
    const t = text(okFit(`${words(18)}.`, [`${words(30)}; ${LOWER}`, DISCLAIMER], {}));
    expect(t.endsWith(DISCLAIMER)).toBe(true);
    expect(countWords(t)).toBeLessThanOrEqual(45);
  });

  it("clips a very long first sentence instead of dropping the disclaimer", () => {
    const t = text(okFit(`${words(80)}.`, [`${words(10)}; ${LOWER}`, DISCLAIMER], {}));
    expect(endsWithDisclaimer(t)).toBe(true);
    expect(countWords(t)).toBeLessThanOrEqual(45);
    expect(t.startsWith("word0 word1")).toBe(true);
  });

  it("still speaks a first sentence of exactly the room that is left", () => {
    const room = 45 - countWords(DISCLAIMER);
    const t = text(okFit(`${words(room)}.`, [DISCLAIMER], {}));
    expect(countWords(t)).toBe(45);
    expect(t.endsWith(DISCLAIMER)).toBe(true);
  });

  it("returns the structured content untouched", () => {
    expect(okFit("Hi.", [DISCLAIMER], { a: 1 }).structuredContent).toEqual({ a: 1 });
  });
});
