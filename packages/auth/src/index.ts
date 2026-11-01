import type { Hono } from "hono";
import { createAuth, type Auth, type AuthOptions } from "./auth";

export { createAuth, unauthorized, MAIL_TIMEOUT_MS, SCOPE_SERVICE, USER_SCOPES, TTL } from "./auth";
export type { Auth, AuditEvent, AuthOptions, ClientConfig } from "./auth";
export type { Mailer } from "./mailer";
export type { GoogleOptions } from "./google";
export { linksFromEnv } from "./pages";
export type { PageLinks } from "./pages";
export { createMemoryStore } from "./store";
export type { AuthStore, CodeRecord, RefreshRecord, SessionRecord, MagicRecord } from "./store";

let current: Auth | undefined;

/** Builds the auth instance, registers it for the module level verify functions, and returns the Hono app to mount. */
export function createAuthApp(opts: AuthOptions): Hono {
  current = createAuth(opts);
  return current.app;
}

/** Null for anything invalid, and also before createAuthApp has run. Header value only, never a query string. */
export async function verifyBearer(
  authorizationHeader: string | undefined,
): Promise<{ householdId: string; scope: string } | null> {
  return current ? current.verifyBearer(authorizationHeader) : null;
}

/** True only for a valid client_credentials token. Such a token must never reach user data. */
export async function verifyServiceBearer(authorizationHeader: string | undefined): Promise<boolean> {
  return current ? current.verifyServiceBearer(authorizationHeader) : false;
}

/** Reads only the Authorization header of the request. */
export async function verifyRequest(req: Request): Promise<{ householdId: string; scope: string } | null> {
  return current ? current.verifyRequest(req) : null;
}

/** Resolves the web session cookie from a Cookie header value. */
export async function verifySession(
  cookieHeader: string | undefined,
): Promise<{ email: string; householdId: string } | null> {
  return current ? current.verifySession(cookieHeader) : null;
}
