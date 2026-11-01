import { createAuth, type Mailer } from "@hippo/auth";
import { createD1Repository, type D1Like } from "core/src/repository/d1";
import type { Hono } from "hono";
import { limiterFromStore } from "../../api/src/api/limiter";
import { createApp } from "../../api/src/app";
import { DEV_EXTENSION_ID, productionProblems } from "../../api/src/config";
import { createCaptureIngest } from "../../workers/src/ingest/capture";
import { createCloudflareMailer, type EmailBindingLike } from "./cloudflareMailer";
import { createD1AuthStore } from "./d1AuthStore";
import { createR2IndexStore, createR2ObjectStore, type R2BucketLike } from "./r2";

// The Workers entry: the same Hono app as the Node server, on D1 (data, sign in state, rate counters), R2 (files and the
// clause index) and the Email Sending binding. Secrets (HIPPO_SIGNING_KEY) come from `wrangler secret`, never from the
// config file. Uploads and PDF reading are not connected (the app answers them with a 503), and there is no demo login,
// no fixture seed and no demo clock.

export interface Env {
  DB: D1Like;
  BUCKET: R2BucketLike;
  /** `[[send_email]]` with `name = "EMAIL"`. Absent in a plain local run, where the sign in code goes to the log. */
  EMAIL?: EmailBindingLike;
  HIPPO_ENV?: string;
  /** The public https address of this Worker, for example https://api.hippo.example. */
  HIPPO_ISSUER?: string;
  HIPPO_SIGNING_KEY?: string;
  HIPPO_EXTENSION_ID?: string;
  HIPPO_ALLOWED_ORIGINS?: string;
  HIPPO_REDIRECT_URIS?: string;
  HIPPO_CLIENT_ID?: string;
  HIPPO_CLIENT_IP_HEADER?: string;
  HIPPO_MAIL_FROM?: string;
  HIPPO_DEMO?: string;
}

const list = (v: string | undefined): string[] =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** The same household id as the Node server: hh_ and the first 16 characters of the base64url SHA-256 of the email. */
export async function householdOf(email: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email));
  return `hh_${b64url(new Uint8Array(digest)).slice(0, 16)}`;
}

/** Thrown when the settings are not safe to start with. The message holds only names of settings, never values. */
export class StartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartupError";
  }
}

export interface BuildOptions {
  now?: () => number;
  log?: (line: string) => void;
}

/** Builds the app from the bindings and settings, or throws with the names (never the values) of what is wrong. */
export function buildApp(env: Env, opts: BuildOptions = {}): Hono {
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? ((line: string) => console.log(line));
  // Strict unless a local run says so. An unset or misspelled HIPPO_ENV is strict too, so a deploy that forgets it fails
  // closed instead of starting with a made up signing key, a localhost issuer and sign in codes in the log.
  const lax = env.HIPPO_ENV === "development" || env.HIPPO_ENV === "local";
  const production = !lax;

  const mailer: Mailer | undefined = env.EMAIL
    ? createCloudflareMailer(env.EMAIL, env.HIPPO_MAIL_FROM ?? "Hippo <login@localhost>")
    : production
      ? undefined
      : // A local run only: there is no mailer, so the person at the terminal reads the code from the log.
        { send: async (email, code) => log(`[hippo-edge] sign in code for ${email}: ${code}`) };
  if (production) {
    // Only the string settings the check reads, never the bindings.
    const settings: Record<string, string | undefined> = {
      HIPPO_ENV: env.HIPPO_ENV,
      HIPPO_SIGNING_KEY: env.HIPPO_SIGNING_KEY,
      HIPPO_ISSUER: env.HIPPO_ISSUER,
      HIPPO_DEMO: env.HIPPO_DEMO,
      HIPPO_EXTENSION_ID: env.HIPPO_EXTENSION_ID,
      HIPPO_CLIENT_IP_HEADER: env.HIPPO_CLIENT_IP_HEADER,
      HIPPO_ALLOWED_ORIGINS: env.HIPPO_ALLOWED_ORIGINS,
    };
    const problems = productionProblems(settings, { durable: true, mailer: mailer !== undefined });
    if (problems.length > 0) throw new StartupError(`Refusing to start: ${problems.join(" | ")}`);
  }

  // Only in development a missing key is made up for this isolate, so tokens end when it restarts.
  const signingKey = env.HIPPO_SIGNING_KEY ?? b64url(crypto.getRandomValues(new Uint8Array(32)));
  const issuer = env.HIPPO_ISSUER ?? "http://localhost:8787";
  const extensionId = env.HIPPO_EXTENSION_ID ?? (production ? undefined : DEV_EXTENSION_ID);
  const clientId = env.HIPPO_CLIENT_ID ?? "hippo-demo";
  const redirectUris = [
    ...(list(env.HIPPO_REDIRECT_URIS).length ? list(env.HIPPO_REDIRECT_URIS) : [`${issuer}/callback`]),
  ];
  if (extensionId) redirectUris.push(`https://${extensionId}.chromiumapp.org/`);
  const webOrigins = [new URL(issuer).origin, ...list(env.HIPPO_ALLOWED_ORIGINS)];
  const allowedOrigins = [...webOrigins, ...(extensionId ? [`chrome-extension://${extensionId}`] : [])];

  const authStore = createD1AuthStore(env.DB, { now });
  const auth = createAuth({
    issuer,
    resource: `${issuer}/mcp`,
    signingKey,
    clients: [{ clientId, redirectUris }],
    resolveHousehold: householdOf,
    log,
    ...(mailer ? { mailer } : {}),
    logMagicCodes: false,
    audit: (e) =>
      log(JSON.stringify({ ts: new Date(now()).toISOString(), audit: e.event, sub: e.sub, reason: e.reason })),
    store: authStore,
    allowedOrigins: webOrigins,
    now,
  });

  const repo = createD1Repository(env.DB);
  const objectStore = createR2ObjectStore(env.BUCKET);
  const indexStore = createR2IndexStore(env.BUCKET);
  return createApp({
    auth,
    repo,
    indexSource: indexStore,
    now,
    allowedOrigins,
    limiter: limiterFromStore(authStore, now),
    clientIpHeader: env.HIPPO_CLIENT_IP_HEADER ?? "cf-connecting-ip",
    hsts: issuer.startsWith("https://"),
    log,
    web: {
      objectStore,
      indexStore,
      origins: webOrigins,
      onCaptured: createCaptureIngest({ repo, objectStore, indexStore, now, log }),
    },
  });
}

let app: Hono | undefined;
let lastFailure = "";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      app ??= buildApp(env);
    } catch (e) {
      // Only text that is safe to print: the names of the settings, or the kind of error. A message of any other error
      // could hold a value (for example the bad address that made a URL fail to parse).
      const text =
        e instanceof StartupError ? e.message : `the app could not be built (${e instanceof Error ? e.name : "error"})`;
      if (text !== lastFailure) console.error(text);
      lastFailure = text;
      return new Response("Service unavailable", { status: 500, headers: { "Cache-Control": "no-store" } });
    }
    return app.fetch(request, env);
  },
};
