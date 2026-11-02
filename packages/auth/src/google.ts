import { SignJWT, createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { safeEqual, sha256b64url } from "./crypto";

// "Continue with Google": the pure parts. Google only tells us which email address the person controls, and everything
// after that is the existing sign in path. The endpoints and the ID token checks are the ones in docs/VERIFIED.md 10.9.
// Nothing here logs, and nothing here throws on bad input from Google: a refusal is a null.

export const GOOGLE = {
  auth: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  jwks: "https://www.googleapis.com/oauth2/v3/certs",
  issuers: ["https://accounts.google.com", "accounts.google.com"],
} as const;

export interface GoogleOptions {
  clientId: string;
  clientSecret: string;
  /** Test seams. A real run uses Google's own endpoints and keys. */
  endpoints?: { auth?: string; token?: string; jwksUri?: string };
  fetch?: typeof fetch;
  jwks?: JWTVerifyGetKey;
  /** How long Google's token endpoint gets. Default 5000. */
  timeoutMs?: number;
}

const enc = new TextEncoder();
const MAX_TOKEN_RESPONSE = 20_000;
const MAX_ID_TOKEN = 8_000;
const CLOCK_TOLERANCE_SEC = 30;

// What the pending cookie carries between our redirect to Google and Google's redirect back.
export interface Pending {
  /** `authorize`: finish an OAuth authorization of one of our clients. `session`: sign in to the web app. */
  mode: "authorize" | "session";
  /** The checked authorize parameters (mode authorize). */
  params?: Record<string, string>;
  /** Where to send the browser afterwards (mode session). */
  returnTo?: string;
  /** Google's `state`, `nonce` and our PKCE verifier for the code exchange. */
  gstate: string;
  nonce: string;
  verifier: string;
}

const PENDING_TYP = "hippo-google+jwt";
const PENDING_AUD = "hippo-google-pending";
const PENDING_TTL_SEC = 600;

/**
 * A key of its own, made from the signing key by HMAC with a fixed label, so a pending cookie can never be read as an
 * access token or the other way round, even though both start from one secret.
 */
export async function derivePendingKey(signingKey: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(signingKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode("hippo google pending v1")));
}

export async function signPending(key: Uint8Array, p: Pending, nowMs: number): Promise<string> {
  const iat = Math.floor(nowMs / 1000);
  return new SignJWT({ m: p.mode, p: p.params, r: p.returnTo, s: p.gstate, n: p.nonce, v: p.verifier })
    .setProtectedHeader({ alg: "HS256", typ: PENDING_TYP })
    .setAudience(PENDING_AUD)
    .setIssuedAt(iat)
    .setExpirationTime(iat + PENDING_TTL_SEC)
    .sign(key);
}

export async function readPending(key: Uint8Array, jwt: string | undefined, nowMs: number): Promise<Pending | null> {
  if (!jwt || jwt.length > 4096) return null;
  try {
    const { payload } = await jwtVerify(jwt, key, {
      algorithms: ["HS256"],
      typ: PENDING_TYP,
      audience: PENDING_AUD,
      currentDate: new Date(nowMs),
      requiredClaims: ["exp", "iat", "s", "n", "v", "m"],
    });
    const { m, p, r, s, n, v } = payload as Record<string, unknown>;
    if ((m !== "authorize" && m !== "session") || typeof s !== "string" || typeof n !== "string") return null;
    if (typeof v !== "string") return null;
    if (p !== undefined && (typeof p !== "object" || p === null)) return null;
    if (r !== undefined && typeof r !== "string") return null;
    return {
      mode: m,
      ...(p ? { params: p as Record<string, string> } : {}),
      ...(r ? { returnTo: r } : {}),
      gstate: s,
      nonce: n,
      verifier: v,
    };
  } catch {
    return null;
  }
}

/** The address of Google's sign in page for this attempt. `scope` is `openid email`, the least that names the person. */
export async function googleAuthUrl(
  o: GoogleOptions,
  a: { redirectUri: string; gstate: string; nonce: string; verifier: string },
): Promise<string> {
  const u = new URL(o.endpoints?.auth ?? GOOGLE.auth);
  u.searchParams.set("client_id", o.clientId);
  u.searchParams.set("redirect_uri", a.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email");
  u.searchParams.set("state", a.gstate);
  u.searchParams.set("nonce", a.nonce);
  u.searchParams.set("code_challenge", await sha256b64url(a.verifier));
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

/**
 * Trades the code for an ID token. The client secret, the PKCE verifier and the redirect address all go together:
 * Google's documents for web clients do not settle whether PKCE is accepted, and the secret is required (VERIFIED 10.9).
 * Returns null for anything unexpected, with nothing about why: the reason could hold a secret.
 */
export async function exchangeCode(
  o: GoogleOptions,
  a: { code: string; redirectUri: string; verifier: string },
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? 5000);
  try {
    const res = await (o.fetch ?? fetch)(o.endpoints?.token ?? GOOGLE.token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: a.code,
        client_id: o.clientId,
        client_secret: o.clientSecret,
        redirect_uri: a.redirectUri,
        code_verifier: a.verifier,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length > MAX_TOKEN_RESPONSE) return null;
    const idToken = (JSON.parse(text) as { id_token?: unknown }).id_token;
    return typeof idToken === "string" && idToken.length > 0 && idToken.length <= MAX_ID_TOKEN ? idToken : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Builds the check of Google's signing keys once, so the keys are cached for the life of the process. */
export function googleKeys(o: GoogleOptions): JWTVerifyGetKey {
  return o.jwks ?? createRemoteJWKSet(new URL(o.endpoints?.jwksUri ?? GOOGLE.jwks));
}

/**
 * The checks on an ID token: signature (RS256 only, against Google's keys), issuer, audience (our client id), expiry,
 * and the two Google's own page does not list but we must make: our `nonce`, and `email_verified` exactly true.
 * Returns the stable Google id and the email as Google wrote it (the caller normalises it), or null.
 */
export async function verifyIdToken(
  o: GoogleOptions,
  keys: JWTVerifyGetKey,
  idToken: string,
  expected: { nonce: string; nowMs: number },
): Promise<{ sub: string; email: string } | null> {
  try {
    const { payload } = await jwtVerify(idToken, keys, {
      algorithms: ["RS256"],
      issuer: [...GOOGLE.issuers],
      audience: o.clientId,
      clockTolerance: CLOCK_TOLERANCE_SEC,
      currentDate: new Date(expected.nowMs),
      requiredClaims: ["sub", "exp", "iat", "email", "nonce"],
    });
    if (typeof payload.nonce !== "string" || !(await safeEqual(payload.nonce, expected.nonce))) return null;
    if (payload.email_verified !== true) return null;
    if (typeof payload.sub !== "string" || typeof payload.email !== "string") return null;
    return { sub: payload.sub, email: payload.email };
  } catch {
    return null;
  }
}

/**
 * Where the browser may be sent after a web sign in: a path on our own address, or a full address whose origin is
 * exactly one of the configured web origins. Anything else is null, and the caller falls back to the web app's home.
 */
export function safeReturnTo(
  raw: string | null | undefined,
  ownOrigin: string,
  allowed: ReadonlySet<string>,
): string | null {
  if (!raw || raw.length > 2048 || /[\\\u0000-\u001f]/.test(raw)) return null;
  if (raw.startsWith("//")) return null;
  try {
    const u = new URL(raw, ownOrigin);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.username || u.password) return null;
    if (u.origin !== ownOrigin && !allowed.has(u.origin)) return null;
    return u.origin + u.pathname + u.search;
  } catch {
    return null;
  }
}
