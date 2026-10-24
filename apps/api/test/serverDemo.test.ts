import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { demoEnabled, startServer } from "../src/server";

// Review finding: the demo login needed no secret, the default code (424242) was public and logged, and setting
// HOST=0.0.0.0 would have exposed it to the network.
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });

const KEY = "test-signing-key-test-signing-key-0123456789";
const session = (base: string, body: Record<string, unknown>) =>
  fetch(`${base}/oauth/session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify(body),
  });

describe("demoEnabled", () => {
  it.each(["127.0.0.1", "localhost", "LOCALHOST", "::1", "[::1]"])("is on for the loopback host %s", (host) => {
    expect(demoEnabled(host, {})).toBe(true);
  });

  it.each(["0.0.0.0", "::", "192.168.1.20", "10.0.0.5", "example.com", "", "127.0.0.1.evil.example"])(
    "is off for %j unless asked",
    (host) => {
      expect(demoEnabled(host, {})).toBe(false);
    },
  );

  it("HIPPO_DEMO=1 turns it on anywhere and HIPPO_DEMO=0 turns it off everywhere", () => {
    expect(demoEnabled("0.0.0.0", { HIPPO_DEMO: "1" })).toBe(true);
    expect(demoEnabled("127.0.0.1", { HIPPO_DEMO: "0" })).toBe(false);
    expect(demoEnabled("0.0.0.0", { HIPPO_DEMO: "yes" })).toBe(false);
  });
});

describe("the local demo login", () => {
  it("does not use the old public code, logs a fresh one, and that code works", async () => {
    const port = await freePort();
    const lines: string[] = [];
    const server = await startServer({ port, env: { HIPPO_SIGNING_KEY: KEY }, log: (l) => lines.push(l) });
    try {
      const joined = lines.join("\n");
      expect(joined).not.toContain("424242");
      const code = /with code (\d{6})/.exec(joined)?.[1];
      expect(code).toBeTruthy();
      expect(
        (await session(server.url, { email: server.demoUser.email, code: "424242" })).status,
      ).toBeGreaterThanOrEqual(400);
      expect((await session(server.url, { email: server.demoUser.email, code })).status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("uses HIPPO_DEMO_CODE when it is set and does not print it", async () => {
    const port = await freePort();
    const lines: string[] = [];
    const server = await startServer({
      port,
      env: { HIPPO_SIGNING_KEY: KEY, HIPPO_DEMO_CODE: "987654" },
      log: (l) => lines.push(l),
    });
    try {
      expect(lines.join("\n")).not.toContain("987654");
      expect((await session(server.url, { email: server.demoUser.email, code: "987654" })).status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("is refused entirely when switched off, with the button and with the code", async () => {
    const port = await freePort();
    const lines: string[] = [];
    const server = await startServer({
      port,
      env: { HIPPO_SIGNING_KEY: KEY, HIPPO_DEMO: "0", HIPPO_DEMO_CODE: "987654" },
      log: (l) => lines.push(l),
    });
    try {
      expect(lines.join("\n")).toMatch(/demo login is off/i);
      expect((await session(server.url, { demo: true })).status).toBe(401);
      expect(
        (await session(server.url, { email: "demo@hippo.example", code: "987654" })).status,
      ).toBeGreaterThanOrEqual(400);
      const meta = await (await fetch(`${server.url}/.well-known/oauth-authorization-server`)).json();
      expect(meta).toBeTruthy();
    } finally {
      await server.close();
    }
  });
});

describe("hosting the web build and the public address", () => {
  it("serves the built web app from the same address and never answers an API path with the page", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "hippo-web-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>PAGE-MARKER</title>");
    writeFileSync(join(dir, "assets", "a.js"), "console.log('ASSET-MARKER')");
    const port = await freePort();
    const server = await startServer({ port, env: { HIPPO_SIGNING_KEY: KEY, HIPPO_WEB_DIST: dir }, log: () => {} });
    try {
      const base = `http://127.0.0.1:${port}`;
      const page = await fetch(`${base}/welcome`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("PAGE-MARKER");
      expect(await (await fetch(`${base}/callback`)).text()).toContain("PAGE-MARKER");
      expect(await (await fetch(`${base}/assets/a.js`)).text()).toContain("ASSET-MARKER");
      // Raw sockets would be needed to send an un-normalised path; fetch still proves a dot segment never leaves the root.
      expect(await (await fetch(`${base}/..%2f..%2fpackage.json`)).text()).not.toContain('"name"');
      for (const p of ["/api/nothing-here", "/oauth/nothing-here", "/mcp", "/.well-known/nothing-here"]) {
        expect(await (await fetch(`${base}${p}`)).text()).not.toContain("PAGE-MARKER");
      }
    } finally {
      await server.close();
    }
  });

  it("takes its public address and callback from the host's domain", async () => {
    const port = await freePort();
    const server = await startServer({
      port,
      env: { HIPPO_SIGNING_KEY: KEY, RAILWAY_PUBLIC_DOMAIN: "hippo.example.app" },
      log: () => {},
    });
    try {
      expect(server.url).toBe("https://hippo.example.app");
      expect(server.mcpUrl).toBe("https://hippo.example.app/mcp");
      expect(server.redirectUri).toBe("https://hippo.example.app/callback");
    } finally {
      await server.close();
    }
  });
});
