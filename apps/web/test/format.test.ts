import { describe, expect, it } from "vitest";
import { readableDate } from "../src/lib/format";

describe("readableDate", () => {
  it("writes an ISO day the way a person says it", () => {
    expect(readableDate("2026-11-03")).toBe("Nov 3, 2026");
    expect(readableDate("2026-12-31")).toBe("Dec 31, 2026");
  });
  it("leaves anything else alone", () => {
    expect(readableDate("soon")).toBe("soon");
    expect(readableDate("2026-13-01")).toBe("2026-13-01");
  });
});
