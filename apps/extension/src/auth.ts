// OAuth 2.1 with PKCE through chrome.identity. This runs in the service worker, because a popup closes as soon as the
// sign-in window takes focus and would lose the answer. Tokens live in storage.session: memory only, gone with the browser.
import { challengeFor, makeState, makeVerifier, stateMatches } from "../../web/src/ask/pkce";
import { API_ORIGIN, CLIENT_ID, RESOURCE, SCOPE } from "./config";

const KEY = "hippo-tokens";

interface Tokens {
  access: string;
  refresh: string | null;
  expiresAt: number;
}

async function load(): Promise<Tokens | null> {
  const got = await chrome.storage.session.get(KEY);
  return (got[KEY] as Tokens | undefined) ?? null;
}

/** The server said no, as opposed to the network failing. Only this ends a sign-in. */
class Refused extends Error {}

async function tokenRequest(params: Record<string, string>): Promise<void> {
  const res = await fetch(`${API_ORIGIN}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, client_id: CLIENT_ID, resource: RESOURCE }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status !== 200 && res.status !== 400 && res.status !== 401) {
    throw new Error("Hippo is not answering right now. Please try again.");
  }
  if (res.status !== 200 || typeof body.access_token !== "string") {
    throw new Refused("Hippo refused the sign-in. Please try again.");
  }
  const tokens: Tokens = {
    access: body.access_token,
    refresh: typeof body.refresh_token === "string" ? body.refresh_token : null,
    expiresAt: Date.now() + Number(body.expires_in ?? 900) * 1000,
  };
  await chrome.storage.session.set({ [KEY]: tokens });
}

export async function signIn(): Promise<void> {
  const verifier = makeVerifier();
  const state = makeState();
  const redirectUri = chrome.identity.getRedirectURL();
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    state,
    code_challenge: await challengeFor(verifier),
    code_challenge_method: "S256",
    resource: RESOURCE,
  });
  const answer = await chrome.identity.launchWebAuthFlow({
    url: `${API_ORIGIN}/oauth/authorize?${params}`,
    interactive: true,
  });
  const q = new URL(answer ?? redirectUri).searchParams;
  if (!stateMatches(state, q.get("state"))) throw new Error("The sign-in answer did not match. Please sign in again.");
  const code = q.get("code");
  if (!code) throw new Error("Sign-in was not completed.");
  await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier });
}

const clear = (): Promise<void> => chrome.storage.session.remove(KEY);

/** The person pressed Sign out: end the refresh token on the server too, so a copy of it is worth nothing. */
export async function signOut(): Promise<void> {
  const tokens = await load();
  if (tokens?.refresh) {
    // Best effort. A server that does not answer must not keep the person signed in on this browser.
    await fetch(`${API_ORIGIN}/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: tokens.refresh, client_id: CLIENT_ID }),
    }).catch(() => undefined);
  }
  await clear();
}

export const isSignedIn = async (): Promise<boolean> => (await load()) !== null;

// One refresh at a time. The refresh token rotates, and the server revokes the whole family when an old one is shown
// again, so two callers must never present the same token: they share this promise instead.
let inflight: Promise<void> | null = null;

function refresh(rt: string): Promise<void> {
  inflight ??= tokenRequest({ grant_type: "refresh_token", refresh_token: rt })
    .catch(async (e: unknown) => {
      if (e instanceof Refused) await clear();
      throw e;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** The access token, refreshed first when it has under 30 seconds left. Null means sign in again. */
export async function accessToken(): Promise<string | null> {
  if (inflight) await inflight.catch(() => undefined);
  const tokens = await load();
  if (!tokens) return null;
  if (tokens.expiresAt - Date.now() >= 30_000) return tokens.access;
  if (!tokens.refresh) {
    await clear();
    return null;
  }
  await refresh(tokens.refresh).catch(() => undefined);
  return (await load())?.access ?? null;
}
