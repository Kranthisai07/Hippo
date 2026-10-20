import { describe, expect, it } from "vitest";
import { buildIndex, loadIndex, searchIndex, serializeIndex, type Chunk } from "../src/retrieval";

const VOCAB =
  "tenant landlord warranty premium claim notice lease renew cancel deductible coverage policy vehicle dishwasher repair receipt payment term fee month rent insurance subscription trial charge date product defect service technician".split(
    " ",
  );

function synthetic(n: number): Chunk[] {
  let s = 12345;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  return Array.from({ length: n }, (_, i) => {
    const text = Array.from(
      { length: 60 },
      () => VOCAB[Math.floor(rnd() * VOCAB.length)]! + (rnd() < 0.3 ? Math.floor(rnd() * 500) : ""),
    ).join(" ");
    return { id: `doc${i % 40}:${(i % 7) + 1}:${i}`, docId: `doc${i % 40}`, page: (i % 7) + 1, text, wordCount: 60 };
  });
}

describe("performance over 2000 synthetic chunks", () => {
  it("loads fast and searches in a few milliseconds", () => {
    const chunks = synthetic(2000);
    let t = performance.now();
    const idx = buildIndex(chunks);
    const buildMs = performance.now() - t;
    t = performance.now();
    const json = serializeIndex(idx);
    const serMs = performance.now() - t;
    const loadTimes: number[] = [];
    let loaded = idx;
    for (let i = 0; i < 5; i++) {
      t = performance.now();
      loaded = loadIndex(json);
      loadTimes.push(performance.now() - t);
    }
    const loadMs = [...loadTimes].sort((a, b) => a - b)[2]!;
    const queries = [
      "water damage from a leak",
      "break the lease early",
      "how do I file a claim",
      "when do I have to give notice",
      "deductible renewal",
    ];
    for (let i = 0; i < 10; i++) searchIndex(loaded, queries[i % 5]!);
    // Target is 5 ms (measured 2 ms on an idle machine); the bounds are 10 ms search and 200 ms load (target 100) because a memory starved dev box ran this 3x slower.
    // Best of three rounds of 50 searches: a loaded CI machine slows a whole round, not the code.
    const medians: number[] = [];
    for (let round = 0; round < 3; round++) {
      const times: number[] = [];
      for (let i = 0; i < 50; i++) {
        t = performance.now();
        searchIndex(loaded, queries[i % 5]!);
        times.push(performance.now() - t);
      }
      medians.push([...times].sort((a, b) => a - b)[25]!);
    }
    const median = Math.min(...medians);
    console.log(
      `perf: build ${buildMs.toFixed(1)} ms, serialize ${serMs.toFixed(1)} ms (${json.length} bytes), load median ${loadMs.toFixed(1)} ms, search median ${median.toFixed(2)} ms`,
    );
    expect(loadMs).toBeLessThan(200);
    expect(median).toBeLessThan(10);
  });
});
