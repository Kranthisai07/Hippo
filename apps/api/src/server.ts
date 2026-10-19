import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createAuth } from "@hippo/auth";
import { serve, type ServerType } from "@hono/node-server";
import { createMemoryRepository } from "core/src/repository";
import { createApp } from "./app";
import { createMemoryIndexSource } from "./mcp/indexCache";
import { DEMO_HOUSEHOLD, seedHousehold } from "./seed";

// Local server for the demo and for judges: in-memory repository seeded from the fixtures, the @hippo/auth server with
// one demo user, and the MCP endpoint at /mcp. Nothing here talks to AWS.

/** The date every deadline in the fixtures is computed against (fixtures/README.md). */
export const DEMO_TODAY = "2026-10-21";
const DEFAULT_DEMO_CODE = "424242";

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
  const log = opts.log ?? ((line: string) => console.log(line));
  const port = opts.port ?? Number(env.PORT ?? 8787);
  const host = opts.host ?? env.HOST ?? "127.0.0.1";
  const issuer = env.HIPPO_ISSUER ?? `http://localhost:${port}`;

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
  await seedHousehold(repo, { today, householdId: DEMO_HOUSEHOLD, indexSource });

  const demoEmail = env.HIPPO_DEMO_EMAIL ?? "demo@hippo.example";
  const demoCode = env.HIPPO_DEMO_CODE ?? DEFAULT_DEMO_CODE;
  const clientId = env.HIPPO_CLIENT_ID ?? "hippo-demo";
  const redirectUris = list(env.HIPPO_REDIRECT_URIS, ["http://localhost:5173/callback"]);
  const serviceId = env.HIPPO_SERVICE_CLIENT_ID;
  const serviceSecret = env.HIPPO_SERVICE_CLIENT_SECRET;

  const auth = createAuth({
    issuer,
    resource: `${issuer}/mcp`,
    signingKey,
    clients: [{ clientId, redirectUris }],
    resolveHousehold: (email) =>
      email === demoEmail.toLowerCase()
        ? DEMO_HOUSEHOLD
        : `hh_${createHash("sha256").update(email).digest("base64url").slice(0, 16)}`,
    log,
    demoUser: { email: demoEmail, code: demoCode },
    ...(serviceId && serviceSecret ? { serviceClient: { clientId: serviceId, clientSecret: serviceSecret } } : {}),
    now: clock,
  });

  const app = createApp({
    auth,
    repo,
    indexSource,
    now: clock,
    allowedOrigins: list(env.HIPPO_ALLOWED_ORIGINS, ["http://localhost:5173", "http://localhost:3000"]),
    log,
  });

  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, port, hostname: host }, () => resolve(s));
  });
  const url = issuer;
  log(`[hippo-api] listening on ${host}:${port}, MCP endpoint ${url}/mcp, demo date ${today}`);
  log(
    `[hippo-api] demo login: ${demoEmail}${env.HIPPO_DEMO_CODE ? "" : ` with code ${DEFAULT_DEMO_CODE}`}, client id ${clientId}, redirect ${redirectUris[0]}`,
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
