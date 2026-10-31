import { readFileSync } from "node:fs";
import { createAuth } from "@hippo/auth";
import { createMemoryRepository } from "core/src/repository";
import { createApp, type AppDeps, type WebDeps } from "../src/app";
import { createFixtureIngest } from "../src/api/demoIngest";
import { createLocalUploader, createMemoryObjectStore } from "../src/api/storage";
import { createIndexCache, createMemoryIndexSource } from "../src/mcp/indexCache";
import { seedHousehold } from "../src/seed";
import type { ToolContext } from "../src/mcp/context";
import { A, ANCHOR, BASE, KEY, NOW, RESOURCE, makeContext } from "./helpers";

export const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`../../../fixtures/docs/${name}`, import.meta.url)));
export const PDF_BYTES = new TextEncoder().encode("%PDF-1.4\nnot a demo document\n");
export const DEV_ORIGIN = "http://localhost:5173";

export interface Call {
  method?: string;
  json?: unknown;
  body?: BodyInit;
  type?: string | null;
  origin?: string | null;
  headers?: Record<string, string>;
}

export interface Client {
  cookie: string;
  call(path: string, c?: Call): Promise<Response>;
  get(path: string): Promise<Response>;
  send(method: string, path: string, json: unknown): Promise<Response>;
}

export type Web = Awaited<ReturnType<typeof makeWeb>>;

export async function makeWeb(over: { web?: WebDeps; app?: Partial<AppDeps> } = {}) {
  const repo = createMemoryRepository();
  const indexSource = createMemoryIndexSource();
  const objectStore = createMemoryObjectStore();
  const logs: string[] = [];
  const requestLog: string[] = [];
  const clock = { t: NOW };
  await seedHousehold(repo, { today: ANCHOR, householdId: A, indexSource, pageStore: objectStore });
  const auth = createAuth({
    issuer: BASE,
    resource: RESOURCE,
    signingKey: KEY,
    clients: [{ clientId: "hippo-demo", redirectUris: ["http://localhost:5173/callback"] }],
    resolveHousehold: (email) => (email === "demo@hippo.test" ? A : `hh_${email.split("@")[0]}`),
    log: (line) => logs.push(line),
    demoUser: { email: "demo@hippo.test", code: "424242" },
    allowedOrigins: [BASE, DEV_ORIGIN],
    now: () => clock.t,
  });
  let n = 0;
  const newId = () => `t${++n}`;
  const app = createApp({
    auth,
    repo,
    indexSource,
    now: () => clock.t,
    newId,
    // The app's own lines (one per request) stay apart from `logs`, where the login helper looks for the last code.
    log: (line) => requestLog.push(line),
    web: {
      objectStore,
      uploader: createLocalUploader(),
      origins: [DEV_ORIGIN],
      // The demo ingest, as createApp used to default to, so the upload tests keep their behaviour.
      onUploaded: createFixtureIngest({ repo, objectStore, indexStore: indexSource, now: () => clock.t, newId }),
      ...over.web,
    },
    ...over.app,
  });

  const clientFor = (cookie: string): Client => {
    const call: Client["call"] = (path, c = {}) => {
      const method = c.method ?? (c.json !== undefined || c.body !== undefined ? "POST" : "GET");
      const headers: Record<string, string> = { ...(cookie ? { cookie } : {}), ...c.headers };
      const origin = c.origin === undefined ? (method === "GET" ? null : BASE) : c.origin;
      if (origin) headers.origin = origin;
      const type = c.type === undefined ? (c.json !== undefined ? "application/json" : null) : c.type;
      if (type) headers["content-type"] = type;
      const body = c.json !== undefined ? JSON.stringify(c.json) : c.body;
      return Promise.resolve(
        app.request(`${BASE}${path}`, {
          method,
          headers,
          ...(body !== undefined ? { body } : {}),
          ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
        } as RequestInit),
      );
    };
    return {
      cookie,
      call,
      get: (path) => call(path),
      send: (method, path, json) => call(path, { method, json }),
    };
  };

  const login = async (body: Record<string, unknown>): Promise<string> => {
    const r = await app.request(`${BASE}/oauth/session`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify(body),
    });
    return /hippo_session=[^;]+/.exec(r.headers.get("set-cookie") ?? "")?.[0] ?? "";
  };
  const loginAs = async (email: string): Promise<string> => {
    await app.request(`${BASE}/oauth/magic-code`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email }),
    });
    const code = /: (\d{6})$/.exec(logs[logs.length - 1] ?? "")?.[1] ?? "";
    return login({ email, code });
  };

  const a = clientFor(await login({ demo: true }));
  const b = clientFor(await loginAs("other@hippo.test"));

  /** Uploads bytes the way the browser does: announce, then PUT to the returned url. */
  async function upload(
    cl: Client,
    filename: string,
    bytes: Uint8Array,
    contentType = "application/pdf",
  ): Promise<{ docId: string; put: Response }> {
    const r = await cl.send("POST", "/api/uploads", { filename, contentType, size: bytes.length });
    const { docId, upload: d } = (await r.json()) as { docId: string; upload: { url: string } };
    const put = await cl.call(d.url, { method: "PUT", body: bytes as BodyInit, type: contentType });
    return { docId, put };
  }

  const ctxFor = (householdId: string): ToolContext =>
    makeContext(
      { repo, indexSource },
      { householdId, today: ANCHOR, nowMs: clock.t, indexes: createIndexCache(indexSource) },
    );

  return {
    app,
    auth,
    repo,
    indexSource,
    objectStore,
    logs,
    requestLog,
    clock,
    a,
    b,
    clientFor,
    upload,
    ctxFor,
    anon: clientFor(""),
  };
}

export const json = async <T = any>(r: Response): Promise<T> => (await r.json()) as T;
