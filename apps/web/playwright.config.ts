import { defineConfig } from "@playwright/test";

// The API and Vite are started here. HIPPO_DEMO_CODE pins the demo magic code. Tests run in order on one worker because
// they share one in-memory household.
export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: { baseURL: "http://localhost:5173", viewport: { width: 1280, height: 720 }, trace: "off" },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: [
    {
      command: "pnpm --filter @hippo/api start",
      cwd: "../..",
      port: 8787,
      env: { HIPPO_DEMO_CODE: "123456", HIPPO_ALLOWED_ORIGINS: "http://localhost:5173" },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    { command: "pnpm dev", port: 5173, reuseExistingServer: false, timeout: 60_000 },
  ],
});
