import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REDIRECT_URI, completeExchange, signOut } from "../auth";
import { connectMcp } from "../mcp";
import type { LogEntry } from "../types";
import { toolsFixture } from "./fx";

const TOKEN = "ACCESS-SECRET-123";

function fakeServer() {
  const authHeaders: string[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u === "/oauth/token")
      return new Response(JSON.stringify({ access_token: TOKEN, refresh_token: "REFRESH-SECRET", expires_in: 900 }), {
        status: 200,
      });
    if (init?.method !== "POST") return new Response("", { status: 405 });
    authHeaders.push(new Headers(init.headers).get("authorization") ?? "");
    const msg = JSON.parse(String(init.body));
    if (msg.id === undefined) return new Response(null, { status: 202 });
    const result =
      msg.method === "initialize"
        ? {
            protocolVersion: msg.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "hippo", version: "9.9.9" },
          }
        : msg.method === "tools/list"
          ? { tools: toolsFixture.map((t) => ({ ...t, inputSchema: { type: "object", properties: {} } })) }
          : {
              content: [{ type: "text", text: "Okay." }],
              structuredContent: { kind: "undone", undone: false, summary: null },
            };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchFn, authHeaders };
}

beforeEach(() => {
  signOut();
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => signOut());

describe("real MCP client over a fake Streamable HTTP server", () => {
  it("initializes, lists tools, calls a tool, logs every message and never logs or stores the token", async () => {
    const srv = fakeServer();
    sessionStorage.setItem("hippo-ask-pkce", JSON.stringify({ verifier: "v".repeat(43), state: "s" }));
    await completeExchange("?code=c&state=s", { fetch: srv.fetchFn });
    const log: LogEntry[] = [];
    const session = await connectMcp({ onLog: (e) => log.push(e), fetch: srv.fetchFn });
    expect(session.server).toEqual({ name: "hippo", version: "9.9.9" });
    expect(session.tools.filter((t) => !t.appOnly)).toHaveLength(9);
    expect(session.tools.filter((t) => t.appOnly).map((t) => t.name)).toEqual([
      "ui_resolve_alert",
      "ui_show_clause",
      "ui_show_claim_steps",
    ]);
    const reply = await session.call("undo_last", {});
    expect(reply).toEqual({
      text: "Okay.",
      structured: { kind: "undone", undone: false, summary: null },
      isError: false,
    });

    const methods = log.map((e) => e.method);
    expect(methods).toContain("initialize");
    expect(methods).toContain("tools/list");
    expect(methods).toContain("tools/call");
    expect(log.find((e) => e.method === "tools/call")!.params).toContain("undo_last");
    expect(log.every((e) => e.ms >= 0)).toBe(true);
    expect(srv.authHeaders.every((h) => h === `Bearer ${TOKEN}`)).toBe(true);

    const everything = JSON.stringify(log);
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain("REFRESH-SECRET");
    expect(everything.toLowerCase()).not.toContain("bearer");
    expect(localStorage.length).toBe(0);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(TOKEN);
    expect(REDIRECT_URI).toBe("http://localhost:5173/callback");
  });
});
