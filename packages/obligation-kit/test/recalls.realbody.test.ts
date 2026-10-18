import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CpscApiError, parseCpscResponse } from "../src";

// The body CPSC actually returned on 2026-10-18 for RecallNumber=26530: HTTP 200, one fake record, no recall data.
const dir = fileURLToPath(new URL("../../../fixtures/recalls/cpsc/", import.meta.url));
const load = (name: string) => JSON.parse(readFileSync(`${dir}${name}.json`, "utf8"));

describe("the real CPSC failure body", () => {
  it("is a database failure, so parsing throws instead of reading it as no recalls", () => {
    const body = load("error_record_http200");
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0].RecallID).toBe(0);
    expect(() => parseCpscResponse(body)).toThrow(CpscApiError);
  });
  it("still parses the real recall records saved next to it", () => {
    expect(parseCpscResponse(load("recall_26530_boon_nursh_bottles"))).toHaveLength(1);
    expect(parseCpscResponse(load("recall_26569_title_mismatch_record"))).toHaveLength(1);
  });
  it("treats a real empty array as a real empty result", () => {
    expect(parseCpscResponse([])).toEqual([]);
  });
});
