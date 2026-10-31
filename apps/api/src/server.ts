import { createHash, randomBytes, randomInt } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createAuth } from "@hippo/auth";
import { serve, type ServerType } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createMemoryRepository } from "core/src/repository";
import { createApp } from "./app";
import { createFixtureIngest } from "./api/demoIngest";
import { DEV_EXTENSION_ID, productionProblems } from "./config";
import { createLocalUploader, createMemoryObjectStore } from "./api/storage";
import { createMemoryIndexSource } from "./mcp/indexCache";
import { DEMO_HOUSEHOLD, seedHousehold } from "./seed";

// Local server for the demo and for judges: in-memory repository seeded from the fixtures, the @hippo/auth server with
// one demo user, and the MCP endpoint at /mcp. Nothing here talks to AWS.

/** A server anyone can reach. The demo household there is shared, so a real page must never be saved into it. */
export const isPublicIssuer = (issuer: string): boolean => !LOOPBACK_HOSTS.has(new URL(issuer).hostname);

/**
 * A real page may only be saved on a server that this machine alone can reach, because the demo household is shared on
 * anything wider. All three must hold: an issuer alone is not enough, since HOST=0.0.0.0 keeps a localhost issuer.
 */
export const isLocalOnly = (host: string, issuer: string, env: Record<string, string | undefined>): boolean =>
  LOOPBACK_HOSTS.has(host.toLowerCase()) && !isPublicIssuer(issuer) && !env.RAILWAY_PUBLIC_DOMAIN;

/** The date every deadline in the fixtures is computed against (fixtures/README.md). */
export const DEMO_TODAY = "2026-10-21";
export { DEV_EXTENSION_ID };
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * The demo login has no real secret behind it, so it is only on when the server is reachable from this machine alone,
 * or when someone says so (HIPPO_DEMO=1). HIPPO_DEMO=0 turns it off everywhere. Binding to 0.0.0.0 never enables it.
 */
export function demoEnabled(host: string, env: Record<string, string | undefined>): boolean {
  if (env.HIPPO_DEMO === "1") return true;
  if (env.HIPPO_DEMO === "0") return false;
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

export interface ServerOptions {
  port?: number;
  host?: string;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
}

export interface Running {
  url: string;
  mcpUrl: string;
  clientId: string;
  redirectUri: string;
  demoUser: { email: string };
  close(): Promise<void>;
}

const list = (v: string | undefined, fallback: string[]): string[] =>
  v
    ? v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : fallback;

export async function startServer(opts: ServerOptions = {}): Promise<Running> {
  const env = opts.env ?? process.env;
  // This entry keeps everything in memory, so production is refused here until a durable host entry replaces it.
  if (env.HIPPO_ENV === "production") {
    const problems = productionProblems(env, { durable: false, mailer: false }).map((x) => `- ${x}`);
    throw new Error(["Refusing to start in production:", ...problems].join("\n"));
  }
  const log = opts.log ?? ((line: string) => console.log(line));
  const port = opts.port ?? Number(env.PORT ?? 8787);
  const host = opts.host ?? env.HOST ?? "127.0.0.1";
  // A host that publishes its own domain (Railway sets RAILWAY_PUBLIC_DOMAIN) gets that as its public address.
  const issuer =
    env.HIPPO_ISSUER ??
    (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${port}`);
  const publicHost = isPublicIssuer(issuer);

  let signingKey = env.HIPPO_SIGNING_KEY;
  if (!signingKey) {
    signingKey = randomBytes(32).toString("base64url");
    log(
      "[hippo-api] HIPPO_SIGNING_KEY is not set, so a random signing key was generated for this run. Tokens stop working when the server restarts.",
    );
  }

  // The demo clock: fixed at the fixture anchor date so the demo says "9 days" whenever it is run. HIPPO_TODAY=now uses the real date.
  const start = Date.now();
  const anchor = env.HIPPO_TODAY ?? DEMO_TODAY;
  const clock =
    anchor === "now"
      ? () => Date.now()
      : (() => {
          const base = Date.parse(`${anchor}T12:00:00.000Z`);
          if (Number.isNaN(base)) throw new Error(`HIPPO_TODAY must be YYYY-MM-DD or "now", got: ${anchor}`);
          return () => base + (Date.now() - start);
        })();
  const today = new Date(clock()).toISOString().slice(0, 10);

  const repo = createMemoryRepository();
  const indexSource = createMemoryIndexSource();
  const objectStore = createMemoryObjectStore();
  await seedHousehold(repo, { today, householdId: DEMO_HOUSEHOLD, indexSource, pageStore: objectStore });

  const demoEmail = env.HIPPO_DEMO_EMAIL ?? "demo@hippo.example";
  const demoOn = demoEnabled(host, env);
  // A fresh code on every start, so there is no public default. It is logged once, only for a local demo.
  const demoCode = env.HIPPO_DEMO_CODE ?? String(randomInt(100_000, 1_000_000));
  const clientId = env.HIPPO_CLIENT_ID ?? "hippo-demo";
  const redirectUris = list(env.HIPPO_REDIRECT_URIS, [
    publicHost ? `${issuer}/callback` : "http://localhost:5173/callback",
  ]);
  // The extension signs in with the same client. Its origin may reach /mcp and /ext only, never the cookie routes.
  const localOnly = isLocalOnly(host, issuer, env);
  const extensionId = env.HIPPO_EXTENSION_ID ?? (localOnly ? DEV_EXTENSION_ID : undefined);
  if (extensionId) redirectUris.push(`https://${extensionId}.chromiumapp.org/`);
  const serviceId = env.HIPPO_SERVICE_CLIENT_ID;
  const serviceSecret = env.HIPPO_SERVICE_CLIENT_SECRET;

  const allowedOrigins = list(env.HIPPO_ALLOWED_ORIGINS, ["http://localhost:5173", "http://localhost:3000"]);
  const auth = createAuth({
    // The web dev server sends the cookie session calls (/oauth/session) from its own origin.
    allowedOrigins: [new URL(issuer).origin, ...allowedOrigins],
    issuer,
    resource: `${issuer}/mcp`,
    signingKey,
    clients: [{ clientId, redirectUris }],
    resolveHousehold: (email) =>
      email === demoEmail.toLowerCase()
        ? DEMO_HOUSEHOLD
        : `hh_${createHash("sha256").update(email).digest("base64url").slice(0, 16)}`,
    log,
    audit: (e) => log(JSON.stringify({ ts: new Date().toISOString(), audit: e.event, sub: e.sub, reason: e.reason })),
    ...(demoOn ? { demoUser: { email: demoEmail, code: demoCode } } : {}),
    // Without the demo there is no mailer, so a printed code would only leak into a shared log.
    logMagicCodes: demoOn,
    ...(serviceId && serviceSecret ? { serviceClient: { clientId: serviceId, clientSecret: serviceSecret } } : {}),
    now: clock,
  });

  const app = createApp({
    auth,
    repo,
    indexSource,
    now: clock,
    // Set only behind a proxy that writes this header itself (cf-connecting-ip on Cloudflare).
    hsts: issuer.startsWith("https://"),
    ...(env.HIPPO_CLIENT_IP_HEADER ? { clientIpHeader: env.HIPPO_CLIENT_IP_HEADER } : {}),
    // The server's own origin too: when it serves the web build itself, the /ask page calls /mcp from this origin.
    allowedOrigins: [
      new URL(issuer).origin,
      ...allowedOrigins,
      ...(extensionId ? [`chrome-extension://${extensionId}`] : []),
    ],
    // Web API: files in memory, the PUT route of this server, and the demo fixture ingest, which
    // only reads the demo documents. The web dev server may send the cookie from its own origin.
    web: {
      objectStore,
      // HIPPO_INGEST=pipeline swaps the demo-only fixture ingest for the real pipeline (apps/workers, fixture mode unless HIPPO_LIVE_AI=1).
      onUploaded:
        env.HIPPO_INGEST === "pipeline"
          ? (await import("../../workers/src/ingest")).createPipelineIngest(
              { repo, objectStore, indexStore: indexSource, now: clock, log },
              env,
            )
          : createFixtureIngest({
              repo,
              objectStore,
              indexStore: indexSource,
              now: clock,
              newId: () => crypto.randomUUID(),
            }),
      // The browser extension saves pages only on a local server. The hook is not even loaded anywhere else.
      ...(localOnly
        ? {
            onCaptured: (await import("../../workers/src/ingest/capture")).createCaptureIngest({
              repo,
              objectStore,
              indexStore: indexSource,
              now: clock,
              log,
            }),
          }
        : {}),
      uploader: createLocalUploader({ now: clock }),
      origins: [new URL(issuer).origin, ...allowedOrigins],
    },
    log,
  });

  // HIPPO_WEB_DIST serves the built web app from this same address (one container, same origin, so the strict CSP and
  // the cookie session work unchanged). The API, OAuth and MCP paths are never answered with the page.
  if (env.HIPPO_WEB_DIST) {
    const root = env.HIPPO_WEB_DIST;
    const API_PATHS = ["/api", "/ext", "/oauth", "/mcp", "/.well-known"];
    const isApi = (p: string) => API_PATHS.some((a) => p === a || p.startsWith(`${a}/`));
    app.get("*", async (c, next) => (isApi(c.req.path) ? next() : serveStatic({ root })(c, next)));
    app.get("*", async (c, next) => (isApi(c.req.path) ? next() : serveStatic({ root, path: "index.html" })(c, next)));
  }

  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, port, hostname: host }, () => resolve(s));
  });
  const url = issuer;
  log(`[hippo-api] listening on ${host}:${port}, MCP endpoint ${url}/mcp, demo date ${today}`);
  log(
    demoOn
      ? `[hippo-api] demo login: ${demoEmail}${env.HIPPO_DEMO_CODE ? "" : ` with code ${demoCode}`}, client id ${clientId}, redirect ${redirectUris[0]}`
      : `[hippo-api] demo login is off (host ${host}). Set HIPPO_DEMO=1 to turn it on. Client id ${clientId}, redirect ${redirectUris[0]}`,
  );
  return {
    url,
    mcpUrl: `${url}/mcp`,
    clientId,
    redirectUri: redirectUris[0]!,
    demoUser: { email: demoEmail },
    close: () =>
      new Promise(
        (resolve) => (
          server.close(() => resolve()),
          (server as { closeAllConnections?: () => void }).closeAllConnections?.()
        ),
      ),
  };
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  startServer().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
