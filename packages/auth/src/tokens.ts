import { SignJWT, jwtVerify } from "jose";

export const ACCESS_TYP = "at+jwt";

export interface AccessClaims {
  sub: string;
  householdId?: string;
  scope: string;
  clientId: string;
}

export function keyBytes(key: string | Uint8Array): Uint8Array {
  const k = typeof key === "string" ? new TextEncoder().encode(key) : key;
  if (k.length < 32) throw new Error("signingKey must be at least 32 bytes");
  return k;
}

export async function signAccess(
  key: Uint8Array,
  c: AccessClaims,
  o: { issuer: string; audience: string; nowMs: number; ttlSec: number; jti: string },
): Promise<string> {
  const iat = Math.floor(o.nowMs / 1000);
  const payload: Record<string, unknown> = { scope: c.scope, client_id: c.clientId };
  if (c.householdId !== undefined) payload.householdId = c.householdId;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", typ: ACCESS_TYP })
    .setSubject(c.sub)
    .setIssuer(o.issuer)
    .setAudience(o.audience)
    .setIssuedAt(iat)
    .setExpirationTime(iat + o.ttlSec)
    .setJti(o.jti)
    .sign(key);
}

export interface VerifiedAccess {
  sub: string;
  householdId?: string;
  scope: string;
}

export async function verifyAccess(
  key: Uint8Array,
  jwt: string,
  o: { issuer: string; audiences: string[]; now: Date },
): Promise<VerifiedAccess | null> {
  try {
    const { payload } = await jwtVerify(jwt, key, {
      algorithms: ["HS256"],
      issuer: o.issuer,
      audience: o.audiences,
      typ: ACCESS_TYP,
      currentDate: o.now,
      requiredClaims: ["sub", "exp", "iat", "jti"],
    });
    if (typeof payload.scope !== "string" || typeof payload.sub !== "string") return null;
    // jose checks exp and nbf but not iat; a token from the future is not one we issued.
    if (typeof payload.iat !== "number" || payload.iat * 1000 > o.now.getTime() + 60_000) return null;
    const h = payload.householdId;
    if (h !== undefined && (typeof h !== "string" || h === "")) return null;
    return h === undefined
      ? { sub: payload.sub, scope: payload.scope }
      : { sub: payload.sub, householdId: h, scope: payload.scope };
  } catch {
    return null;
  }
}
