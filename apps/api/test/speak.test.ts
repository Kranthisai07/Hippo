import { describe, expect, it } from "vitest";
import { countWords, maskNumbers, speak, stripMarkdown, stripUrls } from "../src/mcp/speak";

describe("stripMarkdown", () => {
  it("removes emphasis, headings, bullets, code and quotes", () => {
    expect(stripMarkdown("**Bold** and _italic_ and `code`")).toBe("Bold and italic and code");
    expect(stripMarkdown("# Heading\n- item one\n* item two\n1. item three")).toBe(
      "Heading item one item two item three",
    );
    expect(stripMarkdown("> quoted line")).toBe("quoted line");
  });

  it("keeps the text of a link and drops its target", () => {
    expect(stripMarkdown("see [the policy](https://x.example/p) now")).toBe("see the policy now");
  });

  it("removes tables and rules", () => {
    expect(stripMarkdown("| a | b |\n|---|---|\n| 1 | 2 |")).not.toContain("|");
    expect(stripMarkdown("above\n---\nbelow")).toBe("above below");
  });
});

describe("stripUrls", () => {
  it("removes http, https and www links", () => {
    expect(stripUrls("go to https://a.example/x?y=1 today")).toBe("go to today");
    expect(stripUrls("visit www.northwind-appliances.example/warranty or call")).toBe("visit or call");
    expect(stripUrls("http://localhost:8787/mcp")).toBe("");
  });

  it("removes email addresses", () => {
    expect(stripUrls("email warranty@northwind-appliances.example now")).toBe("email now");
  });

  it("removes bare domains with a path", () => {
    expect(stripUrls("see northwind.example/warranty please")).toBe("see please");
  });

  it("keeps ordinary sentences with dots", () => {
    expect(stripUrls("Dr. Smith said no. Then left.")).toBe("Dr. Smith said no. Then left.");
  });
});

describe("maskNumbers", () => {
  it("masks a policy number to its last four digits", () => {
    expect(maskNumbers("Policy number: HM-AU-0048-4821")).toBe("Policy number: ending 4821");
  });

  it("masks long account numbers", () => {
    expect(maskNumbers("account 123456789012 is open")).toBe("account ending 9012 is open");
    expect(maskNumbers("card 4111-1111-1111-1234.")).toBe("card ending 1234.");
  });

  it("keeps dates, money, years, days and short numbers", () => {
    const keep = "Due 2026-10-21 or 10/21/2026, $1,950 a month, 30 days, page 3, in 2026, $100,000 limit";
    expect(maskNumbers(keep)).toBe(keep);
  });

  it("keeps phone numbers because they are not account numbers", () => {
    expect(maskNumbers("Call 1-800-555-0142 today")).toBe("Call 1-800-555-0142 today");
  });

  it("masks every occurrence", () => {
    expect(maskNumbers("A 11112222 and B 33334444")).toBe("A ending 2222 and B ending 4444");
  });

  it("handles unicode digits and empty input", () => {
    expect(maskNumbers("")).toBe("");
    expect(maskNumbers("número １２３４５６７８")).toContain("ending");
  });
});

describe("countWords", () => {
  it("counts whitespace separated words", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("  one   two\nthree ")).toBe(3);
  });
});

describe("speak", () => {
  it("joins parts with a space and tidies whitespace", () => {
    expect(speak(["Hello there.", "  How   are you? "])).toBe("Hello there. How are you?");
  });

  it("strips markdown and urls and masks numbers in one pass", () => {
    const out = speak("**Your** policy HM-AU-0048-4821 is at https://x.example/p and www.y.example.");
    expect(out).toBe("Your policy ending 4821 is at and.");
  });

  it("never returns more than 45 words by default", () => {
    const long = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ");
    expect(countWords(speak(long))).toBeLessThanOrEqual(45);
  });

  it("cuts at the last full sentence inside the cap when there is one", () => {
    const first = Array.from({ length: 20 }, () => "alpha").join(" ") + ".";
    const second = Array.from({ length: 40 }, () => "beta").join(" ") + ".";
    expect(speak([first, second])).toBe(first);
  });

  it("hard cuts a single long sentence and ends it with a full stop", () => {
    const out = speak(Array.from({ length: 80 }, () => "gamma").join(" "));
    expect(countWords(out)).toBe(45);
    expect(out.endsWith(".")).toBe(true);
  });

  it("honours a smaller cap", () => {
    expect(countWords(speak("one two three four five six seven eight nine ten", 5))).toBeLessThanOrEqual(5);
  });

  it("leaves a short answer alone", () => {
    expect(speak("Your dishwasher is covered until November 12.")).toBe(
      "Your dishwasher is covered until November 12.",
    );
  });

  it("removes characters a speaker should not read", () => {
    const out = speak("Use *this* then ~that~ and <b>bold</b> text");
    expect(out).not.toMatch(/[*~<>]/);
  });

  it("returns an empty string for nothing and never throws on odd input", () => {
    expect(speak("")).toBe("");
    expect(speak([])).toBe("");
    expect(() => speak("\u0000‮ weird 😀")).not.toThrow();
  });

  it("is safe on very long input", () => {
    const huge = "word ".repeat(200_000);
    expect(countWords(speak(huge))).toBeLessThanOrEqual(45);
  });
});
