import { unauthorized, type Auth } from "@hippo/auth";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Repository } from "core/src/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { errorBody } from "./api/http";
import { createExtensionApi, type OnCaptured } from "./api/extension";
import type { IndexStore, OnUploaded } from "./api/fixtureIngest";
import { clientAddress, createMemoryLimiter, type RateLimiter } from "./api/limiter";
import { createWebApi } from "./api/routes";
import { createLocalUploader, createMemoryObjectStore, type ObjectStore, type Uploader } from "./api/storage";
import { createIndexCache, type IndexSource } from "./mcp/indexCache";
import { createMcpServer } from "./mcp/server";
import type { ToolContext } from "./mcp/context";

export interface AppDeps {
  /** The OAuth server. Its routes (well-knowns and /oauth/*) are mounted at the root, and it verifies every bearer. */
  auth: Auth;
  repo: Repository;
  indexSource: IndexSource;
  /** Injected clock in milliseconds. Tools never read the real clock. */
  now?: () => number;
  newId?: () => string;
  /** Browser origins allowed to call /mcp (the web demo page). A request with no Origin header is always fine. */
  allowedOrigins?: string[];
  /** Counts hits for every rate limit. Default: in memory, one process. A hosted server passes a durable one. */
  limiter?: RateLimiter;
  /** The header a trusted proxy sets to the caller's address (cf-connecting-ip on Cloudflare). Unset: the socket address. */
  clientIpHeader?: string;
  /** Send Strict-Transport-Security. Set when the public address is https. */
  hsts?: boolean;
  /** Request body limit for /mcp in bytes. */
  maxBodyBytes?: number;
  log?: (line: string) => void;
  /** The web JSON API under /api (docs/WEB_API.md). Everything is optional: the defaults are in memory and local. */
  web?: WebDeps;
}

export interface WebDeps {
  /** Where uploaded files live. Default: in memory. */
  objectStore?: ObjectStore;
  /** How a browser sends a file. Default: the local PUT route of this server. */
  uploader?: Uploader;
  /** Runs after the bytes are stored. Left out, uploads are refused with a 503 (the demo server passes the fixture ingest). */
  onUploaded?: OnUploaded;
  /** Saves a page sent by the browser extension. Left out, captures are refused (every public host). */
  onCaptured?: OnCaptured;
  /** Where the clause index is written. Default: indexSource when it can be written to. */
  indexStore?: IndexStore;
  /** Browser origins other than the server's own that may send writes with the session cookie (the web dev server). */
  origins?: string[];
}

/** What a client_credentials (service) token may do: set up and list, never call a tool or touch data. */
const SERVICE_METHODS: ReadonlySet<string> = new Set(["initialize", "tools/list", "ping", "notifications/initialized"]);

export const DEFAULT_MAX_BODY_BYTES = 128 * 1024;
/** Coarse per address limits in front of the sign-in and extension routes. The exact limits sit behind them. */
export const OAUTH_PER_MINUTE = 120;
export const EXT_PER_MINUTE = 300;
const MCP_PATH = "/mcp";

const rpcError = (
  status: 400 | 405 | 413,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });

function methodsOf(body: unknown): (string | null)[] {
  const list = Array.isArray(body) ? body : [body];
  return list.map((m) =>
    typeof m === "object" && m !== null && typeof (m as { method?: unknown }).method === "string"
      ? (m as { method: string }).method
      : null,
  );
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const maxBody = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const indexes = createIndexCache(deps.indexSource);
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const allowed = new Set(deps.allowedOrigins ?? []);
  const limiter = deps.limiter ?? createMemoryLimiter(now);

  // One line per request, in JSON. No query string, no header and no body: a path holds ids only, never a token or text.
  app.use("*", async (c, next) => {
    const id = crypto.randomUUID();
    const t0 = Date.now();
    c.header("X-Request-Id", id);
    await next();
    deps.log?.(
      JSON.stringify({
        ts: new Date(t0).toISOString(),
        id,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Date.now() - t0,
      }),
    );
  });

  // Every response, including a fresh Response a handler returns. A route that sets its own value keeps it.
  app.use("*", async (c, next) => {
    await next();
    const h = c.res.headers;
    if (!h.has("X-Content-Type-Options")) h.set("X-Content-Type-Options", "nosniff");
    if (!h.has("Referrer-Policy")) h.set("Referrer-Policy", "no-referrer");
    if (deps.hsts) h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  });

  // Before auth, so a flood of bad tokens or codes is stopped without any work. OAuth clients get an OAuth error body.
  app.use("/oauth/*", async (c, next) => {
    const r = await limiter(`ip:oauth:${clientAddress(c, deps.clientIpHeader)}`, 60_000, OAUTH_PER_MINUTE);
    if (r.ok) return next();
    return c.json({ error: "rate_limited" }, 429, {
      "Cache-Control": "no-store",
      "Retry-After": String(r.retryAfterSec),
    });
  });
  app.use("/ext/*", async (c, next) => {
    const r = await limiter(`ip:ext:${clientAddress(c, deps.clientIpHeader)}`, 60_000, EXT_PER_MINUTE);
    if (r.ok) return next();
    // This runs before the /ext CORS middleware, so a listed origin gets its header here too and can read Retry-After.
    const origin = c.req.header("origin");
    return c.json(errorBody(429, "Too many requests. Please slow down."), 429, {
      "Cache-Control": "no-store",
      "Retry-After": String(r.retryAfterSec),
      Vary: "Origin",
      ...(origin !== undefined && allowed.has(origin) ? { "Access-Control-Allow-Origin": origin } : {}),
    });
  });

  app.route("/", deps.auth.app);

  const web = deps.web ?? {};
  const objectStore = web.objectStore ?? createMemoryObjectStore();
  const indexStore = web.indexStore ?? ("put" in deps.indexSource ? (deps.indexSource as IndexStore) : undefined);
  app.route(
    "/api",
    createWebApi({
      auth: deps.auth,
      repo: deps.repo,
      objectStore,
      uploader: web.uploader ?? createLocalUploader(),
      ...(web.onUploaded ? { onUploaded: web.onUploaded } : {}),
      indexStore,
      indexes,
      now,
      newId,
      origins: web.origins ?? [],
      limiter,
    }),
  );

  app.route(
    "/ext",
    createExtensionApi({
      auth: deps.auth,
      repo: deps.repo,
      onCaptured: web.onCaptured,
      allowedOrigins: allowed,
      limiter,
      now,
    }),
  );

  app.get("/healthz", (c) => c.json({ ok: true }));

  // Origin check (MCP spec: servers MUST validate Origin) and CORS for the browser demo page.
  app.use(MCP_PATH, async (c, next) => {
    const origin = c.req.header("origin");
    if (origin !== undefined && !allowed.has(origin)) return c.json({ error: "forbidden_origin" }, 403);
    if (c.req.method === "OPTIONS") {
      const headers: Record<string, string> = {
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id",
        "Access-Control-Max-Age": "600",
      };
      if (origin !== undefined) headers["Access-Control-Allow-Origin"] = origin;
      return new Response(null, { status: 204, headers });
    }
    await next();
    if (origin !== undefined) {
      c.res.headers.set("Access-Control-Allow-Origin", origin);
      c.res.headers.append("Vary", "Origin");
    }
  });

  // No legacy SSE stream and no sessions.
  app.on(["GET", "DELETE"], MCP_PATH, () => rpcError(405, -32000, "Method not allowed", { Allow: "POST" }));

  app.post(
    MCP_PATH,
    // First gate, before any body is read or parsed: no usable bearer (a user token or a service token) is a bare 401,
    // so an unauthenticated caller learns nothing about the parser and cannot make the server read a large body.
    // Which methods a service token may call is decided later, once the body is known.
    async (c, next) => {
      const header = c.req.header("authorization");
      if (!(await deps.auth.verifyBearer(header)) && !(await deps.auth.verifyServiceBearer(header))) {
        return unauthorized();
      }
      await next();
    },
    bodyLimit({ maxSize: maxBody, onError: () => rpcError(413, -32000, "Payload too large") }),
    async (c) => {
      const text = await c.req.text();
      // bodyLimit trusts a Content-Length header, so the real size is checked again here.
      if (text.length > maxBody) return rpcError(413, -32000, "Payload too large");
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return rpcError(400, -32700, "Parse error");
      }

      // Our own bearer check: the SDK's helper always adds WWW-Authenticate, which the Alexa+ checklist forbids (G-017).
      const header = c.req.header("authorization");
      const methods = methodsOf(body);
      const user = await deps.auth.verifyBearer(header);
      if (user) {
        if (methods.includes("tools/call") && !user.scope.split(" ").includes("mcp:tools")) return unauthorized();
      } else {
        const serviceOk = methods.every((m) => m !== null && SERVICE_METHODS.has(m));
        if (!serviceOk || !(await deps.auth.verifyServiceBearer(header))) return unauthorized();
      }

      const nowMs = now();
      const context: ToolContext | null = user
        ? {
            householdId: user.householdId,
            repo: deps.repo,
            today: new Date(nowMs).toISOString().slice(0, 10),
            nowMs,
            newId,
            indexes,
          }
        : null;

      const server = createMcpServer({ context, ...(deps.log ? { log: deps.log } : {}) });
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
        maxRequestBodySize: maxBody,
      });
      // The body is already parsed, so the transport only needs the headers. Accept is filled in when a simple client
      // (curl) omits it, which the spec allows a server to tolerate.
      const headers = new Headers(c.req.raw.headers);
      const accept = headers.get("accept") ?? "";
      if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
        headers.set("accept", "application/json, text/event-stream");
      }
      try {
        await server.connect(transport);
        const res = await transport.handleRequest(new Request(c.req.url, { method: "POST", headers }), {
          parsedBody: body,
        });
        res.headers.set("Cache-Control", "no-store");
        return res;
      } finally {
        await transport.close().catch(() => undefined);
        await server.close().catch(() => undefined);
      }
    },
  );

  return app;
}
