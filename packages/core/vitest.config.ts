import { defineConfig } from "vitest/config";

// The page and retrieval hostile-input tests build very large buffers on purpose. Run in parallel worker threads they
// can run out of memory on a small machine and take unrelated tests down with them, so core runs one file at a time.
export default defineConfig({
  test: { fileParallelism: false },
});
