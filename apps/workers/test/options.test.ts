import { describe, expect, it } from "vitest";
import { UsageError, parseToday, wholeNumber } from "../src/daily/options";

// Round 2 review: `--max-nhtsa abc` became NaN, and a comparison with NaN is always false, so the cost guard was off.
describe("wholeNumber", () => {
  it("is undefined when the option is not given", () => {
    expect(wholeNumber("max-nhtsa", undefined, 1, 100)).toBeUndefined();
  });

  it.each([
    ["1", 1],
    ["20", 20],
    ["100", 100],
  ])("accepts %s", (raw, n) => {
    expect(wholeNumber("max-nhtsa", raw, 1, 100)).toBe(n);
  });

  it.each(["abc", "", " ", "1.5", "-3", "0", "101", "1e3", "0x10", "NaN", "Infinity", "20 ", "２０", "99999999999"])(
    "refuses %j",
    (raw) => {
      expect(() => wholeNumber("max-nhtsa", raw, 1, 100)).toThrow(UsageError);
    },
  );

  it("names the option and the range in the message", () => {
    expect(() => wholeNumber("max-nhtsa", "abc", 1, 100)).toThrow(/--max-nhtsa.*1.*100/);
  });
});

describe("parseToday", () => {
  it("defaults to the real date it is given", () => {
    expect(parseToday(undefined, "2026-10-20")).toBe("2026-10-20");
  });
  it("accepts a real date", () => {
    expect(parseToday("2026-10-21", "2026-10-20")).toBe("2026-10-21");
  });
  it.each(["2026-02-30", "tomorrow", "10/21/2026", "2026-1-5", ""])("refuses %j", (raw) => {
    expect(() => parseToday(raw, "2026-10-20")).toThrow(UsageError);
  });
});
