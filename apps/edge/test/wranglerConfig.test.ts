import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createSqliteD1 } from "../../../packages/core/test/d1.sqlite";
import { buildApp, type Env } from "../src/index";
import { fakeBucket } from "./fakes";

// wrangler.toml decides which addresses the Worker answers and which are files of the web app. If it says "the app" for an
// address the Worker handles, that route silently becomes index.html in production. This reads the file and checks it
// against the real app, so the two cannot drift apart.

const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const list = (key: string): string[] => {
  const m = new RegExp(`^${key}\\s*=\\s*\\[([^\\]]*)\\]`, "m").exec(toml);
  if (!m) throw new Error(`${key} not found in wrangler.toml`);
  return [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
};

const app = buildApp(
  {
    DB: createSqliteD1(),
    BUCKET: fakeBucket().bucket,
    HIPPO_ENV: "development",
    HIPPO_ISSUER: "https://api.hippo.test",
    HIPPO_SIGNING_KEY: "config-test-signing-key-config-test-signing-key",
  } as unknown as Env,
  { now: () => Date.UTC(2026, 10, 2), log: () => undefined },
);

describe("wrangler.toml", () => {
  const first = list("run_worker_first");

  it("sends every address the Worker handles to the Worker first", async () => {
    // One real address for each family the app mounts (apps/api/src/app.ts and apps/edge/src/index.ts).
    const handled = [
      "/healthz",
      "/api/me",
      "/oauth/providers",
      "/ext/subscriptions",
      "/mcp",
      "/.well-known/oauth-authorization-server",
      "/unsubscribe",
    ];
    for (const path of handled) {
      const res = await app.request(`https://api.hippo.test${path}`);
      expect(res.status, `${path} is answered by the Worker`).not.toBe(404);
      const covered = first.some((p) => (p.endsWith("/*") ? path.startsWith(p.slice(0, -1)) : path === p));
      expect(covered, `${path} must match run_worker_first`).toBe(true);
    }
  });

  it("leaves the pages of the web app to the platform, so they are never swallowed by the Worker", () => {
    for (const path of [
      "/",
      "/welcome",
      "/signin",
      "/privacy",
      "/terms",
      "/ask",
      "/callback",
      "/review/doc-1",
      "/things/a",
    ]) {
      const taken = first.some((p) => (p.endsWith("/*") ? path.startsWith(p.slice(0, -1)) : path === p));
      expect(taken, `${path} belongs to the web app`).toBe(false);
    }
  });

  it("serves the web app as a single page app from the built folder, with the binding named ASSETS", () => {
    expect(toml).toMatch(/^\[assets\]/m);
    expect(toml).toMatch(/^directory\s*=\s*"\.\.\/web\/dist"/m);
    expect(toml).toMatch(/^binding\s*=\s*"ASSETS"/m);
    expect(toml).toMatch(/^not_found_handling\s*=\s*"single-page-application"/m);
  });

  it("has the daily cron trigger, and holds no secret", () => {
    expect(toml).toMatch(/^\[triggers\]\s*\ncrons\s*=\s*\["[^"]+"\]/m);
    expect(toml).not.toMatch(/SIGNING_KEY\s*=|CLIENT_SECRET\s*=|GOCSPX/);
  });
});
