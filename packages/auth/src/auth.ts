import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { defaultRandom, safeEqual, sha256b64url, sixDigits, token, type RandomBytes } from "./crypto";
import { errorPage, loginPage } from "./pages";
import { createMemoryStore, type AuthStore } from "./store";
import { keyBytes, signAccess, verifyAccess } from "./tokens";

export const SCOPE_SERVICE = "mcp:service";
export const USER_SCOPES = ["mcp:tools", "mcp:resources"] as const;

export interface ClientConfig {
  clientId: string;
  /** Exact match only. No wildcards, no prefixes. */
  redirectUris: string[];
  /** Omit for a public client (the Alexa client). */
  secret?: string;
}

export interface AuthOptions {
  /** Public origin of this server, for example https://api.hippo.example */
  issuer: string;
  /** The MCP resource URL tokens are bound to, for example https://api.hippo.example/mcp */
  resource: string;
  /** At least 32 bytes. Comes from SSM or env, never from source. */
  signingKey: string | Uint8Array;
  clients: ClientConfig[];
  /** Maps a verified email to a household id. Called only after login. */
  resolveHousehold: (email: string) => string | Promise<string>;
  /** Receives the one deliberate magic code line. Nothing else it receives is secret. */
  log: (line: string) => void;
  demoUser?: { email: string; code: string };
  /**
   * Whether the magic code is printed through `log` so a person at the terminal can read it (the demo, no mailer
   * exists). Defaults to true. Turn it off anywhere the log is shared: the code is a login credential.
   */
  logMagicCodes?: boolean;
  /** Service credentials for the client_credentials grant (scope mcp:service only). */
  serviceClient?: { clientId: string; clientSecret: string };
  /** Origins allowed to call the cookie session endpoints. Defaults to the issuer origin. */
  allowedOrigins?: string[];
  store?: AuthStore;
  now?: () => number;
  random?: RandomBytes;
  /** Defaults to true when the issuer is https. */
  secureCookie?: boolean;
}

export const TTL = {
  codeMs: 60_000,
  accessSec: 900,
  refreshMs: 30 * 24 * 3600_000,
  sessionMs: 7 * 24 * 3600_000,
  magicMs: 10 * 60_000,
} as const;

const MAX_BODY = 16 * 1024;
const MAX_MAGIC_ATTEMPTS = 5;
// Counters are keyed by email, not by code, so issuing a new code never resets them.
const SEND_GAP_MS = 60_000;
const SENDS_PER_HOUR = 5;
const MAX_GUESSES = 10;
const GUESS_WINDOW_MS = 15 * 60_000;
const SESSION_COOKIE = "hippo_session";
const CSRF_COOKIE = "hippo_csrf";
const B64URL = /^[A-Za-z0-9_-]+$/;
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
const EMAIL = /^[^\s@<>"',;]{1,64}@[^\s@<>"',;]{1,185}\.[^\s@<>"',;]{2,}$/;

export const trimSlash = (u: string): string => (u.endsWith("/") ? u.slice(0, -1) : u);

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const e = raw.normalize("NFKC").trim().toLowerCase();
  return e.length <= 254 && EMAIL.test(e) ? e : null;
}

const noStore = { "Cache-Control": "no-store", Pragma: "no-cache" } as const;

export function unauthorized(): Response {
  // Deliberately no WWW-Authenticate header (Alexa+ checklist, G-003).
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json", ...noStore },
  });
}

function bearerToken(header: string | undefined | null): string | null {
  if (typeof header !== "string" || header.length > 4096) return null;
  const m = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i.exec(header);
  return m?.[1] ?? null;
}

export interface Auth {
  app: Hono;
  verifyBearer(header: string | undefined): Promise<{ householdId: string; scope: string } | null>;
  /** True only for a valid client_credentials token (scope mcp:service, no household). */
  verifyServiceBearer(header: string | undefined): Promise<boolean>;
  /** Reads the Authorization header only. A token in the query string is ignored. */
  verifyRequest(req: Request): Promise<{ householdId: string; scope: string } | null>;
  verifySession(cookieHeader: string | undefined): Promise<{ email: string; householdId: string } | null>;
}

type AuthzParams = {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string | undefined;
  codeChallenge: string;
  resource: string;
};
type RedirectErr = { uri: string; error: string; desc: string; state: string | undefined };
type AuthzCheck = { ok: true; p: AuthzParams } | { ok: false; page: string } | { ok: false; redirect: RedirectErr };

export function createAuth(opts: AuthOptions): Auth {
  const key = keyBytes(opts.signingKey);
  const issuer = trimSlash(opts.issuer);
  const resource = trimSlash(opts.resource);
  const resourceForms = [resource, resource + "/"];
  const store = opts.store ?? createMemoryStore();
  const now = opts.now ?? Date.now;
  const random = opts.random ?? defaultRandom;
  const secure = opts.secureCookie ?? issuer.startsWith("https:");
  const origins = new Set(opts.allowedOrigins ?? [new URL(issuer).origin]);
  const clients = new Map(opts.clients.map((c) => [c.clientId, c]));
  const allScopes = [...USER_SCOPES, SCOPE_SERVICE];

  const app = new Hono();
  const limit = bodyLimit({
    maxSize: MAX_BODY,
    onError: (c) => c.json({ error: "invalid_request", error_description: "body too large" }, 413, noStore),
  });

  app.use("*", async (c, next) => {
    await next();
    c.res.headers.set("X-Content-Type-Options", "nosniff");
  });

  // Discovery

  app.get("/.well-known/oauth-protected-resource", (c) =>
    c.json({
      resource,
      authorization_servers: [issuer],
      scopes_supported: allScopes,
      bearer_methods_supported: ["header"],
    }),
  );

  app.get("/.well-known/oauth-authorization-server", (c) =>
    c.json({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
      scopes_supported: allScopes,
    }),
  );

  // Helpers

  // null means the parameter was sent more than once, which is always rejected.
  const single = (sp: URLSearchParams, name: string): string | undefined | null => {
    const all = sp.getAll(name);
    return all.length > 1 ? null : all[0];
  };

  const pageHeaders = (c: Context): void => {
    c.header("Cache-Control", "no-store");
    c.header(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    );
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
  };

  const cookieOpts = (path: string, maxAgeSec: number) =>
    ({ httpOnly: true, secure, sameSite: "Lax", path, maxAge: maxAgeSec }) as const;

  const identity = async (email: string): Promise<{ sub: string; householdId: string }> => {
    const householdId = await opts.resolveHousehold(email);
    if (typeof householdId !== "string" || householdId === "") throw new Error("resolveHousehold returned no id");
    return { sub: "u_" + (await sha256b64url(email)).slice(0, 22), householdId };
  };

  const retrySec = (ms: number): number => Math.max(1, Math.ceil(ms / 1000));

  /** Returns Retry-After seconds when the send is refused, otherwise null. */
  const issueMagic = async (email: string): Promise<number | null> => {
    const gate = await store.tryHit(
      "send:" + (await sha256b64url(email)),
      3600_000,
      SENDS_PER_HOUR,
      SEND_GAP_MS,
      now(),
    );
    if (!gate.ok) return retrySec(gate.retryAfterMs);
    const code = sixDigits(random);
    await store.putMagic(await sha256b64url(email), {
      codeHash: await sha256b64url(code),
      expiresAt: now() + TTL.magicMs,
      attempts: 0,
    });
    // DELIBERATE: the only place a secret is logged. The demo has no mail provider, so the magic code goes to the server log.
    if (opts.logMagicCodes !== false) opts.log(`[hippo-auth] magic code for ${email}: ${code}`);
    return null;
  };

  // Every guess takes a slot before it is compared, so parallel guesses cannot exceed the limit.
  // The demo code goes through the same counter. A success clears it.
  const checkMagic = async (email: string, code: unknown): Promise<"ok" | "bad" | { retryAfterSec: number }> => {
    if (typeof code !== "string" || code.length === 0 || code.length > 12) return "bad";
    const k = await sha256b64url(email);
    const slot = await store.tryHit("fail:" + k, GUESS_WINDOW_MS, MAX_GUESSES, 0, now());
    if (!slot.ok) return { retryAfterSec: retrySec(slot.retryAfterMs) };
    const ok = async (): Promise<"ok"> => {
      await store.clearCounter("fail:" + k);
      await store.deleteMagic(k);
      return "ok";
    };
    if (opts.demoUser && email === opts.demoUser.email && (await safeEqual(code, opts.demoUser.code))) return ok();
    const rec = await store.getMagic(k);
    if (!rec || rec.expiresAt <= now()) return "bad";
    if (rec.attempts >= MAX_MAGIC_ATTEMPTS) {
      await store.deleteMagic(k);
      return "bad";
    }
    if (await safeEqual(await sha256b64url(code), rec.codeHash)) return ok();
    await store.putMagic(k, { ...rec, attempts: rec.attempts + 1 });
    return "bad";
  };

  const limited = (c: Context, retryAfterSec: number): Response =>
    c.json({ error: "rate_limited" }, 429, { ...noStore, "Retry-After": String(retryAfterSec) });

  const startSession = async (c: Context, email: string): Promise<{ email: string; householdId: string }> => {
    const id = await identity(email);
    const sid = token(random);
    await store.putSession(await sha256b64url(sid), { email, ...id, expiresAt: now() + TTL.sessionMs });
    setCookie(c, SESSION_COOKIE, sid, cookieOpts("/", TTL.sessionMs / 1000));
    return { email, householdId: id.householdId };
  };

  const sessionFromId = async (sid: string | undefined) => {
    if (!sid || sid.length > 200) return null;
    const k = await sha256b64url(sid);
    const s = await store.getSession(k);
    if (!s) return null;
    if (s.expiresAt <= now()) {
      await store.deleteSession(k);
      return null;
    }
    return s;
  };

  // Authorize

  const checkAuthorize = (sp: URLSearchParams): AuthzCheck => {
    const clientId = single(sp, "client_id");
    const redirectUri = single(sp, "redirect_uri");
    const client = typeof clientId === "string" ? clients.get(clientId) : undefined;
    if (!client) return { ok: false, page: "Unknown client." };
    // Exact string match against the registered list. Nothing is redirected before this passes.
    if (typeof redirectUri !== "string" || !client.redirectUris.includes(redirectUri)) {
      return { ok: false, page: "The redirect address is not registered for this client." };
    }
    const state = single(sp, "state");
    const fail = (error: string, desc: string): AuthzCheck => ({
      ok: false,
      redirect: { uri: redirectUri, error, desc, state: state ?? undefined },
    });
    if (state === null || (state !== undefined && state.length > 512)) return fail("invalid_request", "bad state");
    if (single(sp, "response_type") !== "code") return fail("unsupported_response_type", "response_type must be code");
    const challenge = single(sp, "code_challenge");
    if (typeof challenge !== "string" || challenge.length !== 43 || !B64URL.test(challenge)) {
      return fail("invalid_request", "code_challenge (S256) is required");
    }
    if (single(sp, "code_challenge_method") !== "S256") {
      return fail("invalid_request", "code_challenge_method must be S256");
    }
    const res = single(sp, "resource");
    if (typeof res !== "string" || !resourceForms.includes(res)) {
      return fail("invalid_target", "resource is required and must match");
    }
    const rawScope = single(sp, "scope");
    if (rawScope === null) return fail("invalid_scope", "bad scope");
    const scopes = (rawScope ?? USER_SCOPES.join(" ")).split(" ").filter(Boolean);
    if (scopes.length === 0 || scopes.some((s) => !(USER_SCOPES as readonly string[]).includes(s))) {
      return fail("invalid_scope", "unsupported scope");
    }
    return {
      ok: true,
      p: {
        clientId: client.clientId,
        redirectUri,
        scope: [...new Set(scopes)].join(" "),
        state: state ?? undefined,
        codeChallenge: challenge,
        resource,
      },
    };
  };

  const redirectError = (c: Context, r: RedirectErr): Response => {
    const u = new URL(r.uri);
    u.searchParams.set("error", r.error);
    u.searchParams.set("error_description", r.desc);
    if (r.state !== undefined) u.searchParams.set("state", r.state);
    return c.redirect(u.toString(), 302);
  };

  const hiddenFor = (p: AuthzParams): Record<string, string> => {
    const h: Record<string, string> = {
      client_id: p.clientId,
      redirect_uri: p.redirectUri,
      response_type: "code",
      scope: p.scope,
      code_challenge: p.codeChallenge,
      code_challenge_method: "S256",
      resource: p.resource,
    };
    if (p.state !== undefined) h.state = p.state;
    return h;
  };

  const renderLogin = async (
    c: Context,
    p: AuthzParams,
    csrf: string,
    extra: { email?: string; notice?: string; error?: string } = {},
    status: 200 | 401 | 429 = 200,
  ): Promise<Response> => {
    const s = await sessionFromId(getCookie(c, SESSION_COOKIE));
    const html = loginPage({
      hidden: hiddenFor(p),
      csrf,
      email: extra.email ?? "",
      notice: extra.notice,
      error: extra.error,
      demo: Boolean(opts.demoUser),
      sessionEmail: s?.email,
    });
    return c.html(html, status);
  };

  app.get("/oauth/authorize", async (c) => {
    pageHeaders(c);
    const chk = checkAuthorize(new URL(c.req.url).searchParams);
    if (!chk.ok) return "page" in chk ? c.html(errorPage(chk.page), 400) : redirectError(c, chk.redirect);
    const csrf = token(random);
    setCookie(c, CSRF_COOKIE, csrf, cookieOpts("/oauth", 1800));
    return renderLogin(c, chk.p, csrf);
  });

  app.post("/oauth/authorize", limit, async (c) => {
    pageHeaders(c);
    const bad = () => c.html(errorPage("Bad request."), 400);
    const ct = c.req.header("content-type") ?? "";
    if (!ct.toLowerCase().startsWith("application/x-www-form-urlencoded")) return bad();
    const sp = new URLSearchParams(await c.req.text());
    const csrfCookie = getCookie(c, CSRF_COOKIE);
    const csrfField = single(sp, "csrf");
    if (!csrfCookie || typeof csrfField !== "string" || !(await safeEqual(csrfCookie, csrfField))) {
      return c.html(errorPage("Your sign in form expired. Go back and try again."), 403);
    }
    const chk = checkAuthorize(sp);
    if (!chk.ok) return "page" in chk ? c.html(errorPage(chk.page), 400) : redirectError(c, chk.redirect);
    const p = chk.p;
    const action = single(sp, "action");
    let email: string | null = null;

    if (action === "continue") {
      const s = await sessionFromId(getCookie(c, SESSION_COOKIE));
      if (!s) return renderLogin(c, p, csrfCookie, { error: "Your session ended. Sign in again." }, 401);
      email = s.email;
    } else if (action === "demo") {
      if (!opts.demoUser) return renderLogin(c, p, csrfCookie, { error: "Demo login is off." }, 401);
      email = normalizeEmail(opts.demoUser.email);
    } else if (action === "send") {
      const e = normalizeEmail(single(sp, "email"));
      const wait = e ? await issueMagic(e) : null;
      if (wait !== null) {
        c.header("Retry-After", String(wait));
        return renderLogin(
          c,
          p,
          csrfCookie,
          { email: e ?? "", error: "Too many codes requested. Try again later." },
          429,
        );
      }
      return renderLogin(c, p, csrfCookie, {
        email: e ?? "",
        notice: "If that address can sign in, a code was sent. Enter it below.",
      });
    } else if (action === "login") {
      const e = normalizeEmail(single(sp, "email"));
      const r = e ? await checkMagic(e, single(sp, "code")) : "bad";
      if (typeof r === "object") {
        c.header("Retry-After", String(r.retryAfterSec));
        return renderLogin(c, p, csrfCookie, { email: e ?? "", error: "Too many tries. Try again later." }, 429);
      }
      if (e && r === "ok") email = e;
      else return renderLogin(c, p, csrfCookie, { email: e ?? "", error: "That code did not work." }, 401);
    } else {
      return bad();
    }
    if (!email) return bad();

    // The household comes from the server side mapping, never from the request.
    const id = await identity(email);
    const code = token(random);
    await store.putCode(await sha256b64url(code), {
      clientId: p.clientId,
      redirectUri: p.redirectUri,
      codeChallenge: p.codeChallenge,
      resource: p.resource,
      scope: p.scope,
      sub: id.sub,
      householdId: id.householdId,
      familyId: token(random, 16),
      expiresAt: now() + TTL.codeMs,
    });
    const u = new URL(p.redirectUri);
    u.searchParams.set("code", code);
    if (p.state !== undefined) u.searchParams.set("state", p.state);
    deleteCookie(c, CSRF_COOKIE, { path: "/oauth" });
    return c.redirect(u.toString(), 302);
  });

  // Token

  const tokErr = (c: Context, error: string, desc: string, status: 400 | 401 = 400): Response =>
    c.json({ error, error_description: desc }, status, noStore);

  const issueTokens = async (
    c: Context,
    r: { clientId: string; sub: string; householdId?: string; scope: string; resource: string; familyId?: string },
  ): Promise<Response> => {
    const access = await signAccess(
      key,
      { sub: r.sub, householdId: r.householdId, scope: r.scope, clientId: r.clientId },
      { issuer, audience: r.resource, nowMs: now(), ttlSec: TTL.accessSec, jti: token(random, 16) },
    );
    const body: Record<string, unknown> = {
      access_token: access,
      token_type: "Bearer",
      expires_in: TTL.accessSec,
      scope: r.scope,
    };
    // Every user access token comes with a refresh token (Alexa+ account linking page). Service tokens never do.
    if (r.familyId !== undefined && r.householdId !== undefined) {
      const rt = token(random);
      await store.putRefresh(await sha256b64url(rt), {
        clientId: r.clientId,
        resource: r.resource,
        scope: r.scope,
        sub: r.sub,
        householdId: r.householdId,
        familyId: r.familyId,
        expiresAt: now() + TTL.refreshMs,
      });
      body.refresh_token = rt;
    }
    return c.json(body, 200, noStore);
  };

  const readBasic = (header: string | undefined): { id: string; secret: string } | null | undefined => {
    if (header === undefined) return undefined;
    const m = /^Basic ([A-Za-z0-9+/]+=*)$/i.exec(header);
    if (!m?.[1]) return null;
    try {
      const raw = atob(m[1]);
      const i = raw.indexOf(":");
      if (i < 0) return null;
      return { id: decodeURIComponent(raw.slice(0, i)), secret: decodeURIComponent(raw.slice(i + 1)) };
    } catch {
      return null;
    }
  };

  app.post("/oauth/token", limit, async (c) => {
    const ct = c.req.header("content-type") ?? "";
    if (!ct.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
      return tokErr(c, "invalid_request", "content-type must be application/x-www-form-urlencoded");
    }
    const sp = new URLSearchParams(await c.req.text());
    const grant = single(sp, "grant_type");

    // Client authentication: Basic or body, not both.
    const basic = readBasic(c.req.header("authorization"));
    if (basic === null) return tokErr(c, "invalid_client", "bad Authorization header", 401);
    const bodyId = single(sp, "client_id");
    const bodySecret = single(sp, "client_secret");
    if (bodyId === null || bodySecret === null) return tokErr(c, "invalid_request", "duplicate parameter");
    if (basic && (bodyId !== undefined || bodySecret !== undefined)) {
      return tokErr(c, "invalid_request", "use one client authentication method");
    }
    const clientId = basic ? basic.id : bodyId;
    const clientSecret = basic ? basic.secret : bodySecret;
    if (!clientId) return tokErr(c, "invalid_client", "client_id required", 401);

    if (grant === "client_credentials") {
      const sc = opts.serviceClient;
      if (!sc || clientId !== sc.clientId || !clientSecret || !(await safeEqual(clientSecret, sc.clientSecret))) {
        return tokErr(c, "invalid_client", "client authentication failed", 401);
      }
      const res = single(sp, "resource");
      if (typeof res !== "string" || !resourceForms.includes(res)) {
        return tokErr(c, "invalid_target", "resource is required and must match");
      }
      const scope = single(sp, "scope");
      if (scope !== undefined && scope !== SCOPE_SERVICE) {
        return tokErr(c, "invalid_scope", "only mcp:service is available");
      }
      return issueTokens(c, { clientId, sub: `svc:${clientId}`, scope: SCOPE_SERVICE, resource });
    }

    const client = clients.get(clientId);
    if (!client) return tokErr(c, "invalid_client", "unknown client", 401);
    if (client.secret !== undefined && (!clientSecret || !(await safeEqual(clientSecret, client.secret)))) {
      return tokErr(c, "invalid_client", "client authentication failed", 401);
    }

    if (grant === "authorization_code") {
      const code = single(sp, "code");
      const redirectUri = single(sp, "redirect_uri");
      const verifier = single(sp, "code_verifier");
      const res = single(sp, "resource");
      if (typeof code !== "string" || code.length > 200) return tokErr(c, "invalid_request", "code required");
      if (typeof verifier !== "string" || !VERIFIER.test(verifier)) {
        return tokErr(c, "invalid_request", "code_verifier required");
      }
      if (typeof redirectUri !== "string") return tokErr(c, "invalid_request", "redirect_uri required");
      if (typeof res !== "string" || !resourceForms.includes(res)) {
        return tokErr(c, "invalid_target", "resource is required and must match");
      }

      const got = await store.consumeCode(await sha256b64url(code));
      if (got.status === "unknown") return tokErr(c, "invalid_grant", "invalid code");
      const rec = got.record;
      if (got.status === "used") {
        await store.revokeFamily(rec.familyId); // replay: kill anything already issued from this code
        return tokErr(c, "invalid_grant", "code already used");
      }
      if (rec.expiresAt <= now()) return tokErr(c, "invalid_grant", "code expired");
      if (rec.clientId !== client.clientId) return tokErr(c, "invalid_grant", "code was issued to another client");
      if (rec.redirectUri !== redirectUri) return tokErr(c, "invalid_grant", "redirect_uri mismatch");
      if (trimSlash(rec.resource) !== trimSlash(res)) return tokErr(c, "invalid_target", "resource mismatch");
      if (!(await safeEqual(await sha256b64url(verifier), rec.codeChallenge))) {
        return tokErr(c, "invalid_grant", "PKCE verification failed");
      }
      return issueTokens(c, { ...rec, resource: trimSlash(rec.resource) });
    }

    if (grant === "refresh_token") {
      const rt = single(sp, "refresh_token");
      if (typeof rt !== "string" || rt.length > 200) return tokErr(c, "invalid_request", "refresh_token required");
      const res = single(sp, "resource");
      const reqScope = single(sp, "scope");
      if (res === null || reqScope === null) return tokErr(c, "invalid_request", "duplicate parameter");
      const got = await store.consumeRefresh(await sha256b64url(rt));
      if (got.status === "unknown") return tokErr(c, "invalid_grant", "invalid refresh token");
      const rec = got.record;
      if (got.status === "used") {
        await store.revokeFamily(rec.familyId); // reuse detected
        return tokErr(c, "invalid_grant", "refresh token already used");
      }
      if (rec.expiresAt <= now()) return tokErr(c, "invalid_grant", "refresh token expired");
      if (rec.clientId !== client.clientId) {
        await store.revokeFamily(rec.familyId);
        return tokErr(c, "invalid_grant", "refresh token belongs to another client");
      }
      if (res !== undefined && trimSlash(res) !== trimSlash(rec.resource)) {
        return tokErr(c, "invalid_target", "resource mismatch");
      }
      let scope = rec.scope;
      if (reqScope !== undefined) {
        const have = new Set(rec.scope.split(" "));
        const want = reqScope.split(" ").filter(Boolean);
        if (want.length === 0 || want.some((s) => !have.has(s))) {
          return tokErr(c, "invalid_scope", "scope exceeds the grant");
        }
        scope = [...new Set(want)].join(" ");
      }
      return issueTokens(c, { ...rec, scope });
    }

    return tokErr(c, "unsupported_grant_type", "unsupported grant_type");
  });

  // Web sessions (cookie). JSON only, so a cross site form cannot reach them; Origin is checked when present.

  const jsonGuard = (c: Context): Response | null => {
    const ct = (c.req.header("content-type") ?? "").toLowerCase();
    if (!ct.startsWith("application/json")) return c.json({ error: "invalid_request" }, 415, noStore);
    const origin = c.req.header("origin");
    if (origin !== undefined && !origins.has(origin)) return c.json({ error: "forbidden_origin" }, 403, noStore);
    return null;
  };

  const readJson = async (c: Context): Promise<Record<string, unknown> | null> => {
    try {
      const v: unknown = JSON.parse(await c.req.text());
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };

  app.post("/oauth/magic-code", limit, async (c) => {
    const g = jsonGuard(c);
    if (g) return g;
    const email = normalizeEmail((await readJson(c))?.email);
    if (!email) return c.json({ error: "invalid_request" }, 400, noStore);
    const wait = await issueMagic(email);
    if (wait !== null) return limited(c, wait);
    return c.json({ ok: true }, 200, noStore); // same answer whether or not the address is known
  });

  app.post("/oauth/session", limit, async (c) => {
    const g = jsonGuard(c);
    if (g) return g;
    const body = await readJson(c);
    if (!body) return c.json({ error: "invalid_request" }, 400, noStore);
    let email: string | null = null;
    if (body.demo === true) {
      if (!opts.demoUser) return c.json({ error: "access_denied" }, 401, noStore);
      email = normalizeEmail(opts.demoUser.email);
    } else {
      const e = normalizeEmail(body.email);
      const r = e ? await checkMagic(e, body.code) : "bad";
      if (typeof r === "object") return limited(c, r.retryAfterSec);
      if (e && r === "ok") email = e;
    }
    if (!email) return c.json({ error: "access_denied" }, 401, noStore);
    return c.json(await startSession(c, email), 200, noStore);
  });

  app.get("/oauth/session", async (c) => {
    const s = await sessionFromId(getCookie(c, SESSION_COOKIE));
    if (!s) return unauthorized();
    return c.json({ email: s.email, householdId: s.householdId }, 200, noStore);
  });

  app.post("/oauth/logout", limit, async (c) => {
    const g = jsonGuard(c);
    if (g) return g;
    const sid = getCookie(c, SESSION_COOKIE);
    if (sid) await store.deleteSession(await sha256b64url(sid));
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure, httpOnly: true, sameSite: "Lax" });
    return c.json({ ok: true }, 200, noStore);
  });

  // Verification

  const verifyBearer: Auth["verifyBearer"] = async (header) => {
    const t = bearerToken(header);
    if (!t) return null;
    const v = await verifyAccess(key, t, { issuer, audiences: resourceForms, now: new Date(now()) });
    if (!v || v.householdId === undefined) return null;
    return { householdId: v.householdId, scope: v.scope };
  };

  return {
    app,
    verifyBearer,
    async verifyServiceBearer(header) {
      const t = bearerToken(header);
      if (!t) return false;
      const v = await verifyAccess(key, t, { issuer, audiences: resourceForms, now: new Date(now()) });
      return Boolean(v && v.householdId === undefined && v.scope === SCOPE_SERVICE);
    },
    verifyRequest: (req) => verifyBearer(req.headers.get("authorization") ?? undefined),
    async verifySession(cookieHeader) {
      if (!cookieHeader) return null;
      const m = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(cookieHeader);
      const s = await sessionFromId(m?.[1]);
      return s ? { email: s.email, householdId: s.householdId } : null;
    },
  };
}
