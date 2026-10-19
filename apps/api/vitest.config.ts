import { defineConfig } from "vitest/config";

// One test file at a time: each file seeds a household and builds clause indexes, and a small machine runs out of memory
// when several workers do that together (same reason as packages/core, D-041). The latency test has its own config.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/latency.test.ts", "node_modules/**"],
    fileParallelism: false,
  },
});
