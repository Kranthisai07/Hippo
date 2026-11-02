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

  // Review finding: numbers split by spaces, or shaped like a date, a phone or money, used to be spoken in full.
  describe("numbers that hide inside an exemption shape", () => {
    it.each([
      ["Policy number 1234 5678 9012 3456", "Policy number ending 3456"],
      ["card 4111 1111 1111 1111", "card ending 1111"],
      ["card 4111 1111 1111 1111.", "card ending 1111."],
      ["Account 123456-7890", "Account ending 7890"],
      ["acct 1234-56-78", "acct ending 5678"],
      ["No. 1,234,567", "No. ending 4567"],
      ["Account 1234 5678", "Account ending 5678"],
      ["Account 12345 6789", "Account ending 6789"],
      ["Account\n1234\n5678", "Account\nending 5678"],
    ])("%s", (input, out) => {
      expect(maskNumbers(input)).toBe(out);
    });

    it("masks each separate number in a sentence", () => {
      expect(maskNumbers("A 1111 2222 and B 3333 4444")).toBe("A ending 2222 and B ending 4444");
    });

    it("still leaves real dates, money and phones alone", () => {
      const keep =
        "Due 2026-10-21 or 10/21/2026 or 2026-10-21 2026-11-12, $1,950 a month, $100,000 limit, " +
        "call 1-800-555-0142 or phone 800-555-0142 or fax 800.555.0142, in 2026, page 3, 30 days, Dec 5 2026";
      expect(maskNumbers(keep)).toBe(keep);
    });

    it("an impossible date is not a date", () => {
      expect(maskNumbers("Ref 2026-13-45")).toBe("Ref ending 1345");
      expect(maskNumbers("Ref 2026-02-30")).toBe("Ref ending 0230");
    });

    // Round 2 review: joiner punctuation, invisible characters and short groups still let digits through.
    it.each([
      ["1234 - 5678 - 9012", "ending 9012"],
      ["1234 / 5678 / 9012", "ending 9012"],
      ["1234 • 5678 • 9012", "ending 9012"],
      ["1234, 5678, 9012", "ending 9012"],
      ["1234. 5678. 9012", "ending 9012"],
      ["1234​ 5678​ 9012", "ending 9012"],
      ["12​34 5678 9012", "ending 9012"],
      ["123 4567", "ending 4567"],
      ["12 345 67", "ending 4567"],
      ["$4111111111111111", "ending 1111"],
      ["Account 4111-1111-1111-1111 is open", "Account ending 1111 is open"],
    ])("%j is masked", (input, out) => {
      expect(maskNumbers(input)).toBe(out);
    });

    it.each([
      "Call (555) 123-4567 today",
      "Call 800 555 0199 today",
      "limit of 25,000 miles",
      "Date of purchase: November 12, 2025",
      "Lease term: January 1, 2026 through December 31, 2026.",
      "Policy period: April 30, 2026 to October 30, 2026",
      "Due Oct 21, 2026 and again Nov 5, 2026",
      "Pay $1,850.00 by the 5th, late fee $75.00, deposit $1,850",
      "Section 3, page 12, items 4 and 5",
    ])("%j stays readable", (input) => {
      expect(maskNumbers(input)).toBe(input);
    });

    it("still masks digits split by an invisible character inside one word", () => {
      expect(maskNumbers("ref 1234­5678​9012")).toBe("ref ending 9012");
    });

    // Round 3 review: a 10 digit account number written 3-3-4 passed as a phone number, and 5 or 6 digits grouped by
    // spaces stayed readable although PRIVACY.md says any run of 5 or more digits is masked.
    it.each([
      ["acct 123 456 7890", "acct ending 7890"],
      ["acct 800-123-4567 end", "acct ending 4567 end"],
      ["account number 800.123.4567.", "account number ending 4567."],
      ["policy 555-123-4567", "policy ending 4567"],
      ["12 345", "ending 2345"],
      ["123 456", "ending 3456"],
      ["ref 12 345 closed", "ref ending 2345 closed"],
    ])("%j is masked", (input, out) => {
      expect(maskNumbers(input)).toBe(out);
    });

    it.each([
      "Call 800-123-4567 today",
      "phone: 800 123 4567",
      "Tel 800.123.4567",
      "Fax: (555) 123-4567",
      "Office (555) 123-4567",
      "Reach us at 1-800-123-4567",
      "Dial +1 800 123 4567 now",
      "contact 800-123-4567",
      "Due Oct 21 2026 and Dec 5 2026",
      "since March 12 2025 and Sept. 30 2025",
      "page 12 of 345",
      "Section 3, page 12, items 4 and 5",
    ])("%j stays readable", (input) => {
      expect(maskNumbers(input)).toBe(input);
    });

    it("stays linear on joiner heavy hostile input", () => {
      const t0 = performance.now();
      maskNumbers("1 - ".repeat(10_000));
      maskNumbers("1234, ".repeat(4_000));
      maskNumbers("​".repeat(20_000));
      maskNumbers("1234 ".repeat(4_000) + "x");
      expect(performance.now() - t0).toBeLessThan(1500);
    });

    it("stays linear on hostile input", () => {
      const t0 = performance.now();
      maskNumbers("1 ".repeat(10_000));
      maskNumbers("1234 ".repeat(4_000));
      maskNumbers("-".repeat(20_000) + "1");
      expect(performance.now() - t0).toBeLessThan(1000);
    });

    it("reaches the spoken text and the quoted clause", () => {
      expect(speak("Your policy number is 1234 5678 9012 3456.")).toBe("Your policy number is ending 3456.");
    });
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

describe("numbers typed one digit at a time", () => {
  it.each([
    ["card 4 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1", "card ending 1111"],
    ["acct 1-2-3-4-5-6-7-8", "acct ending 5678"],
    ["id 9.8.7.6.5.4.3 done", "id ending 6543 done"],
    ["pay 4 1 1 1 1 1 1 1 now", "pay ending 1111 now"],
  ])("%j is masked", (input, out) => {
    expect(maskNumbers(input)).toBe(out);
  });
  it.each([
    "on 2026-10-21 it renews",
    "Oct 21, 2026",
    "call 555-123-4567",
    "plan A 1 2 3 are options",
    "$1 2 3 4 5 6 7",
    "3 of 5 steps",
  ])("%j is left alone", (input) => {
    expect(maskNumbers(input)).toBe(input);
  });
  it("stays fast on a long run of digits and spaces", () => {
    const t = performance.now();
    maskNumbers("1 ".repeat(9000) + "x");
    maskNumbers("1 ".repeat(9000));
    expect(performance.now() - t).toBeLessThan(500);
  });
});
