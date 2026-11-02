/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { extensionPackage } from "./build/plugin";

// Two entries with fixed names, because manifest.json points at them. No inline script: the default extension CSP blocks it.
export default defineConfig({
  // The plugin picks the output folder and writes the manifest (build/plugin.ts): dist/ for local use, dist-store/ with
  // `--mode store`.
  plugins: [react(), extensionPackage(fileURLToPath(new URL(".", import.meta.url)))],
  build: {
    rollupOptions: {
      input: { popup: "popup.html", background: "src/background.ts" },
      output: { entryFileNames: "[name].js", chunkFileNames: "[name].js", assetFileNames: "[name][extname]" },
    },
  },
  test: { environment: "jsdom", setupFiles: ["test/setup.ts"] },
});
