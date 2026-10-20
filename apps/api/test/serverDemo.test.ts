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
