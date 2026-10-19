import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  NhtsaApiError,
  matchCpscRecall,
  normalizeCpscRecall,
  normalizeUpc,
  parseCpscResponse,
  parseNhtsaResponse,
  type RecallAsset,
} from "../src/recalls";
import { createNhtsaClient, type HttpResponse } from "../src/recalls/clients";

const FIX = fileURLToPath(new URL("../../../fixtures/recalls/", import.meta.url));
const load = (p: string) => JSON.parse(readFileSync(`${FIX}${p}`, "utf8"));
const boonRaw = load("cpsc/recall_26530_boon_nursh_bottles.json")[0];
const crv = load("nhtsa/recallsByVehicle_HONDA_CR-V_2021.json");

const rawRecall = (o: Record<string, unknown>) => normalizeCpscRecall({ RecallNumber: "77", RecallDate: "2026-01-02", ...o });
const A = (o: Partial<RecallAsset>): RecallAsset => ({ id: "a", name: "zzz", ...o });

describe("high via model needs brand and model on the SAME product", () => {
  const two = { Products: [{ Name: "Acme chair", Model: "M100" }, { Name: "Boon bottle", Model: "B5" }] };
  it("model belongs to another product than the brand", () => {
    expect(matchCpscRecall(A({ brand: "Boon", modelNumber: "M100" }), rawRecall(two))?.confidence).not.toBe("high");
  });
  it("same product is high", () => {
    expect(matchCpscRecall(A({ brand: "Acme", modelNumber: "m100" }), rawRecall(two))).toEqual({ confidence: "high", evidence: "model_brand" });
    expect(matchCpscRecall(A({ brand: "Boon", modelNumber: "b5x" }), rawRecall(two))).toBeNull();
  });
  it("Description naming the brand is not high", () => {
    const r = rawRecall({ Description: "Not made by Boon", Products: [{ Name: "Acme chair", Model: "M100" }] });
    expect(matchCpscRecall(A({ brand: "Boon", modelNumber: "M100" }), r)?.confidence).not.toBe("high");
  });
  it("Importers naming the brand is not high", () => {
    const r = rawRecall({ Importers: [{ Name: "Walmart Inc" }], Products: [{ Name: "Acme chair", Model: "M100" }] });
    expect(matchCpscRecall(A({ brand: "Walmart", modelNumber: "M100" }), r)?.confidence).not.toBe("high");
  });
  it("Manufacturers and Distributors are not high either", () => {
    for (const k of ["Manufacturers", "Distributors"]) {
      const r = rawRecall({ [k]: [{ Name: "Boon Inc" }], Products: [{ Name: "Acme chair", Model: "M100" }] });
      expect(matchCpscRecall(A({ brand: "Boon", modelNumber: "M100" }), r)?.confidence).not.toBe("high");
    }
  });
  it("brand elsewhere plus model is at most possible", () => {
    const r = rawRecall({ Importers: [{ Name: "Boon Inc" }], Products: [{ Name: "Acme chair", Model: "M100" }] });
    expect(matchCpscRecall(A({ brand: "Boon", modelNumber: "M100" }), r)?.confidence).toBe("possible");
  });
});

describe("model fold", () => {
  const hi = (model: string, asset: string) =>
    matchCpscRecall(A({ brand: "Acme", modelNumber: asset }), rawRecall({ Products: [{ Name: "Acme thing", Model: model }] }))?.confidence;
  it("1-23 and 12-3 do not collide", () => {
    expect(hi("12-3", "1-23")).toBeUndefined();
    expect(hi("1-2-34", "12-34")).toBeUndefined();
    expect(hi("AB-1-2", "AB-12")).toBeUndefined();
  });
  it("separators still match", () => {
    expect(hi("NW-DW500", "nw dw 500")).toBe("high");
    expect(hi("NW-DW500", "NW_DW/500")).toBe("high");
    expect(hi("AB.12", " ab 12 ")).toBe("high");
  });
  it("needs a letter and a digit, or 4+ characters", () => {
    expect(hi("123", "123")).toBeUndefined();
    expect(hi("ABC", "ABC")).toBeUndefined();
    expect(hi("A1", "A1")).toBe("high");
    expect(hi("1234", "1234")).toBe("high");
    expect(hi("ABCD", "abcd")).toBe("high");
  });
});

describe("UPC guards", () => {
  const upcRecall = (u: string) => rawRecall({ ProductUPCs: [{ UPC: u }] });
  it("rejects all-zero values", () => {
    expect(normalizeUpc("00000000")).toBeNull();
    expect(normalizeUpc("000000000000")).toBeNull();
    expect(matchCpscRecall(A({ upc: "00000000" }), upcRecall("000000000000"))).toBeNull();
  });
  it("never pads 8 digit values", () => {
    expect(normalizeUpc("12345678")).toBeNull();
    expect(matchCpscRecall(A({ upc: "12345678" }), upcRecall("000012345678"))).toBeNull();
    expect(matchCpscRecall(A({ upc: "12345678" }), upcRecall("12345678"))).toBeNull();
  });
  it("pads only 12, 13 and 14 digits", () => {
    expect(normalizeUpc("012345678905")).toBe("00012345678905");
    expect(normalizeUpc("0012345678905")).toBe("00012345678905");
    for (const bad of ["12345678901", "123456789012345", "1234567890"]) expect(normalizeUpc(bad)).toBeNull();
  });
  it("a recall UPC list gives every candidate", () => {
    const r = upcRecall("012345678905, 669028116546; 036000291452 0123456789012");
    expect(r.upcs).toEqual(["00012345678905", "00669028116546", "00036000291452", "00123456789012"]);
    expect(matchCpscRecall(A({ upc: "669028116546" }), r)).toEqual({ confidence: "high", evidence: "upc" });
  });
});

describe("brand guards", () => {
  it("a one letter or stopword brand never matches", () => {
    const r = rawRecall({ Description: "A recall of chairs", Products: [{ Name: "XYZ chair", Model: "XYZ1" }] });
    for (const brand of ["A", "a", "The", "Co", "Inc", "of", "-", "A Co"]) {
      expect(matchCpscRecall(A({ name: "chairs", brand, modelNumber: "XYZ1" }), r)).toBeNull();
    }
  });
});

describe("CPSC ceiling", () => {
  it("an array of exactly maxRecords is truncation", () => {
    const many = Array.from({ length: 2000 }, (_, i) => ({ ...boonRaw, RecallID: i + 1, RecallNumber: String(i + 1) }));
    expect(() => parseCpscResponse(many)).toThrow(/ceiling/);
    expect(parseCpscResponse(many.slice(0, 1999))).toHaveLength(1999);
  });
});

const nraw = () => ({
  Count: 1,
  Message: "ok",
  results: [{ NHTSACampaignNumber: "26V1", ReportReceivedDate: "21/05/2026", Component: "X", Summary: "s", Consequence: "c", Remedy: "r", Manufacturer: "m", Make: "HONDA", Model: "CR-V", ModelYear: "2021" }],
});

describe("NHTSA body integrity", () => {
  it("Count that differs from results is truncation", () => {
    expect(() => parseNhtsaResponse({ Count: 5, Message: "x", results: [] })).toThrow(NhtsaApiError);
    expect(() => parseNhtsaResponse({ ...nraw(), Count: 2 })).toThrow(NhtsaApiError);
  });
  it("a Count that matches is accepted; absent or non-numeric is not (see recalls.review3.test.ts)", () => {
    expect(parseNhtsaResponse({ Count: 0, results: [] })).toEqual([]);
    expect(() => parseNhtsaResponse({ results: [] })).toThrow(NhtsaApiError);
    expect(() => parseNhtsaResponse({ ...nraw(), Count: "1" })).toThrow(NhtsaApiError);
  });
  it.each([{ Count: 0 }, { Count: 0, results: null }, { Count: 0, results: {} }])("throws when results is missing or not a list %j", (b) => {
    expect(() => parseNhtsaResponse(b)).toThrow(NhtsaApiError);
  });
});

describe("NHTSA pacing under concurrency", () => {
  it("four concurrent calls on one client are spaced 250 ms apart", async () => {
    let t = 1_000_000;
    const timers: { at: number; resolve: () => void }[] = [];
    const at: number[] = [];
    const res: HttpResponse = { ok: true, status: 200, json: async () => crv };
    const c = createNhtsaClient({
      now: () => t,
      sleep: (ms) => new Promise<void>((resolve) => timers.push({ at: t + ms, resolve })),
      fetch: async () => {
        at.push(t);
        return res;
      },
    });
    const V = { make: "HONDA", model: "CR-V", year: 2021 };
    const all = Promise.all([c.recalls(V), c.recalls(V), c.recalls(V), c.recalls(V)]);
    // Fake clock: let work settle, then jump to the earliest timer.
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setImmediate(r));
      timers.sort((x, y) => x.at - y.at);
      const next = timers.shift();
      if (next) {
        t = Math.max(t, next.at);
        next.resolve();
      }
    }
    await all;
    expect(at.map((x) => x - at[0]!)).toEqual([0, 250, 500, 750]);
  });
});
