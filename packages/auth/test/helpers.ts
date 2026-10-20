import { createAuth, type Auth, type AuthOptions } from "../src";

export const ISSUER = "https://api.hippo.test";
export const RESOURCE = "https://api.hippo.test/mcp";
export const REDIRECT = "https://alexa.example/auth/callback";
export const KEY = "test-signing-key-test-signing-key-0123456789";
export const START = Date.UTC(2026, 9, 18, 12, 0, 0);

export interface Env {
  auth: Auth;
  logs: string[];
  clock: { t: number };
  req: (path: string, init?: RequestInit) => Promise<Response>;
}

export function makeEnv(over: Partial<AuthOptions> = {}): Env {
  const logs: string[] = [];
  const clock = { t: START };
  const auth = createAuth({
    issuer: ISSUER,
    resource: RESOURCE,
    signingKey: KEY,
    clients: [{ clientId: "alexa", redirectUris: [REDIRECT, "https://alexa.example/other"] }],
    resolveHousehold: (email) => `hh_${email.split("@")[0]}`,
    log: (l) => logs.push(l),
    demoUser: { email: "demo@hippo.test", code: "424242" },
    serviceClient: { clientId: "alexa-svc", clientSecret: "svc-secret-value" },
    now: () => clock.t,
    ...over,
  });
  return { auth, logs, clock, req: (p, init) => Promise.resolve(auth.app.request(ISSUER + p, init)) };
}

export function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

export type Params = Record<string, string | undefined>;

export function authzParams(challenge: string, over: Params = {}): Params {
  return {
    client_id: "alexa",
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: "mcp:tools",
    state: "st-123",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
    ...over,
  };
}

export function qs(p: Params): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined) sp.set(k, v);
  return sp.toString();
}

export function cookiesOf(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const i = pair!.indexOf("=");
    out[pair!.slice(0, i)] = pair!.slice(i + 1);
  }
  return out;
}

export const cookieHeader = (c: Record<string, string>): string =>
  Object.entries(c)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

export function hiddenValue(html: string, name: string): string {
  const m = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  return m ? m[1]! : "";
}

export const form = (p: Params): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: qs(p),
});

export interface Page {
  csrf: string;
  cookies: Record<string, string>;
  html: string;
  res: Response;
}

export async function openAuthorize(env: Env, p: Params): Promise<Page> {
  const res = await env.req("/oauth/authorize?" + qs(p));
  const html = await res.text();
  return { csrf: hiddenValue(html, "csrf"), cookies: cookiesOf(res), html, res };
}

export function postAuthorize(env: Env, page: Page, p: Params, extra: Params = {}): Promise<Response> {
  const body = qs({ ...p, csrf: page.csrf, ...extra });
  return env.req("/oauth/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieHeader(page.cookies) },
    body,
  });
}

export function lastMagic(env: Env): string {
  const m = /: (\d{6})$/.exec(env.logs[env.logs.length - 1] ?? "");
  if (!m) throw new Error("no magic code logged");
  return m[1]!;
}

/** Runs authorize with the demo button and returns the code and state from the redirect. */
export async function getCode(env: Env, p: Params): Promise<{ code: string; state: string | null; res: Response }> {
  const page = await openAuthorize(env, p);
  const res = await postAuthorize(env, page, p, { action: "demo" });
  const loc = res.headers.get("location");
  const u = loc ? new URL(loc) : null;
  return { code: u?.searchParams.get("code") ?? "", state: u?.searchParams.get("state") ?? null, res };
}

export function tokenReq(env: Env, p: Params, headers: Record<string, string> = {}): Promise<Response> {
  const init = form(p);
  return env.req("/oauth/token", { ...init, headers: { ...(init.headers as Record<string, string>), ...headers } });
}

export function codeGrant(code: string, verifier: string, over: Params = {}): Params {
  return {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: "alexa",
    code_verifier: verifier,
    resource: RESOURCE,
    ...over,
  };
}

export async function fullTokens(env: Env, over: Params = {}) {
  const { verifier, challenge } = await pkce();
  const { code } = await getCode(env, authzParams(challenge, over));
  const res = await tokenReq(env, codeGrant(code, verifier));
  const body = (await res.json()) as Record<string, string>;
  return { body, verifier, challenge, code, res };
}

export const bearer = (t: string): string => `Bearer ${t}`;

export const refreshGrant = (rt: string, over: Params = {}): Params => ({
  grant_type: "refresh_token",
  refresh_token: rt,
  client_id: "alexa",
  ...over,
});
