import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CpscApiError,
  buildCpscUrl,
  filterByHazard,
  matchCpscRecall,
  matchCpscRecalls,
  normalizeCpscRecall,
  normalizeUpc,
  parseCpscResponse,
  type CpscRecall,
  type RecallAsset,
} from "../src/recalls";

const FIX = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
const load = (p: string) => JSON.parse(readFileSync(`${FIX}${p}`, "utf8"));
const boonRaw = load("recalls/cpsc/recall_26530_boon_nursh_bottles.json")[0];
const mismatchRaw = load("recalls/cpsc/recall_26569_title_mismatch_record.json")[0];
const seeded = load("expected/assets.json") as RecallAsset[];
const asset = (id: string) => seeded.find((a) => a.id === id)!;

// Same shape as the real captured body: one fake record, RecallID 0, no RecallNumber.
const errorRecord = [
  { RecallID: 0, RecallNumber: null, RecallDate: null, Title: "Error retrieving Recalls: The underlying provider failed on Open.", Products: [], ProductUPCs: [], Hazards: [], Remedies: [] },
];

const recall = (o: Partial<CpscRecall> = {}): CpscRecall => ({
  recallNumber: "1",
  recallDate: "2026-01-01",
  title: "",
  url: "",
  productNames: [],
  models: [],
  upcs: [],
  hazards: [],
  remedies: [],
  brandEvidence: [],
  ...o,
});

describe("buildCpscUrl", () => {
  it("always sends format=json", () => {
    expect(buildCpscUrl({})).toBe("https://www.saferproducts.gov/RestWebServices/Recall?format=json");
  });
  it.each(["RecallDateStart", "RecallDateEnd", "RecallNumber", "ProductName"])("allows %s", (k) => {
    expect(buildCpscUrl({ [k]: "x" })).toContain(`${k}=x`);
  });
  it("encodes values", () => {
    expect(buildCpscUrl({ ProductName: "baby & bottle" })).toContain("ProductName=baby+%26+bottle");
  });
  it.each(["UPC", "LastPublishDateStart", "LastPublishDateEnd", "format", "recalldatestart", "Foo"])("throws on %s", (k) => {
    expect(() => buildCpscUrl({ [k]: "x" })).toThrow(CpscApiError);
  });
  it.each(["", "   "])("throws on empty value %j", (v) => {
    expect(() => buildCpscUrl({ ProductName: v })).toThrow(CpscApiError);
  });
  it("throws on a non-string value", () => {
    expect(() => buildCpscUrl({ RecallNumber: 5 as unknown as string })).toThrow(CpscApiError);
  });
});

describe("parseCpscResponse", () => {
  it("a real empty result is []", () => {
    expect(parseCpscResponse([])).toEqual([]);
  });
  it("passes real records through", () => {
    expect(parseCpscResponse([boonRaw, mismatchRaw])).toHaveLength(2);
  });
  it("throws on the error record, never an empty list", () => {
    expect(() => parseCpscResponse(errorRecord)).toThrow(CpscApiError);
  });
  it("throws on the error record with a real record beside it", () => {
    expect(() => parseCpscResponse([boonRaw, errorRecord[0]])).toThrow(CpscApiError);
  });
  it("throws on RecallID 0 even with a RecallNumber", () => {
    expect(() => parseCpscResponse([{ ...boonRaw, RecallID: 0 }])).toThrow(CpscApiError);
  });
  it.each([null, undefined, "", "  "])("throws on RecallNumber %j", (n) => {
    expect(() => parseCpscResponse([{ ...boonRaw, RecallNumber: n }])).toThrow(CpscApiError);
  });
  it.each([null, undefined, {}, "x", 5, { Message: "oops" }])("throws on non-array body %j", (b) => {
    expect(() => parseCpscResponse(b)).toThrow(CpscApiError);
  });
  it("throws on a non-object record", () => {
    expect(() => parseCpscResponse([null])).toThrow(CpscApiError);
  });
  it("default ceiling is 2000", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ...boonRaw, RecallID: i + 1, RecallNumber: String(i + 1) }));
    expect(parseCpscResponse(many(2000))).toHaveLength(2000);
    expect(() => parseCpscResponse(many(2001))).toThrow(CpscApiError);
  });
  it("honours maxRecords", () => {
    expect(() => parseCpscResponse([boonRaw, mismatchRaw], { maxRecords: 1 })).toThrow(/ceiling/);
    expect(parseCpscResponse([boonRaw], { maxRecords: 1 })).toHaveLength(1);
  });
  it("error message does not echo the body", () => {
    expect(() => parseCpscResponse(errorRecord)).toThrow(/^(?!.*underlying provider)/);
  });
});

describe("normalizeUpc", () => {
  it("pads UPC-A to 14", () => expect(normalizeUpc("669028116546")).toBe("00669028116546"));
  it("pads EAN-13 to the same value", () => expect(normalizeUpc("0669028116546")).toBe("00669028116546"));
  it("is already 14", () => expect(normalizeUpc("00669028116546")).toBe("00669028116546"));
  it("strips spaces and dashes", () => expect(normalizeUpc("6 69028-116546")).toBe("00669028116546"));
  it("accepts EAN-8 length", () => expect(normalizeUpc("12345678")).toBe("00000012345678"));
  it.each([null, undefined, "", "abc", "1234567", "123456789012345"])("rejects %j", (v) => {
    expect(normalizeUpc(v)).toBeNull();
  });
});

describe("normalizeCpscRecall", () => {
  const n = normalizeCpscRecall(boonRaw);
  it("reads number and ISO date", () => {
    expect(n.recallNumber).toBe("26530");
    expect(n.recallDate).toBe("2026-06-04");
  });
  it("normalizes upcs", () => expect(n.upcs).toEqual(["00669028116546"]));
  it("reads product names, hazards, remedies", () => {
    expect(n.productNames).toEqual(["Boon NURSH 8 oz Reusable Baby Bottles"]);
    expect(n.hazards[0]).toContain("choking hazard");
    expect(n.remedies[0]).toContain("refund");
  });
  it("empty Model gives no models", () => expect(n.models).toEqual([]));
  it("structured Models are kept, empties dropped", () => {
    const m = normalizeCpscRecall({ ...boonRaw, Products: [{ Name: "A", Model: "B11654" }, { Name: "B", Model: " " }, { Name: "C" }] });
    expect(m.models).toEqual(["B11654"]);
  });
  it("brand evidence has products, description, importers but never Title or retailers", () => {
    const ev = n.brandEvidence.join(" | ");
    expect(ev).toContain("Boon NURSH 8 oz");
    expect(ev).toContain("TOMY International");
    expect(ev).not.toContain("Walmart stores");
    expect(ev).not.toContain("Choking Hazard; Sold at Walmart");
  });
  it("includes manufacturers and distributors", () => {
    const m = normalizeCpscRecall({ ...boonRaw, Manufacturers: [{ Name: "MfgCo" }], Distributors: [{ Name: "DistCo" }] });
    expect(m.brandEvidence).toEqual(expect.arrayContaining(["MfgCo", "DistCo"]));
  });
  it("tolerates missing arrays", () => {
    const m = normalizeCpscRecall({ RecallNumber: "9", RecallDate: "2026-01-02T00:00:00" });
    expect(m.upcs).toEqual([]);
    expect(m.hazards).toEqual([]);
  });
  it("throws on a malformed date", () => {
    expect(() => normalizeCpscRecall({ ...boonRaw, RecallDate: "June 4" })).toThrow(CpscApiError);
  });
  it("throws without a RecallNumber", () => {
    expect(() => normalizeCpscRecall({ ...boonRaw, RecallNumber: null })).toThrow(CpscApiError);
  });
});

describe("matchCpscRecall: high", () => {
  const boon = normalizeCpscRecall(boonRaw);
  it("seeded Boon bottles match 26530 on UPC", () => {
    expect(matchCpscRecall(asset("A-baby-bottles"), boon)).toEqual({ confidence: "high", evidence: "upc" });
  });
  it("UPC-A and EAN-13 assets both match", () => {
    const r = recall({ upcs: ["00669028116546"] });
    expect(matchCpscRecall({ id: "a", name: "x", upc: "0669028116546" }, r)?.evidence).toBe("upc");
    expect(matchCpscRecall({ id: "a", name: "x", upc: "669028116546" }, r)?.evidence).toBe("upc");
  });
  it("UPC wins even with a different brand and name", () => {
    expect(matchCpscRecall({ id: "a", name: "Thing", brand: "Other", upc: "669028116546" }, boon)?.confidence).toBe("high");
  });
  it("a different UPC does not match by itself", () => {
    expect(matchCpscRecall({ id: "a", name: "Thing", upc: "012345678905" }, boon)).toBeNull();
  });
  const withModel = recall({ models: ["B-11654"], productNames: ["Boon Widget"], brandEvidence: ["Boon Widget"] });
  it("model plus brand is high", () => {
    expect(matchCpscRecall({ id: "a", name: "x", brand: "Boon", modelNumber: "b11654" }, withModel)).toEqual({ confidence: "high", evidence: "model_brand" });
  });
  it("model folds spaces, case and punctuation", () => {
    expect(matchCpscRecall({ id: "a", name: "x", brand: "boon", modelNumber: " B 11.654 " }, withModel)?.confidence).toBe("high");
  });
  it("model without brand is not high", () => {
    expect(matchCpscRecall({ id: "a", name: "x", modelNumber: "B11654" }, withModel)).toBeNull();
  });
  it("model with the wrong brand is not high", () => {
    const m = matchCpscRecall({ id: "a", name: "x", brand: "Acme", modelNumber: "B11654" }, withModel);
    expect(m?.confidence).not.toBe("high");
  });
  it("model shorter than 3 characters never matches", () => {
    const r = recall({ models: ["X1"], brandEvidence: ["Boon"] });
    expect(matchCpscRecall({ id: "a", name: "x", brand: "Boon", modelNumber: "X1" }, r)).toBeNull();
  });
  it("model that only appears in the Description is not structured evidence", () => {
    const r = recall({ brandEvidence: ["Boon item number B11654"] });
    expect(matchCpscRecall({ id: "a", name: "zzz", brand: "Boon", modelNumber: "B11654" }, r)).toBeNull();
  });
  it("brand is whole word for model matches", () => {
    const r = recall({ models: ["B11654"], brandEvidence: ["Boone Widget"] });
    expect(matchCpscRecall({ id: "a", name: "x", brand: "Boon", modelNumber: "B11654" }, r)).toBeNull();
  });
});

describe("matchCpscRecall: possible and none", () => {
  const boon = normalizeCpscRecall(boonRaw);
  it("brand plus shared content word is possible", () => {
    expect(matchCpscRecall({ id: "a", name: "Boon baby bottle", brand: "Boon" }, boon)).toEqual({ confidence: "possible", evidence: "brand_name" });
  });
  it("seeded asset without UPC would be possible by name", () => {
    expect(matchCpscRecall({ ...asset("A-baby-bottles"), upc: null }, boon)?.confidence).toBe("possible");
  });
  it("brand alone is null", () => {
    expect(matchCpscRecall({ id: "a", name: "Boon grass drying rack", brand: "Boon" }, boon)).toBeNull();
  });
  it("name overlap without brand is null", () => {
    expect(matchCpscRecall({ id: "a", name: "baby bottles", brand: "Dr Browns" }, boon)).toBeNull();
    expect(matchCpscRecall({ id: "a", name: "baby bottles" }, boon)).toBeNull();
  });
  it("stopwords do not count as overlap", () => {
    expect(matchCpscRecall({ id: "a", name: "the baby set", brand: "Boon" }, recall({ productNames: ["Boon the set"], brandEvidence: ["Boon"] }))).toBeNull();
  });
  it("brand words do not count as overlap", () => {
    expect(matchCpscRecall({ id: "a", name: "Boon", brand: "Boon" }, boon)).toBeNull();
  });
  it("whole word: Boon does not match Boone", () => {
    const r = recall({ productNames: ["Boone baby bottles"], brandEvidence: ["Boone baby bottles"] });
    expect(matchCpscRecall({ id: "a", name: "baby bottles", brand: "Boon" }, r)).toBeNull();
  });
  it("whole word: Boone does not match Boon", () => {
    expect(matchCpscRecall({ id: "a", name: "baby bottles", brand: "Boone" }, boon)).toBeNull();
  });
  it("multi-word brands match as a sequence", () => {
    const r = recall({ productNames: ["Dr Browns baby bottles"], brandEvidence: ["Dr. Brown's baby bottles"] });
    expect(matchCpscRecall({ id: "a", name: "baby bottles", brand: "Dr. Brown's" }, r)?.confidence).toBe("possible");
  });
  it("brand spread over two fields does not match", () => {
    const r = recall({ productNames: ["baby bottles"], brandEvidence: ["Dr", "Brown baby bottles"] });
    expect(matchCpscRecall({ id: "a", name: "baby bottles", brand: "Dr Brown" }, r)).toBeNull();
  });
  it("plural and singular overlap", () => {
    expect(matchCpscRecall({ id: "a", name: "bottle", brand: "Boon" }, boon)?.confidence).toBe("possible");
  });
  it("asset without brand or name overlap is null", () => {
    expect(matchCpscRecall({ id: "a", name: "Dishwasher" }, boon)).toBeNull();
  });
  it("blank brand is treated as absent", () => {
    expect(matchCpscRecall({ id: "a", name: "baby bottles", brand: "  " }, boon)).toBeNull();
  });
});

describe("Title is never brand evidence", () => {
  const joolz = normalizeCpscRecall(mismatchRaw);
  it("record 26569 title says Joolz but it is CooCooBaby", () => {
    expect(joolz.title).toContain("Joolz");
    expect(joolz.brandEvidence.join(" ")).not.toMatch(/joolz/i);
  });
  it("a Joolz asset does not match", () => {
    expect(matchCpscRecall({ id: "a", name: "Aer2 car seat adapters", brand: "Joolz" }, joolz)).toBeNull();
    expect(matchCpscRecall({ id: "a", name: "stroller adapters", brand: "Joolz", modelNumber: "AER2" }, joolz)).toBeNull();
  });
  it("a CooCooBaby asset does match", () => {
    expect(matchCpscRecall({ id: "a", name: "baby lounger", brand: "CooCooBaby" }, joolz)?.confidence).toBe("possible");
  });
  it("no seeded asset matches 26569", () => {
    for (const a of seeded) expect(matchCpscRecall(a, joolz)).toBeNull();
  });
});

describe("matchCpscRecalls", () => {
  const boon = normalizeCpscRecall(boonRaw);
  const joolz = normalizeCpscRecall(mismatchRaw);
  it("fixture expectations: Boon bottles high for 26530, nothing else", () => {
    const out = matchCpscRecalls(seeded, [joolz, boon]);
    expect(out).toEqual([{ assetId: "A-baby-bottles", recallNumber: "26530", confidence: "high", evidence: "upc" }]);
  });
  it("is order independent", () => {
    expect(matchCpscRecalls([...seeded].reverse(), [boon, joolz])).toEqual(matchCpscRecalls(seeded, [joolz, boon]));
  });
  it("sorts by asset id, then high before possible, then recall number", () => {
    const r2 = recall({ recallNumber: "20", productNames: ["Boon baby bottles"], brandEvidence: ["Boon"] });
    const r3 = recall({ recallNumber: "10", productNames: ["Boon baby bottles"], brandEvidence: ["Boon"] });
    const out = matchCpscRecalls(
      [{ id: "b", name: "Boon baby bottles", brand: "Boon" }, { id: "a", name: "Boon baby bottles", brand: "Boon", upc: "669028116546" }],
      [r2, boon, r3],
    );
    expect(out.map((m) => `${m.assetId}:${m.recallNumber}:${m.confidence}`)).toEqual([
      "a:26530:high", "a:10:possible", "a:20:possible", "b:10:possible", "b:20:possible", "b:26530:possible",
    ]);
  });
  it("suppression drops only the suppressed pair", () => {
    expect(matchCpscRecalls(seeded, [boon], { suppressed: (a, r) => a === "A-baby-bottles" && r === "26530" })).toEqual([]);
    expect(matchCpscRecalls(seeded, [boon], { suppressed: (a) => a === "A-car" })).toHaveLength(1);
  });
  it("duplicate recalls collapse", () => {
    expect(matchCpscRecalls(seeded, [boon, boon])).toHaveLength(1);
  });
  it("does not mutate its inputs", () => {
    const recalls = [joolz, boon];
    matchCpscRecalls(seeded, recalls);
    expect(recalls[0]).toBe(joolz);
  });
  it("no assets or no recalls gives []", () => {
    expect(matchCpscRecalls([], [boon])).toEqual([]);
    expect(matchCpscRecalls(seeded, [])).toEqual([]);
  });
});

describe("filterByHazard", () => {
  const boon = normalizeCpscRecall(boonRaw);
  const joolz = normalizeCpscRecall(mismatchRaw);
  it("keeps recalls whose hazard text has the word", () => {
    expect(filterByHazard([boon, joolz], ["choking"])).toEqual([boon]);
  });
  it("is case insensitive and any-of", () => {
    expect(filterByHazard([boon, joolz], ["SUFFOCATION", "choking"])).toHaveLength(2);
  });
  it("is whole word", () => {
    expect(filterByHazard([boon], ["chok"])).toEqual([]);
  });
  it("no words means no filtering", () => {
    expect(filterByHazard([boon, joolz], [])).toEqual([boon, joolz]);
  });
});
