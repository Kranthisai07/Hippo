import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  authzParams,
  codeGrant,
  openAuthorize,
  pkce,
  postAuthorize,
  tokenReq,
  REDIRECT,
  RESOURCE,
  type Env as AuthTestEnv,
} from "../../../packages/auth/test/helpers";
import { createSqliteD1 } from "../../../packages/core/test/d1.sqlite";
import { createHash } from "node:crypto";
import worker, { buildApp, householdOf, StartupError, type Env } from "../src/index";
import { fakeBucket } from "./fakes";

// The whole Workers app, in process: the entry wired to the D1 stores (on node:sqlite), an R2 fake and a fake email
// binding. It runs the extension's real path: sign in by emailed code with PKCE, save a page, list it, and check that a
// second person sees nothing. It does not prove Cloudflare's runtime: that is the wrangler dev run and staging.

const ISSUER = "https://api.hippo.test";
const T0 = Date.UTC(2026, 9, 31, 12, 0, 0);
const GOOD_PRODUCTION: Partial<Env> = {
  HIPPO_ENV: "production",
  HIPPO_DEMO: "0",
  HIPPO_SIGNING_KEY: "k".repeat(40),
  HIPPO_ISSUER: ISSUER,
  HIPPO_ALLOWED_ORIGINS: "https://app.hippo.test",
  HIPPO_CLIENT_IP_HEADER: "cf-connecting-ip",
};

const page = (name: string): string => {
  const html = readFileSync(new URL(`../../../fixtures/pages/${name}.html`, import.meta.url), "utf8");
  return /<body>([\s\S]*)<\/body>/
    .exec(html)![1]!
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, "\n")
    .replaceAll("&gt;", ">");
};

function makeEnv(over: Partial<Env> = {}) {
  const db = createSqliteD1();
  const { bucket, objects } = fakeBucket();
  const mails: { to: string; text: string }[] = [];
  const env: Env = {
    DB: db,
    BUCKET: bucket,
    EMAIL: {
      async send(m) {
        mails.push({ to: m.to, text: m.text });
        return { messageId: "m" };
      },
    },
    // Strict is the default, so the tests that are not about the settings say they are a local run.
    HIPPO_ENV: "development",
    HIPPO_ISSUER: ISSUER,
    HIPPO_CLIENT_ID: "alexa",
    HIPPO_REDIRECT_URIS: REDIRECT,
    HIPPO_SIGNING_KEY: "test-signing-key-test-signing-key-0123456789",
    HIPPO_EXTENSION_ID: "abcdefghijklmnopabcdefghijklmnop",
    HIPPO_MAIL_FROM: "Hippo <login@hippo.test>",
    ...over,
  };
  return { env, db, objects, mails };
}

function setup(over: Partial<Env> = {}) {
  const { env, db, objects, mails } = makeEnv(over);
  const logs: string[] = [];
  const app = buildApp(env, { now: () => T0, log: (l) => logs.push(l) });
  const req = (path: string, init?: RequestInit) => Promise.resolve(app.request(ISSUER + path, init));
  // What the auth package's own test helpers need: a way to send a request.
  const authEnv = { req, logs, clock: { t: T0 }, auth: undefined as never } as AuthTestEnv;
  const codeFor = (email: string): string =>
    /\b(\d{6})\b/.exec([...mails].reverse().find((m) => m.to === email)!.text)![1]!;

  /** Sign in by the extension's route: authorize page, emailed code, PKCE token exchange. */
  async function signIn(email: string): Promise<string> {
    const { verifier, challenge } = await pkce();
    const p = authzParams(challenge);
    const form = await openAuthorize(authEnv, p);
    const sent = await postAuthorize(authEnv, form, p, { action: "send", email });
    expect(sent.status).toBe(200);
    const done = await postAuthorize(authEnv, form, p, { action: "login", email, code: codeFor(email) });
    const code = new URL(done.headers.get("location")!).searchParams.get("code")!;
    const tokens = (await (await tokenReq(authEnv, codeGrant(code, verifier))).json()) as { access_token: string };
    expect(tokens.access_token).toBeTruthy();
    return tokens.access_token;
  }
  const authed = (token: string, path: string, body?: unknown) =>
    req(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { app, req, env, db, objects, mails, logs, signIn, authed, codeFor };
}

describe("the Workers app", () => {
  it("answers health, the OAuth metadata and a bare 401 with the security headers and a request id", async () => {
    const t = setup();
    expect((await t.req("/healthz")).status).toBe(200);
    const meta = (await (await t.req("/.well-known/oauth-authorization-server")).json()) as Record<string, string>;
    expect(meta.issuer).toBe(ISSUER);
    expect(meta.revocation_endpoint).toBe(`${ISSUER}/oauth/revoke`);
    const denied = await t.req("/ext/subscriptions");
    expect(denied.status).toBe(401);
    expect(denied.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(denied.headers.get("x-content-type-options")).toBe("nosniff");
    expect(denied.headers.get("strict-transport-security")).toContain("max-age=");
  });

  it("signs in by emailed code, saves a page, lists it, and a second person sees nothing", async () => {
    const t = setup();
    const alice = await t.signIn("alice@example.com");
    expect(t.mails.at(-1)).toMatchObject({ to: "alice@example.com" });
    expect(t.mails.at(-1)!.text).toMatch(/\d{6}/);

    const saved = await t.authed(alice, "/ext/captures", {
      title: "Billing | Fernwood Plus",
      host: "account.fernwood-plus.example",
      text: page("fernwood_billing"),
    });
    expect(saved.status).toBe(201);
    const list = (await (await t.authed(alice, "/ext/subscriptions")).json()) as {
      subscriptions: { vendor: string; confirmed: boolean }[];
    };
    expect(list.subscriptions).toHaveLength(1);
    expect(list.subscriptions[0]!.confirmed).toBe(false);

    const bob = await t.signIn("bob@example.com");
    const theirs = (await (await t.authed(bob, "/ext/subscriptions")).json()) as { subscriptions: unknown[] };
    expect(theirs.subscriptions).toEqual([]);
    // The page text is in R2 under alice's household only.
    const hh = await householdOf("alice@example.com");
    expect([...t.objects.keys()].filter((k) => k.includes(hh)).length).toBeGreaterThan(0);
    const bobHh = await householdOf("bob@example.com");
    expect([...t.objects.keys()].filter((k) => k.includes(bobHh))).toEqual([]);
  });

  it("keeps the sign in code out of the log, and the page text too", async () => {
    const t = setup();
    const token = await t.signIn("carol@example.com");
    const code = t.codeFor("carol@example.com");
    await t.authed(token, "/ext/captures", { title: "Billing", host: "x.example", text: page("fernwood_billing") });
    const all = t.logs.join("\n");
    expect(all).not.toContain(code);
    expect(all).not.toContain("carol@example.com");
    expect(all).not.toContain(token);
    expect(all).not.toContain("Fernwood");
  });

  it("refuses uploads with a plain 503 until an ingest is connected", async () => {
    const t = setup();
    const code = await (async () => {
      await t.req("/oauth/magic-code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "dave@example.com" }),
      });
      return t.codeFor("dave@example.com");
    })();
    const session = await t.req("/oauth/session", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ISSUER },
      body: JSON.stringify({ email: "dave@example.com", code }),
    });
    expect(session.status).toBe(200);
    const cookie = /hippo_session=[^;]+/.exec(session.headers.get("set-cookie")!)![0];
    const r = await t.req("/api/uploads", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ISSUER, cookie },
      body: JSON.stringify({ filename: "a.pdf", contentType: "application/pdf", size: 5 }),
    });
    expect(r.status).toBe(503);
  });

  it("serves the MCP endpoint to a signed in client", async () => {
    const t = setup();
    const token = await t.signIn("erin@example.com");
    const r = await t.req("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
      }),
    });
    expect(r.status).toBe(200);
    expect(RESOURCE).toBe(`${ISSUER}/mcp`);
  });
});

describe("production settings", () => {
  const GOOD: Partial<Env> = {
    HIPPO_ENV: "production",
    HIPPO_DEMO: "0",
    HIPPO_SIGNING_KEY: "k".repeat(40),
    HIPPO_ISSUER: ISSUER,
    HIPPO_ALLOWED_ORIGINS: "https://app.hippo.test",
    HIPPO_CLIENT_IP_HEADER: "cf-connecting-ip",
  };

  it("starts with every setting present", () => {
    expect(() => setup(GOOD)).not.toThrow();
  });
  it("refuses to start without the settings, and names them without ever printing a value", () => {
    const secret = "SECRET-VALUE-XYZ";
    const bad = { ...GOOD, HIPPO_SIGNING_KEY: secret, HIPPO_DEMO: "1", HIPPO_EXTENSION_ID: undefined };
    let message = "";
    try {
      setup(bad);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("HIPPO_SIGNING_KEY");
    expect(message).toContain("HIPPO_DEMO");
    expect(message).toContain("HIPPO_EXTENSION_ID");
    expect(message).not.toContain(secret);
  });
  it("has no demo login and, in production, no console mailer", () => {
    expect(() => setup({ ...GOOD, EMAIL: undefined })).toThrow(/mailer/i);
  });
  it("the Worker answers a bare 500 when it cannot start, and says nothing a caller could use", async () => {
    const { env } = setup();
    const res = await worker.fetch(new Request(`${ISSUER}/healthz`), {
      ...env,
      HIPPO_ENV: "production",
      HIPPO_DEMO: "1",
    });
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Service unavailable");
  });
});

describe("the default is strict", () => {
  const ALL: Partial<Env> = {
    HIPPO_DEMO: "0",
    HIPPO_SIGNING_KEY: "k".repeat(40),
    HIPPO_ISSUER: ISSUER,
    HIPPO_ALLOWED_ORIGINS: "https://app.hippo.test",
    HIPPO_CLIENT_IP_HEADER: "cf-connecting-ip",
  };
  const NONE: Partial<Env> = {
    HIPPO_SIGNING_KEY: undefined,
    HIPPO_ISSUER: undefined,
    HIPPO_EXTENSION_ID: undefined,
  };

  it.each([undefined, "", "Production", "prod", "staging", "Development"])(
    "HIPPO_ENV %j without the production settings refuses to start, naming them",
    (value) => {
      expect(() => setup({ ...NONE, HIPPO_ENV: value })).toThrow(StartupError);
      expect(() => setup({ ...NONE, HIPPO_ENV: value })).toThrow(/HIPPO_SIGNING_KEY/);
    },
  );

  it("an unset HIPPO_ENV with every setting and an email binding starts", () => {
    expect(() => setup({ ...ALL, HIPPO_ENV: undefined })).not.toThrow();
  });

  it("an unset HIPPO_ENV with every setting but no email binding refuses, and no code can reach a log", () => {
    const logs: string[] = [];
    const { env } = makeEnv({ ...ALL, HIPPO_ENV: undefined, EMAIL: undefined });
    expect(() => buildApp(env, { log: (l) => logs.push(l) })).toThrow(/mailer/i);
    expect(logs).toEqual([]);
  });

  it.each(["development", "local"])(
    "HIPPO_ENV %s is the only way to the relaxed mode: the code goes to the log",
    async (value) => {
      const logs: string[] = [];
      const { env } = makeEnv({ HIPPO_ENV: value, EMAIL: undefined, HIPPO_SIGNING_KEY: undefined });
      const app = buildApp(env, { now: () => T0, log: (l) => logs.push(l) });
      const r = await app.request(`${ISSUER}/oauth/magic-code`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "frank@example.com" }),
      });
      expect(r.status).toBe(200);
      expect(logs.some((l) => /sign in code for frank@example\.com: \d{6}/.test(l))).toBe(true);
    },
  );

  it("a build that fails for another reason logs only the kind of error, never a value", async () => {
    const { env } = makeEnv({ HIPPO_ISSUER: "not a url SECRET-ISSUER-VALUE" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await worker.fetch(new Request(`${ISSUER}/healthz`), env);
      expect(res.status).toBe(500);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]![0])).toContain("TypeError");
      expect(JSON.stringify(spy.mock.calls)).not.toContain("SECRET-ISSUER-VALUE");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("householdOf", () => {
  it.each(["alice@example.com", "Alice@Example.COM", "alice+news@example.com", "jürgen@example.de", "а@example.com"])(
    "is hh_ and the first 16 characters of the base64url SHA-256 of %j, as the Node server computes it",
    async (email) => {
      const node = `hh_${createHash("sha256").update(email).digest("base64url").slice(0, 16)}`;
      expect(await householdOf(email)).toBe(node);
    },
  );
});

describe("Continue with Google on the Worker", () => {
  const ID = "1234-test.apps.googleusercontent.com";

  it("is offered only when both the client id and the secret are set", async () => {
    const off = setup();
    expect(await (await off.req("/oauth/providers")).json()).toEqual({ google: false });
    const on = setup({ HIPPO_GOOGLE_CLIENT_ID: ID, HIPPO_GOOGLE_CLIENT_SECRET: "secret" });
    expect(await (await on.req("/oauth/providers")).json()).toEqual({ google: true });
    // One without the other is not enough, and in the relaxed mode it simply stays off.
    const half = setup({ HIPPO_GOOGLE_CLIENT_ID: ID });
    expect(await (await half.req("/oauth/providers")).json()).toEqual({ google: false });
  });
  it("starts a web sign in by sending the browser to Google with the Worker's own callback address", async () => {
    const t = setup({ HIPPO_GOOGLE_CLIENT_ID: ID, HIPPO_GOOGLE_CLIENT_SECRET: "secret" });
    const res = await t.req("/oauth/google/start?return=%2Freview%2Fdoc-1");
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!);
    expect(to.origin).toBe("https://accounts.google.com");
    expect(to.searchParams.get("client_id")).toBe(ID);
    expect(to.searchParams.get("redirect_uri")).toBe(`${ISSUER}/oauth/google/callback`);
    expect(res.headers.get("location")).not.toContain("secret");
    expect(res.headers.getSetCookie().some((c) => c.startsWith("hippo_gpending="))).toBe(true);
  });
  it("in production a client id without its secret stops the start, naming the settings", () => {
    expect(() => setup({ ...GOOD_PRODUCTION, HIPPO_GOOGLE_CLIENT_ID: ID })).toThrow(/HIPPO_GOOGLE_CLIENT_ID/);
  });
});
