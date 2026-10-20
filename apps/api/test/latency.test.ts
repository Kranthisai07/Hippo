import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { cpus, freemem, totalmem } from "node:os";
import { describe, expect, it } from "vitest";
import { getTokens } from "../src/oauthFlow";
import { startServer } from "../src/server";

// SPEC section 6: 50 sequential tools/call through the HTTP app, local p95 under 150 ms. Run with `pnpm test:latency`.
// Real socket, real OAuth token, real SDK-free JSON-RPC over fetch, seeded in-memory household. The threshold is not tuned.

const P95_LIMIT_MS = 150;
const CALLS = 50;

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });

const pct = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;

describe("latency", () => {
  it(`p95 of ${CALLS} sequential tools/call is under ${P95_LIMIT_MS} ms`, async () => {
    const port = await freePort();
    const server = await startServer({
      port,
      env: { HIPPO_SIGNING_KEY: "latency-signing-key-latency-signing-key-01" },
      log: () => {},
    });
    try {
      const { accessToken } = await getTokens({
        base: server.url,
        clientId: server.clientId,
        redirectUri: server.redirectUri,
        resource: server.mcpUrl,
      });
      const calls = [
        { name: "check_coverage", arguments: { asset: "dishwasher", issue: "leaking" } },
        { name: "whats_coming_up", arguments: {} },
        { name: "ask_documents", arguments: { question: "how many days notice to leave", about: "lease" } },
        { name: "get_agreement", arguments: { about: "car insurance" } },
      ];
      const call = async (i: number): Promise<number> => {
        const body = JSON.stringify({ jsonrpc: "2.0", id: i, method: "tools/call", params: calls[i % calls.length] });
        const t0 = performance.now();
        const res = await fetch(server.mcpUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${accessToken}`,
          },
          body,
        });
        const json = (await res.json()) as { result?: { isError?: boolean } };
        const ms = performance.now() - t0;
        expect(res.status).toBe(200);
        expect(json.result?.isError).toBeFalsy();
        return ms;
      };
      for (let i = 0; i < 4; i++) await call(i); // warm: first index load and JIT
      const times: number[] = [];
      for (let i = 0; i < CALLS; i++) times.push(await call(i));
      const sorted = [...times].sort((a, b) => a - b);
      const p50 = pct(sorted, 50);
      const p95 = pct(sorted, 95);
      console.log(
        `latency over ${CALLS} calls (warm, localhost, real socket): p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ${sorted.at(-1)!.toFixed(1)} ms, limit ${P95_LIMIT_MS} ms\n` +
          `machine: ${cpus().length} cpus, ${(freemem() / 1e6).toFixed(0)} MB free of ${(totalmem() / 1e6).toFixed(0)} MB, node ${process.version}, ${process.platform}`,
      );
      expect(p95).toBeLessThan(P95_LIMIT_MS);
    } finally {
      await server.close();
    }
  });
});
