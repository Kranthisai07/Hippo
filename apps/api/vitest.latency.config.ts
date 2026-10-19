import { defineConfig } from "vitest/config";

// `pnpm test:latency`: the 50 call p95 test only. Kept out of the normal run because wall clock tests are noisy on a
// busy machine (G-030).
export default defineConfig({
  test: {
    include: ["test/latency.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
