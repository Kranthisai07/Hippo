/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Strict policy for the production build only. The dev server needs inline scripts for hot reload, so it gets none.
// No inline script, no eval, no third party origin. Styles come from the built stylesheet (no style attributes in the app).
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

function csp(): Plugin {
  return {
    name: "hippo-csp",
    apply: "build",
    transformIndexHtml: () => [
      { tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: CSP }, injectTo: "head-prepend" },
    ],
  };
}

const API = "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react(), tailwindcss(), csp()],
  server: {
    port: 5173,
    // The API sends no CORS headers, so the browser calls it on its own origin through this proxy.
    proxy: {
      "/api": { target: API },
      "/oauth": { target: API },
      "/mcp": { target: API },
    },
  },
  preview: { port: 5173 },
  build: { sourcemap: false },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.{ts,tsx}"],
    css: false,
  },
});
