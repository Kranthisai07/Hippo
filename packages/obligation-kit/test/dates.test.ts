import { describe, expect, it } from "vitest";
import { addDays, addMonths, daysBetween, isBusinessDay, isFederalHoliday, parseIso, subtractBusinessDays } from "../src";

describe("parseIso", () => {
  it.each(["2026-10-21", "2028-02-29", "1999-12-31"])("accepts %s", (s) => {
    expect(parseIso(s)).not.toBeNull();
  });
  it.each(["2026-02-29", "2026-13-01", "2026-00-10", "2026-1-1", "10/21/2026", "0999-01-01", "", "2026-10-21T00:00"])(
    "rejects %s",
    (s) => {
      expect(parseIso(s)).toBeNull();
    },
  );
  it.each([null, undefined, 20261021, {}])("rejects non-string %s", (v) => {
    expect(parseIso(v)).toBeNull();
  });
});

describe("addDays and daysBetween", () => {
  it("crosses month and year ends", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
  });
  it("handles leap days", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2027-02-28", 1)).toBe("2027-03-01");
  });
  it("counts whole days in both directions", () => {
    expect(daysBetween("2026-10-21", "2026-10-30")).toBe(9);
    expect(daysBetween("2026-10-30", "2026-10-21")).toBe(-9);
    expect(daysBetween("2026-10-21", "2026-10-21")).toBe(0);
  });
  it("is not thrown off by a daylight saving change", () => {
    expect(daysBetween("2026-03-01", "2026-04-01")).toBe(31);
    expect(daysBetween("2026-10-30", "2026-11-02")).toBe(3);
  });
  it("throws on an invalid date", () => {
    expect(() => addDays("2026-02-30", 1)).toThrow(RangeError);
  });
});

describe("addMonths", () => {
  it("clamps month ends", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonths("2026-08-31", -2)).toBe("2026-06-30");
  });
  it("rolls a leap day to the next non-leap February", () => {
    expect(addMonths("2028-02-29", 12)).toBe("2029-02-28");
  });
  it("crosses year boundaries both ways", () => {
    expect(addMonths("2026-12-15", 13)).toBe("2028-01-15");
    expect(addMonths("2026-01-15", -1)).toBe("2025-12-15");
  });
  it("adds zero months unchanged", () => {
    expect(addMonths("2026-10-21", 0)).toBe("2026-10-21");
  });
});

describe("federal holidays", () => {
  it.each([
    ["2026-01-01", "New Year's Day"],
    ["2026-01-19", "MLK Day"],
    ["2026-02-16", "Washington's Birthday"],
    ["2026-05-25", "Memorial Day"],
    ["2026-06-19", "Juneteenth"],
    ["2026-07-03", "Independence Day observed (Jul 4 is a Saturday)"],
    ["2026-09-07", "Labor Day"],
    ["2026-10-12", "Columbus Day"],
    ["2026-11-11", "Veterans Day"],
    ["2026-11-26", "Thanksgiving"],
    ["2026-12-25", "Christmas"],
    ["2022-12-26", "Christmas observed (Dec 25 is a Sunday)"],
    ["2027-12-31", "New Year 2028 observed on the prior Dec 31"],
    ["2021-06-18", "Juneteenth observed (Jun 19 is a Saturday)"],
  ])("%s is a holiday: %s", (iso) => {
    expect(isFederalHoliday(iso)).toBe(true);
  });
  it("does not count Juneteenth before it became a holiday", () => {
    expect(isFederalHoliday("2020-06-19")).toBe(false);
  });
  it("does not count an ordinary day", () => {
    expect(isFederalHoliday("2026-10-21")).toBe(false);
  });
});

describe("business days", () => {
  it("excludes weekends and holidays", () => {
    expect(isBusinessDay("2026-10-21")).toBe(true);
    expect(isBusinessDay("2026-10-24")).toBe(false);
    expect(isBusinessDay("2026-10-25")).toBe(false);
    expect(isBusinessDay("2026-11-26")).toBe(false);
  });
  it("steps back across a weekend", () => {
    expect(subtractBusinessDays("2026-10-19", 1)).toBe("2026-10-16");
  });
  it("skips a Monday holiday and the weekend before it", () => {
    expect(subtractBusinessDays("2026-10-13", 1)).toBe("2026-10-09");
  });
  it("skips Thanksgiving", () => {
    expect(subtractBusinessDays("2026-11-27", 1)).toBe("2026-11-25");
  });
  it("skips Christmas and counts five business days from Dec 31", () => {
    expect(subtractBusinessDays("2026-12-31", 5)).toBe("2026-12-23");
  });
  it("returns the same date for zero days", () => {
    expect(subtractBusinessDays("2026-10-24", 0)).toBe("2026-10-24");
  });
  it("always lands on a business day", () => {
    for (const n of [1, 3, 10, 60]) expect(isBusinessDay(subtractBusinessDays("2026-12-31", n))).toBe(true);
  });
});
