import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  NhtsaApiError,
  canonicalizeVehicle,
  matchNhtsaRecall,
  modelsUrl,
  nhtsaSpeech,
  parseNhtsaResponse,
  recallsByVehicleUrl,
  type NhtsaRecall,
  type RecallAsset,
} from "../src/recalls";

const FIX = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
const load = (p: string) => JSON.parse(readFileSync(`${FIX}${p}`, "utf8"));
const crv = load("recalls/nhtsa/recallsByVehicle_HONDA_CR-V_2021.json");
const zero = load("recalls/nhtsa/recallsByVehicle_HONDA_CRV_2021_zero_results.json");
const models = load("recalls/nhtsa/models_HONDA_2021_issueType-r.json");
const car = (load("expected/assets.json") as RecallAsset[]).find((a) => a.id === "A-car")!;

const rec = (o: Partial<NhtsaRecall> = {}): NhtsaRecall => ({
  recallId: "26V332000",
  reportDate: "2026-05-21",
  component: "SEAT BELTS:REAR/OTHER:RETRACTOR",
  summary: "s",
  consequence: "c",
  remedy: "r",
  manufacturer: "Honda",
  make: "HONDA",
  model: "CR-V",
  modelYear: 2021,
  ...o,
});
const raw = (o: Record<string, unknown> = {}) => ({
  Count: 1,
  Message: "ok",
  results: [
    {
      NHTSACampaignNumber: "26V1",
      ReportReceivedDate: "21/05/2026",
      Component: "X",
      Summary: "s",
      Consequence: "c",
      Remedy: "r",
      Manufacturer: "m",
      Make: "HONDA",
      Model: "CR-V",
      ModelYear: "2021",
      ...o,
    },
  ],
});
const mm = (rows: [string, string][], year = "2021") => ({
  count: rows.length,
  message: "ok",
  results: rows.map(([make, model]) => ({ modelYear: year, make, model })),
});

describe("urls", () => {
  it("recallsByVehicleUrl", () => {
    expect(recallsByVehicleUrl({ make: "HONDA", model: "CR-V", year: 2021 })).toBe(
      "https://api.nhtsa.gov/recalls/recallsByVehicle?make=HONDA&model=CR-V&modelYear=2021",
    );
  });
  it("modelsUrl", () => {
    expect(modelsUrl({ make: "HONDA", year: 2021 })).toBe(
      "https://api.nhtsa.gov/products/vehicle/models?modelYear=2021&make=HONDA&issueType=r",
    );
  });
  it("encodes spaces", () => {
    expect(recallsByVehicleUrl({ make: "LAND ROVER", model: "RANGE ROVER", year: 2020 })).toContain("make=LAND+ROVER");
  });
  it.each([
    ["blank make", { make: " ", model: "CR-V", year: 2021 }],
    ["blank model", { make: "HONDA", model: "", year: 2021 }],
    ["non-integer year", { make: "HONDA", model: "CR-V", year: 2021.5 }],
    ["year as string", { make: "HONDA", model: "CR-V", year: "2021" as unknown as number }],
    ["year too low", { make: "HONDA", model: "CR-V", year: 1885 }],
    ["year too high", { make: "HONDA", model: "CR-V", year: 2101 }],
    ["NaN year", { make: "HONDA", model: "CR-V", year: NaN }],
  ])("recallsByVehicleUrl throws on %s", (_n, v) => {
    expect(() => recallsByVehicleUrl(v)).toThrow(NhtsaApiError);
  });
  it("accepts the year bounds", () => {
    expect(() => recallsByVehicleUrl({ make: "A", model: "B", year: 1886 })).not.toThrow();
    expect(() => recallsByVehicleUrl({ make: "A", model: "B", year: 2100 })).not.toThrow();
  });
  it("modelsUrl validates", () => {
    expect(() => modelsUrl({ make: "", year: 2021 })).toThrow(NhtsaApiError);
    expect(() => modelsUrl({ make: "HONDA", year: 0 })).toThrow(NhtsaApiError);
  });
});

describe("canonicalizeVehicle", () => {
  it("resolves CRV to CR-V against the real model list", () => {
    expect(canonicalizeVehicle({ make: "Honda", model: "CRV", year: 2021 }, models)).toEqual({
      nhtsaMake: "HONDA",
      nhtsaModel: "CR-V",
    });
  });
  it("is case and spacing insensitive", () => {
    expect(canonicalizeVehicle({ make: "honda", model: "cr v", year: 2021 }, models)).toEqual({
      nhtsaMake: "HONDA",
      nhtsaModel: "CR-V",
    });
  });
  it("does not confuse CR-V with CR-V HYBRID", () => {
    expect(canonicalizeVehicle({ make: "HONDA", model: "CR-V Hybrid", year: 2021 }, models)?.nhtsaModel).toBe(
      "CR-V HYBRID",
    );
  });
  it("duplicate rows of one spelling are fine", () => {
    const r = mm([
      ["FORD", "F-150"],
      ["FORD", "F-150"],
    ]);
    expect(canonicalizeVehicle({ make: "Ford", model: "F150", year: 2021 }, r)).toEqual({
      nhtsaMake: "FORD",
      nhtsaModel: "F-150",
    });
  });
  it("null when nothing matches", () => {
    expect(canonicalizeVehicle({ make: "Honda", model: "Nonexistent", year: 2021 }, models)).toBeNull();
    expect(canonicalizeVehicle({ make: "Toyota", model: "CRV", year: 2021 }, models)).toBeNull();
  });
  it("null when two different spellings fold the same", () => {
    const r = mm([
      ["HONDA", "CR-V"],
      ["HONDA", "CRV"],
    ]);
    expect(canonicalizeVehicle({ make: "Honda", model: "CRV", year: 2021 }, r)).toBeNull();
  });
  it("null when two make spellings fold the same", () => {
    const r = mm([
      ["LAND ROVER", "X"],
      ["LANDROVER", "X"],
    ]);
    expect(canonicalizeVehicle({ make: "Land Rover", model: "X", year: 2021 }, r)).toBeNull();
  });
  it("ignores rows for another model year", () => {
    expect(canonicalizeVehicle({ make: "HONDA", model: "CR-V", year: 2020 }, models)).toBeNull();
  });
  it("empty results gives null", () => {
    expect(
      canonicalizeVehicle({ make: "HONDA", model: "CR-V", year: 2021 }, { count: 0, message: "ok", results: [] }),
    ).toBeNull();
  });
  it.each([null, {}, "x", { results: "no" }])("throws on malformed response %j", (b) => {
    expect(() => canonicalizeVehicle({ make: "HONDA", model: "CR-V", year: 2021 }, b)).toThrow(NhtsaApiError);
  });
  it("a blank model never resolves", () => {
    expect(canonicalizeVehicle({ make: "HONDA", model: "  ", year: 2021 }, models)).toBeNull();
  });
});

describe("parseNhtsaResponse", () => {
  const parsed = parseNhtsaResponse(crv);
  it("reads the four Honda campaigns", () => {
    expect(parsed.map((r) => r.recallId).sort()).toEqual(["21V900000", "23V858000", "24V064000", "26V332000"]);
  });
  it("converts DD/MM/YYYY to ISO", () => {
    expect(parsed.find((r) => r.recallId === "26V332000")?.reportDate).toBe("2026-05-21");
    expect(parsed.find((r) => r.recallId === "24V064000")?.reportDate).toBe("2024-02-01");
  });
  it("campaign number is the recall id, year is a number", () => {
    expect(parsed[0]?.modelYear).toBe(2021);
    expect(typeof parsed[0]?.recallId).toBe("string");
  });
  it("zero results is an empty list", () => {
    expect(parseNhtsaResponse(zero)).toEqual([]);
  });
  it.each([
    "2026-05-21",
    "21-05-2026",
    "5/21/2026",
    "31/02/2026",
    "00/05/2026",
    "21/13/2026",
    "21/05/26",
    "",
    "ab/cd/efgh",
  ])("throws on date %j", (d) => {
    expect(() => parseNhtsaResponse(raw({ ReportReceivedDate: d }))).toThrow(NhtsaApiError);
  });
  it("accepts a leap day and rejects a non-leap one", () => {
    expect(parseNhtsaResponse(raw({ ReportReceivedDate: "29/02/2024" }))[0]?.reportDate).toBe("2024-02-29");
    expect(() => parseNhtsaResponse(raw({ ReportReceivedDate: "29/02/2026" }))).toThrow(NhtsaApiError);
  });
  it.each([null, undefined, [], "x", {}, { results: {} }])("throws on malformed body %j", (b) => {
    expect(() => parseNhtsaResponse(b)).toThrow(NhtsaApiError);
  });
  it("throws without a campaign number", () => {
    expect(() => parseNhtsaResponse(raw({ NHTSACampaignNumber: "" }))).toThrow(NhtsaApiError);
    expect(() => parseNhtsaResponse(raw({ NHTSACampaignNumber: undefined }))).toThrow(NhtsaApiError);
  });
  it("throws on a non-numeric ModelYear", () => {
    expect(() => parseNhtsaResponse(raw({ ModelYear: "20x1" }))).toThrow(NhtsaApiError);
  });
  it("throws on a non-object result row", () => {
    expect(() => parseNhtsaResponse({ results: [null] })).toThrow(NhtsaApiError);
  });
});

describe("matchNhtsaRecall", () => {
  const recalls = parseNhtsaResponse(crv);
  it("seeded Honda is high for all four campaigns, may affect", () => {
    for (const r of recalls)
      expect(matchNhtsaRecall(car, r)).toMatchObject({
        confidence: "high",
        wording: "may_affect",
        recallId: r.recallId,
      });
    expect(recalls.filter((r) => matchNhtsaRecall(car, r))).toHaveLength(4);
  });
  it("different year is null", () => {
    expect(matchNhtsaRecall(car, rec({ modelYear: 2020 }))).toBeNull();
    expect(matchNhtsaRecall(car, rec({ modelYear: 2022 }))).toBeNull();
  });
  it("different model is null", () => {
    expect(matchNhtsaRecall(car, rec({ model: "CR-V HYBRID" }))).toBeNull();
    expect(matchNhtsaRecall(car, rec({ model: "CRV" }))).toBeNull();
  });
  it("different make is null", () => {
    expect(matchNhtsaRecall(car, rec({ make: "TOYOTA" }))).toBeNull();
  });
  it("is case insensitive on make and model", () => {
    const a = { id: "c", name: "Car", vehicle: { nhtsaMake: "Honda", nhtsaModel: "cr-v", modelYear: 2021 } };
    expect(matchNhtsaRecall(a, rec())?.confidence).toBe("high");
  });
  it.each([
    ["no vehicle", { id: "c", name: "Car" }],
    ["null vehicle", { id: "c", name: "Car", vehicle: null }],
    ["no canonical make", { id: "c", name: "Car", vehicle: { nhtsaModel: "CR-V", modelYear: 2021 } }],
    ["no canonical model", { id: "c", name: "Car", vehicle: { nhtsaMake: "HONDA", modelYear: 2021 } }],
    ["no year", { id: "c", name: "Car", vehicle: { nhtsaMake: "HONDA", nhtsaModel: "CR-V" } }],
    ["blank make", { id: "c", name: "Car", vehicle: { nhtsaMake: " ", nhtsaModel: "CR-V", modelYear: 2021 } }],
  ])("%s is null", (_n, a) => {
    expect(matchNhtsaRecall(a as RecallAsset, rec())).toBeNull();
  });
});

describe("nhtsaSpeech", () => {
  const s = nhtsaSpeech(rec(), "Honda CR-V");
  const count = (t: string) => t.split(/\s+/).filter(Boolean).length;
  it("says may affect and points to the VIN check on NHTSA", () => {
    expect(s).toMatch(/may affect/i);
    expect(s).toMatch(/VIN/);
    expect(s).toMatch(/NHTSA/);
  });
  it("is one short sentence", () => {
    expect(count(s)).toBeLessThan(45);
    expect(s.match(/[.!?]/g)?.length).toBe(1);
    expect(s.trim().endsWith(".")).toBe(true);
  });
  it("has no url or markdown", () => {
    expect(s).not.toMatch(/https?:|www\.|\.gov|\.com/);
    expect(s).not.toMatch(/[*_`#\[\]<>|]/);
  });
  it("names the component in plain words", () => {
    expect(s.toLowerCase()).toContain("seat belts");
    expect(s).not.toContain(":");
  });
  it("sanitizes a hostile label and a long component", () => {
    const t = nhtsaSpeech(
      rec({ component: "A".repeat(500) + ":B" }),
      "**Car** [x](https://evil.example.com) " + "word ".repeat(80),
    );
    expect(count(t)).toBeLessThan(45);
    expect(t).not.toMatch(/https?:|\*|\[|\]|\(|\)/);
    expect(t).toMatch(/may affect/i);
  });
  it("handles an empty component", () => {
    const t = nhtsaSpeech(rec({ component: "" }), "car");
    expect(t).toMatch(/may affect/i);
    expect(count(t)).toBeLessThan(45);
  });
  it("never claims the car is definitely recalled", () => {
    expect(s).not.toMatch(/your .* is (being )?recalled|has been recalled/i);
  });
});
