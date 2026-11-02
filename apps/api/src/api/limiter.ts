import { createMemoryStore, type AuthStore } from "@hippo/auth";
import type { Context } from "hono";
import { ApiError } from "./http";

/** Counts a hit on `key` and says whether it is within `max` per `windowMs`. A host swaps in a durable one. */
export type RateLimiter = (
  key: string,
  windowMs: number,
  max: number,
) => Promise<{ ok: true } | { ok: false; retryAfterSec: number }>;

/**
 * A limiter over any store with the auth store's atomic counter: the memory one here, the D1 one on Workers.
 * The retry wait is rounded up to whole seconds, at least 1.
 */
export function limiterFromStore(store: Pick<AuthStore, "tryHit">, now: () => number): RateLimiter {
  return async (key, windowMs, max) => {
    const r = await store.tryHit(key, windowMs, max, 0, now());
    return r.ok ? r : { ok: false, retryAfterSec: Math.max(1, Math.ceil(r.retryAfterMs / 1000)) };
  };
}

/** shortcut: memory only and one process, and keys are never evicted, so this is for tests and local runs. */
export const createMemoryLimiter = (now: () => number): RateLimiter => limiterFromStore(createMemoryStore(), now);

/** Throws the 429 every route uses, with the wait in Retry-After. */
export async function enforce(
  limiter: RateLimiter,
  key: string,
  windowMs: number,
  max: number,
  message: string,
): Promise<void> {
  const r = await limiter(key, windowMs, max);
  if (!r.ok) throw new ApiError(429, message, { "Retry-After": String(r.retryAfterSec) });
}

/**
 * The caller's address, for the coarse per-address limit. `header` is set only on a host whose proxy writes it and
 * strips any copy a client sent (cf-connecting-ip on Cloudflare). Never trust a header a client can set on its own.
 */
export function clientAddress(c: Context, header: string | undefined): string {
  const named = header ? c.req.header(header)?.trim() : undefined;
  if (named) return named.slice(0, 64);
  const socket = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket;
  return socket?.remoteAddress ?? "unknown";
}
