import { createAuth, type Auth } from "@hippo/auth";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolResult } from "core/src/contracts";
import { createMemoryRepository } from "core/src/repository";
import { createApp } from "../src/app";
import { createMemoryIndexSource, createIndexCache } from "../src/mcp/indexCache";
import type { ToolContext } from "../src/mcp/context";
import { getTokens, sendMagicCode, type FetchLike } from "../src/oauthFlow";
import { seedHousehold } from "../src/seed";

export const BASE = "http://api.hippo.test";
export const RESOURCE = `${BASE}/mcp`;
export const REDIRECT = "http://localhost:5173/callback";
export const ANCHOR = "2026-10-21";
export const NOW = Date.parse(`${ANCHOR}T12:00:00.000Z`);
export const KEY = "test-signing-key-test-signing-key-0123456789";
export const A = "hh_demo";
export const B = "hh_other";

export interface Env {
  app: ReturnType<typeof createApp>;
  auth: Auth;
  repo: ReturnType<typeof createMemoryRepository>;
  indexSource: ReturnType<typeof createMemoryIndexSource>;
  logs: string[];
  clock: { t: number };
  fetch: FetchLike;
  /** A token for the demo household (A). */
  tokenA(): Promise<string>;
  /** A token for household B, through the magic code login. */
  tokenB(): Promise<string>;
}

let ids = 0;

export async function makeEnv(
  over: { now?: number; maxBodyBytes?: number; allowedOrigins?: string[] } = {},
): Promise<Env> {
  const repo = createMemoryRepository();
  const indexSource = createMemoryIndexSource();
  const logs: string[] = [];
  const clock = { t: over.now ?? NOW };
  await seedHousehold(repo, { today: ANCHOR, householdId: A, indexSource });
  await seedSecond(repo);

  const auth = createAuth({
    issuer: BASE,
    resource: RESOURCE,
    signingKey: KEY,
    clients: [{ clientId: "hippo-demo", redirectUris: [REDIRECT] }],
    resolveHousehold: (email) => (email === "demo@hippo.test" ? A : B),
    log: (line) => logs.push(line),
    demoUser: { email: "demo@hippo.test", code: "424242" },
    serviceClient: { clientId: "svc", clientSecret: "svc-secret-value" },
    now: () => clock.t,
  });
  const app = createApp({
    auth,
    repo,
    indexSource,
    now: () => clock.t,
    newId: () => `id${++ids}`,
    ...(over.maxBodyBytes ? { maxBodyBytes: over.maxBodyBytes } : {}),
    ...(over.allowedOrigins ? { allowedOrigins: over.allowedOrigins } : {}),
  });
  const doFetch: FetchLike = (url, init) => Promise.resolve(app.request(url, init));
  const common = { base: BASE, clientId: "hippo-demo", redirectUri: REDIRECT, resource: RESOURCE, fetch: doFetch };
  return {
    app,
    auth,
    repo,
    indexSource,
    logs,
    clock,
    fetch: doFetch,
    tokenA: async () => (await getTokens(common)).accessToken,
    tokenB: async () => {
      await sendMagicCode({ ...common, email: "other@hippo.test" });
      const code = /: (\d{6})$/.exec(logs[logs.length - 1] ?? "")?.[1] ?? "";
      return (await getTokens({ ...common, login: { email: "other@hippo.test", code } })).accessToken;
    },
  };
}

/** Household B: a telescope, a subscription, and one document nobody else should ever see. */
async function seedSecond(repo: ReturnType<typeof createMemoryRepository>): Promise<void> {
  const createdAt = `${ANCHOR}T00:00:00.000Z`;
  await repo.putHousehold(B, { id: B, digestOn: true, createdAt });
  await repo.putAsset(B, { id: "B-telescope", name: "Telescope", aliases: [], category: "electronics", createdAt });
  await repo.putAgreement(B, {
    id: "agr-orbit",
    kind: "subscription",
    party: "Orbit Streaming",
    title: "Orbit Streaming",
    assetIds: [],
    fields: {
      vendor: "Orbit Streaming",
      amount: 5,
      cycle: "monthly",
      nextChargeDate: "2026-10-24",
      cancelNoticeDays: 1,
    },
    fieldStatus: {
      vendor: "confirmed",
      amount: "confirmed",
      cycle: "confirmed",
      nextChargeDate: "confirmed",
      cancelNoticeDays: "confirmed",
    },
    sourceRefs: {},
    createdAt,
  });
  const { syncObligations } = await import("../src/obligations");
  const agr = await repo.getAgreement(B, "agr-orbit");
  await syncObligations(repo, B, agr!, await repo.listAssets(B), ANCHOR);
}

export interface Connected {
  client: Client;
  call(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

/** A real SDK client over the Streamable HTTP client transport, with the app as its fetch. */
export async function connect(
  env: Env,
  token: string,
  opts: { fetch?: FetchLike; url?: string } = {},
): Promise<Connected> {
  const doFetch = opts.fetch ?? env.fetch;
  const transport = new StreamableHTTPClientTransport(new URL(opts.url ?? RESOURCE), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: doFetch as typeof fetch,
  });
  const client = new Client({ name: "hippo-test", version: "0.0.0" });
  await client.connect(transport);
  return {
    client,
    call: async (name, args = {}) => (await client.callTool({ name, arguments: args })) as unknown as ToolResult,
    close: () => client.close(),
  };
}

/** A direct context for calling tool handlers without HTTP. */
export function makeContext(env: Pick<Env, "repo" | "indexSource">, over: Partial<ToolContext> = {}): ToolContext {
  return {
    householdId: A,
    repo: env.repo,
    today: ANCHOR,
    nowMs: NOW,
    newId: () => `id${++ids}`,
    indexes: createIndexCache(env.indexSource),
    ...over,
  };
}

export const text = (r: ToolResult): string => r.content.map((c) => c.text).join(" ");

export async function rpc(
  env: Env,
  token: string | null,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return env.fetch(RESOURCE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

export const callBody = (name: string, args: Record<string, unknown>, id = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});
