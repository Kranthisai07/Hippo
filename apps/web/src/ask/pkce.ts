// PKCE (RFC 7636) with WebCrypto. Nothing here touches storage.

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export const randomToken = (bytes: number): string => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

/** 32 random bytes give a 43 character verifier, the minimum RFC 7636 allows. */
export const makeVerifier = (): string => randomToken(32);
export const makeState = (): string => randomToken(16);

export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

/** Exact comparison. A missing or empty value never matches, so a callback without state is refused. */
export function stateMatches(expected: string | null | undefined, got: string | null | undefined): boolean {
  if (!expected || !got || expected.length !== got.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}
