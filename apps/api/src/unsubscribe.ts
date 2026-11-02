import { esc, page, type PageLinks } from "@hippo/auth";
import type { Repository } from "core/src/contracts";
import { Hono } from "hono";

// The "turn off this email" link in the daily digest. It works without signing in, because the person is reading an email,
// so the link carries a signed token: the household id and an expiry, signed with a key derived from the server's signing
// key under its own label (a token for this can never be read as an access token, or the other way round).
// Opening the link only shows a confirm page. The change is made by the POST, because mail scanners and link previews
// open links and must not turn anyone's email off. Turning it off twice is harmless, so there is nothing to replay.

const TTL_MS = 90 * 24 * 3600_000;
const enc = new TextEncoder();
const MAX_TOKEN = 600;
const MAX_BODY = 2 * 1024;

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const unb64url = (s: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function macKey(signingKey: string): Promise<CryptoKey> {
  const root = await crypto.subtle.importKey("raw", enc.encode(signingKey), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const derived = await crypto.subtle.sign("HMAC", root, enc.encode("hippo digest unsubscribe v1"));
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export interface Unsubscribe {
  /** The routes, mounted at /unsubscribe. */
  app: Hono;
  /** A fresh link for one household, on the given public address. */
  link(origin: string, householdId: string): Promise<string>;
}

export function createUnsubscribe(deps: {
  signingKey: string;
  repo: Repository;
  now: () => number;
  links?: PageLinks;
}): Unsubscribe {
  const key = macKey(deps.signingKey);

  const sign = async (householdId: string): Promise<string> => {
    const body = b64url(enc.encode(JSON.stringify({ h: householdId, e: deps.now() + TTL_MS })));
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await key, enc.encode(body)));
    return `${body}.${b64url(mac)}`;
  };

  /** The household id, or null for a token that is malformed, forged or past its time. */
  const read = async (token: string | null | undefined): Promise<string | null> => {
    if (!token || token.length > MAX_TOKEN) return null;
    const [body, mac, extra] = token.split(".");
    if (!body || !mac || extra !== undefined) return null;
    try {
      if (!(await crypto.subtle.verify("HMAC", await key, unb64url(mac), enc.encode(body)))) return null;
      const p = JSON.parse(new TextDecoder().decode(unb64url(body))) as { h?: unknown; e?: unknown };
      if (typeof p.h !== "string" || p.h === "" || typeof p.e !== "number" || p.e <= deps.now()) return null;
      return p.h;
    } catch {
      return null;
    }
  };

  const app = new Hono();
  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
    c.header(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; font-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
  });

  const card = (title: string, body: string, status: 200 | 400 = 200) =>
    new Response(
      page(
        title,
        `<main class="shell single"><section class="main"><div><h1>${esc(title)}</h1>${body}</div></section></main>`,
        deps.links,
      ),
      { status, headers: { "Content-Type": "text/html; charset=UTF-8" } },
    );
  const invalid = () =>
    card(
      "This link no longer works",
      `<p class="sub">It has expired or is not valid. Open Hippo, go to Settings and turn the daily email off there.</p>`,
      400,
    );

  app.get("/", async (c) => {
    const t = c.req.query("t");
    if (!(await read(t))) return invalid();
    return card(
      "Turn off the daily email?",
      `<p class="sub">Hippo will stop sending you the daily email about what is due. You can turn it back on in Settings.</p><form method="post" action="/unsubscribe" style="margin-top:20px"><input type="hidden" name="t" value="${esc(t!)}"><button class="btn btn-primary" type="submit">Turn it off</button></form>`,
    );
  });

  app.post("/", async (c) => {
    const type = (c.req.header("content-type") ?? "").toLowerCase();
    if (!type.startsWith("application/x-www-form-urlencoded")) return invalid();
    const text = await c.req.text();
    if (text.length > MAX_BODY) return invalid();
    const hh = await read(new URLSearchParams(text).get("t"));
    if (!hh) return invalid();
    const household = await deps.repo.getHousehold(hh);
    // A household with no record has no daily email to turn off, so the answer is the same.
    if (household && household.digestOn) await deps.repo.putHousehold(hh, { ...household, digestOn: false });
    return card(
      "The daily email is off",
      `<p class="sub">You will not get it any more. You can turn it back on in Settings in Hippo.</p>`,
    );
  });

  return {
    app,
    async link(origin, householdId) {
      return `${origin.replace(/\/$/, "")}/unsubscribe?t=${await sign(householdId)}`;
    },
  };
}
