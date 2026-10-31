/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Two entries with fixed names, because manifest.json points at them. No inline script: the default extension CSP blocks it.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    rollupOptions: {
      input: { popup: "popup.html", background: "src/background.ts" },
      output: { entryFileNames: "[name].js", chunkFileNames: "[name].js", assetFileNames: "[name][extname]" },
    },
  },
  test: { environment: "jsdom", setupFiles: ["test/setup.ts"] },
});
