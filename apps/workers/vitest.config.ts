import { defineConfig } from "vitest/config";

// One file at a time: the dev machine has little free memory, and the hostile input tests build large strings.
export default defineConfig({
  test: { fileParallelism: false },
});
