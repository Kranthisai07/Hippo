import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CpscApiError, NhtsaApiError, normalizeCpscRecall, parseNhtsaResponse } from "../src/recalls";
import { createNhtsaClient, type HttpResponse } from "../src/recalls/clients";

const FIX = fileURLToPath(new URL("../../../fixtures/recalls/", import.meta.url));
const load = (p: string) => JSON.parse(readFileSync(`${FIX}${p}`, "utf8"));
const crv = load("nhtsa/recallsByVehicle_HONDA_CR-V_2021.json");
const row = crv.results[0];
const boon = load("cpsc/recall_26530_boon_nursh_bottles.json")[0];
const rec = (o: Record<string, unknown>) => normalizeCpscRecall({ ...boon, ...o });

describe("NHTSA: Count must be present, numeric and equal to the results (no false all-clear)", () => {
  it.each([
    ["no Count and no results", { results: [] }],
    ["Count as a string", { Count: "0", results: [] }],
    ["Count as a string that disagrees", { Count: "5", results: [row] }],
    ["Count null", { Count: null, results: [] }],
    ["no Count but a result", { results: [row] }],
    ["Count too small", { Count: 0, results: [row] }],
    ["Count too large", { Count: 3, results: [] }],
  ])("throws for %s", (_name, body) => {
    expect(() => parseNhtsaResponse(body)).toThrow(NhtsaApiError);
  });
  it("still accepts an honest empty answer and the real saved response", () => {
    expect(parseNhtsaResponse({ Count: 0, Message: "Results returned successfully", results: [] })).toEqual([]);
    expect(parseNhtsaResponse(crv)).toHaveLength(crv.Count);
  });
});

describe("CPSC: an unexpected shape throws instead of silently dropping evidence", () => {
  it.each([
    ["a numeric UPC", { ProductUPCs: [{ UPC: 123456789012 }] }],
    ["ProductUPCs as an object", { ProductUPCs: { UPC: "123456789012" } }],
    ["ProductUPCs as a string", { ProductUPCs: "123456789012" }],
    ["a null UPC entry", { ProductUPCs: [null] }],
    ["Products as an object", { Products: { Name: "Boon", Model: "B5X" } }],
    ["Products holding strings", { Products: ["Boon bottle"] }],
    ["Products holding a null", { Products: [null] }],
    ["Hazards as an object", { Hazards: { Name: "choking" } }],
    ["Importers as a string", { Importers: "Boon Inc" }],
  ])("throws for %s", (_name, o) => {
    expect(() => rec(o)).toThrow(CpscApiError);
  });
  it("still accepts absent, null and empty lists", () => {
    expect(() => rec({ ProductUPCs: null, Importers: undefined, Distributors: [], Hazards: [] })).not.toThrow();
  });
  it("still reads the real saved records", () => {
    expect(rec({}).upcs).toEqual(["00669028116546"]);
    expect(normalizeCpscRecall(load("cpsc/recall_26569_title_mismatch_record.json")[0]).recallNumber).toBe("26569");
  });
});

describe("CPSC: a UPC written with spaces is one code, and lists still split", () => {
  it("joins a space grouped UPC", () => {
    expect(rec({ ProductUPCs: [{ UPC: "0 12345 67890 5" }] }).upcs).toEqual(["00012345678905"]);
    expect(rec({ ProductUPCs: [{ UPC: "0-12345-67890-5" }] }).upcs).toEqual(["00012345678905"]);
  });
  it("splits a list on commas and semicolons, grouped or not", () => {
    const upcs = rec({ ProductUPCs: [{ UPC: "012345678905, 0 36000 29145 2; 4006381333931" }] }).upcs;
    expect(upcs).toEqual(["00012345678905", "00036000291452", "04006381333931"]);
  });
  it("splits a list separated only by spaces into codes that are each 12 to 14 digits", () => {
    expect(rec({ ProductUPCs: [{ UPC: "012345678905 036000291452" }] }).upcs).toEqual(["00012345678905", "00036000291452"]);
  });
  it("never invents a code out of short pieces", () => {
    expect(rec({ ProductUPCs: [{ UPC: "1 2 3" }] }).upcs).toEqual([]);
  });
});

describe("NHTSA pacing: a clock that goes backwards", () => {
  it("does not make the client sleep for hours", async () => {
    let t = 5_000_000;
    const slept: number[] = [];
    const res: HttpResponse = { ok: true, status: 200, json: async () => crv };
    const c = createNhtsaClient({
      now: () => t,
      sleep: async (ms) => {
        slept.push(ms);
      },
      fetch: async () => res,
    });
    const V = { make: "HONDA", model: "CR-V", year: 2021 };
    await c.recalls(V);
    t -= 86_400_000;
    await c.recalls(V);
    expect(Math.max(0, ...slept)).toBeLessThanOrEqual(250);
  });
});
