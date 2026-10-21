// A real MCP client (initialize, tools/list, tools/call) over Streamable HTTP, same origin through the /mcp proxy.
// Every JSON-RPC message is logged for the protocol panel. The bearer token is added inside fetch and never logged.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { forceRefresh, getAccessToken } from "./auth";
import type { CallTool, LogEntry, ToolInfo, ToolReply } from "./types";

export interface McpSession {
  call: CallTool;
  tools: ToolInfo[];
  server: { name: string; version: string };
  close(): Promise<void>;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}...` : s);

function paramsSummary(method: string, p: any): string {
  if (method === "tools/call") return `${p?.name}(${clip(JSON.stringify(p?.arguments ?? {}), 120)})`;
  if (method === "initialize") return `protocol ${p?.protocolVersion}, client ${p?.clientInfo?.name}`;
  return p && Object.keys(p).length ? clip(JSON.stringify(p), 120) : "";
}

function resultSummary(method: string, msg: any): string {
  if (msg?.error) return `error ${msg.error.code}: ${clip(String(msg.error.message), 100)}`;
  const r = msg?.result;
  if (!r) return "";
  if (method === "initialize") return `${r.serverInfo?.name} ${r.serverInfo?.version}`;
  if (method === "tools/list") return `${r.tools?.length ?? 0} tools`;
  if (method === "tools/call") return `${r.isError ? "error " : ""}${r.structuredContent?.kind ?? "text"}`;
  return "ok";
}

export async function connectMcp(opts: {
  onLog: (e: LogEntry) => void;
  fetch?: typeof fetch;
  url?: string;
}): Promise<McpSession> {
  const base: typeof fetch = opts.fetch ?? ((...a) => fetch(...a));
  let n = 0;
  const logged: typeof fetch = async (input, init) => {
    const send = async () => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${await getAccessToken({ fetch: opts.fetch })}`);
      return base(input, { ...init, headers });
    };
    let req: any = null;
    const bodyText = typeof init?.body === "string" ? init.body : "";
    try {
      req = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      req = null;
    }
    const t0 = performance.now();
    let res = await send();
    if (res.status === 401) {
      await forceRefresh({ fetch: opts.fetch });
      res = await send();
    }
    if (init?.method === "POST" && req?.method) {
      const ct = res.headers.get("content-type") ?? "";
      const text = ct.includes("json") ? await res.clone().text() : "";
      let msg: any = null;
      try {
        msg = text ? JSON.parse(text) : null;
      } catch {
        msg = null;
      }
      opts.onLog({
        n: ++n,
        at: new Date().toLocaleTimeString([], { hour12: false }),
        method: req.method,
        params: paramsSummary(req.method, req.params),
        result: msg ? resultSummary(req.method, msg) : `HTTP ${res.status}`,
        ms: Math.round(performance.now() - t0),
        ok: res.ok && !msg?.error,
        request: clip(bodyText, 4000),
        response: clip(text, 4000),
      });
    }
    return res;
  };

  const client = new Client({ name: "hippo-ask-page", version: "0.1.0" });
  const url = opts.url ?? new URL("/mcp", window.location.origin).toString();
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { fetch: logged }));
  const v = client.getServerVersion();
  const { tools } = await client.listTools();

  const call: CallTool = async (name, args) => {
    const r = (await client.callTool({ name, arguments: args })) as {
      content?: { type: string; text?: string }[];
      structuredContent?: ToolReply["structured"];
      isError?: boolean;
    };
    return {
      text: r.content?.find((c) => c.type === "text")?.text ?? "",
      structured: r.structuredContent ?? null,
      isError: r.isError === true,
    };
  };

  return {
    call,
    server: { name: v?.name ?? "unknown", version: v?.version ?? "" },
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      appOnly: ((t._meta as any)?.ui?.visibility as string[] | undefined)?.includes("app") === true,
    })),
    close: () => client.close(),
  };
}
