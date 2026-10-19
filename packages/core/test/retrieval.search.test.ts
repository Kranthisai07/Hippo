import { describe, expect, it } from "vitest";
import { buildIndex, loadIndex, searchIndex, serializeIndex, DEFAULT_MIN_SCORE, type Chunk } from "../src/retrieval";
import { fixtureChunks } from "./retrieval.helpers";

const chunks = fixtureChunks();
const index = buildIndex(chunks);
const top = (q: string, n = 3) => searchIndex(index, q, { limit: n }).map((h) => `${h.chunk.docId}:${h.chunk.page}`);

describe("searchIndex on the fixture documents", () => {
  it("ranks the dishwasher exclusion first for water damage from a leak", () => {
    expect(top("water damage from a leak")[0]).toBe("warranty_dishwasher:3");
    const first = searchIndex(index, "water damage from a leak")[0]!;
    expect(first.chunk.heading).toBe("Section 3. What is not covered");
  });

  it("finds the clause for a natural voice question with stop words", () => {
    expect(top("is my dishwasher covered for a leak")).toContain("warranty_dishwasher:3");
  });

  it("ranks the lease early termination clause first for break the lease early", () => {
    const first = searchIndex(index, "break the lease early")[0]!;
    expect(first.chunk.docId).toBe("lease");
    expect(first.chunk.page).toBe(4);
    expect(first.chunk.heading).toBe("Section 6. Early termination");
  });

  it("finds lease page 4 for the notice question", () => {
    expect(top("when do I have to give notice")[0]).toBe("lease:4");
  });

  it("finds the claim steps for how do I file a claim", () => {
    expect(top("how do I file a claim")).toContain("warranty_dishwasher:3");
    const claim = searchIndex(index, "how do I file a claim").find((h) => h.chunk.docId === "warranty_dishwasher");
    expect(claim?.chunk.heading).toBe("Section 4. How to make a claim");
  });

  it("finds the Kestrel subscription for cancel kestrel trial", () => {
    expect(top("cancel kestrel trial")[0]).toBe("subscription_kestrel:1");
  });

  it("finds the deductible and renewal clauses", () => {
    expect(top("what is my deductible", 1)[0]).toBe("insurance_auto:1");
    expect(top("does my policy renew", 1)[0]).toBe("insurance_auto:1");
  });

  it("filters by docId and by predicate", () => {
    const only = searchIndex(index, "claim", { docIds: ["insurance_auto"], limit: 10 });
    expect(only.length).toBeGreaterThan(0);
    expect(only.every((h) => h.chunk.docId === "insurance_auto")).toBe(true);
    const f = searchIndex(index, "claim", { assetFilter: (c) => c.docId === "lease", limit: 10 });
    expect(f.every((h) => h.chunk.docId === "lease")).toBe(true);
    expect(searchIndex(index, "claim", { docIds: [] })).toEqual([]);
  });

  it("respects limit and returns scores in descending order", () => {
    const hits = searchIndex(index, "tenant must give written notice", { limit: 2, minScore: 0 });
    expect(hits).toHaveLength(2);
    expect(hits[0]!.score).toBeGreaterThanOrEqual(hits[1]!.score);
  });

  it("returns an empty list for unrelated queries against all six documents", () => {
    for (const q of [
      "capital of France",
      "what is the weather today",
      "zxqvbn blorptastic",
      "how tall is mount everest",
      "who won the world cup",
      "recipe for banana bread",
      "the of and is a",
      "",
      "   ",
    ]) {
      expect(searchIndex(index, q), q).toEqual([]);
    }
  });

  it("keeps the default minScore below every on-topic top score", () => {
    for (const q of [
      "water damage from a leak",
      "break the lease early",
      "cancel kestrel trial",
      "what is my deductible",
    ]) {
      expect(searchIndex(index, q, { minScore: 0 })[0]!.score, q).toBeGreaterThan(DEFAULT_MIN_SCORE);
    }
  });

  it("is deterministic with ties broken by id", () => {
    const same: Chunk[] = ["b", "a", "c"].map((k) => ({
      id: `d:1:${k}`,
      docId: "d",
      page: 1,
      text: "identical clause text",
      wordCount: 3,
    }));
    const idx = buildIndex(same);
    const a = searchIndex(idx, "identical clause", { minScore: 0 }).map((h) => h.chunk.id);
    expect(a).toEqual(["d:1:a", "d:1:b", "d:1:c"]);
    expect(
      searchIndex(buildIndex([...same].reverse()), "identical clause", { minScore: 0 }).map((h) => h.chunk.id),
    ).toEqual(a);
  });

  it("gives identical results after serialize then load", () => {
    const loaded = loadIndex(serializeIndex(index));
    for (const q of [
      "water damage from a leak",
      "break the lease early",
      "cancel kestrel trial",
      "capital of France",
    ]) {
      expect(searchIndex(loaded, q, { minScore: 0 })).toEqual(searchIndex(index, q, { minScore: 0 }));
    }
    expect(loaded.chunks.size).toBe(index.chunks.size);
  });

  it("rejects malformed or foreign JSON on load", () => {
    expect(() => loadIndex("{}")).toThrow();
    expect(() => loadIndex("not json")).toThrow();
  });
});
