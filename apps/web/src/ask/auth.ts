// OAuth 2.1 authorization code with PKCE S256 against our own server (same origin through the dev proxy).
// The verifier and state live in sessionStorage only across the redirect. Tokens live in this module's memory only.
import { askConfig } from "./config";
import { challengeFor, makeState, makeVerifier, stateMatches } from "./pkce";
import { SessionEndedError } from "./types";

const cfg = askConfig(import.meta.env, window.location.origin);
export const CLIENT_ID = cfg.clientId;
export const REDIRECT_URI = cfg.redirectUri;
export const RESOURCE = cfg.resource;
export const SCOPE = "mcp:tools";
const KEY = "hippo-ask-pkce";

interface Tokens {
  access: string;
  refresh: string | null;
  expiresAt: number;
}
let tokens: Tokens | null = null;

interface Deps {
  fetch?: typeof fetch;
}
const f = (d?: Deps): typeof fetch => d?.fetch ?? ((...a) => fetch(...a));

export const hasSession = (): boolean => tokens !== null;
export function signOut(): void {
  tokens = null;
}

function store(body: Record<string, unknown>): void {
  if (typeof body.access_token !== "string") throw new Error("The server did not return a token.");
  tokens = {
    access: body.access_token,
    refresh: typeof body.refresh_token === "string" ? body.refresh_token : null,
    expiresAt: Date.now() + Number(body.expires_in ?? 900) * 1000,
  };
}

async function tokenRequest(params: Record<string, string>, d?: Deps): Promise<void> {
  const res = await f(d)("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, client_id: CLIENT_ID, resource: RESOURCE }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status !== 200) throw new Error(`The sign-in server refused the request (${res.status}).`);
  store(body);
}

/** Step 2: trade the code for tokens. `search` is the query string of the redirect. */
export async function completeExchange(search: string, d?: Deps): Promise<void> {
  const q = new URLSearchParams(search);
  let saved: { verifier?: string; state?: string } = {};
  try {
    saved = JSON.parse(sessionStorage.getItem(KEY) ?? "{}");
  } catch {
    saved = {};
  }
  sessionStorage.removeItem(KEY);
  if (q.get("error")) throw new Error("Sign-in was not completed.");
  if (!saved.verifier || !stateMatches(saved.state, q.get("state"))) {
    throw new Error("The sign-in answer did not match this tab (state check failed). Please sign in again.");
  }
  const code = q.get("code");
  if (!code) throw new Error("The sign-in answer had no code.");
  await tokenRequest(
    { grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: saved.verifier },
    d,
  );
}

const hidden = (html: string, name: string): string =>
  new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? "";

/**
 * Step 1 for the demo account: open the login page, press "Use the demo household" and read the code from the
 * redirect. fetch follows the redirect to our own /callback page, whose final URL carries code and state.
 */
export async function signInDemo(d?: Deps): Promise<void> {
  const verifier = makeVerifier();
  const state = makeState();
  sessionStorage.setItem(KEY, JSON.stringify({ verifier, state }));
  try {
    const params: Record<string, string> = {
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: SCOPE,
      state,
      code_challenge: await challengeFor(verifier),
      code_challenge_method: "S256",
      resource: RESOURCE,
    };
    const page = await f(d)(`/oauth/authorize?${new URLSearchParams(params)}`);
    if (page.status !== 200) throw new Error(`The sign-in page returned ${page.status}.`);
    const csrf = hidden(await page.text(), "csrf");
    const res = await f(d)("/oauth/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...params, csrf, action: "demo" }),
    });
    const final = new URL(res.url, window.location.origin);
    if (!final.searchParams.get("code"))
      throw new Error("The demo sign-in was refused. Is the demo account turned on?");
    await completeExchange(final.search, d);
  } catch (e) {
    // Whatever went wrong, the verifier and state of this attempt must not stay in the tab.
    sessionStorage.removeItem(KEY);
    throw e;
  }
}

// One refresh at a time. The refresh token rotates, and the server revokes the whole family when an old one is shown
// again, so two callers must never present the same token: they share this promise instead.
let inflight: Promise<void> | null = null;

function refresh(d?: Deps): Promise<void> {
  if (inflight) return inflight;
  const rt = tokens?.refresh;
  if (!rt) return Promise.reject(new SessionEndedError());
  inflight = (async () => {
    try {
      await tokenRequest({ grant_type: "refresh_token", refresh_token: rt }, d);
    } catch {
      tokens = null;
      throw new SessionEndedError();
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** The current access token, refreshed first when it has under 30 seconds left. */
export async function getAccessToken(d?: Deps): Promise<string> {
  if (!tokens) throw new SessionEndedError();
  if (tokens.expiresAt - Date.now() < 30_000) await refresh(d);
  return tokens!.access;
}

export async function forceRefresh(d?: Deps): Promise<void> {
  await refresh(d);
}
