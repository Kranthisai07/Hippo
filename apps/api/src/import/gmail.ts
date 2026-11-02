// Reads a mailbox for the one time import. Plain `fetch` only, so it runs on Workers and in tests against a fake Gmail.
// The access token goes in the Authorization header and nowhere else: it is not logged, not put in an address, and an
// error carries the HTTP status only (a response body could hold an address or part of a message). What the API returns
// is untrusted text, parsed here and never followed as an instruction.
// Endpoints and fields are the ones in docs/VERIFIED.md 10.24.

export const GMAIL_BASE = "https://gmail.googleapis.com";
export const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

/** Mail that looks like a receipt, a trial, a renewal or a billing notice, from the last two years. */
export const SUBSCRIPTION_QUERY =
  'newer_than:2y (subject:(receipt OR invoice OR subscription OR renewal OR renews OR trial OR billing OR "your plan" OR payment) OR "free trial" OR "will renew" OR "auto-renew" OR "next billing")';

/** Mail with a PDF that looks like a lease, a warranty, a manual or a policy. Only listed, never read (phase two). */
export const DOCUMENT_QUERY =
  "newer_than:5y has:attachment filename:pdf (lease OR rental OR warranty OR manual OR policy OR agreement OR insurance)";

export class GmailError extends Error {
  constructor(public readonly status: number) {
    super(`gmail request failed (${status})`);
    this.name = "GmailError";
  }
}

export interface GmailOptions {
  fetch?: typeof fetch;
  /** Test seams. A real run uses Google's own addresses. */
  base?: string;
  revokeUrl?: string;
  /** How long one request gets. Default 10000. */
  timeoutMs?: number;
  /** Waits before the one retry of a 429 or 5xx. Default a real second. */
  sleep?: (ms: number) => Promise<void>;
}

export interface MailMessage {
  id: string;
  /** The sender's address only, lower case. */
  from: string;
  subject: string;
  /** The Date header as Google sent it, or "". */
  date: string;
  /** Plain text of the body: text/plain parts first, else the text of the html parts. */
  text: string;
  attachments: { filename: string; mimeType: string }[];
}

interface Part {
  mimeType?: string;
  filename?: string;
  headers?: { name?: string; value?: string }[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: Part[];
}

const MAX_PARTS = 200;
const MAX_DEPTH = 8;
const MAX_BODY_CHARS = 200_000;
const MAX_HEADER = 500;

/** Base64url (what Gmail sends) to text. Bad input gives "" and never throws. */
export function decodeBase64Url(data: string | undefined): string {
  if (!data || data.length > 4_000_000) return "";
  try {
    const bin = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
    return new TextDecoder("utf-8", { fatal: false }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return "";
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "-",
  mdash: "-",
};

/** The visible text of an html body. No script, style or head, no tag, no remote load, entities decoded, spaces collapsed. */
export function htmlToText(html: string): string {
  return html
    .slice(0, MAX_BODY_CHARS * 2)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|head|title|noscript|svg)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<\/?(br|p|div|tr|li|h[1-6]|table|ul|ol|section|article|blockquote)\b[^>]*>/gi, "\n")
    .replace(/<\/t[dh]\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const n = e[1]!.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " ";
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[​-‏⁠﻿]/g, "")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** RFC 2047 encoded words (=?UTF-8?B?...?= and =?UTF-8?Q?...?=) in a header, in case the API leaves them encoded. */
export function decodeHeader(value: string): string {
  return value
    .slice(0, MAX_HEADER)
    .replace(/=\?([\w-]+)\?([bq])\?([^?]*)\?=/gi, (_m, charset: string, enc: string, body: string) => {
      try {
        const bytes =
          enc.toLowerCase() === "b"
            ? Uint8Array.from(atob(body), (c) => c.charCodeAt(0))
            : Uint8Array.from(
                body
                  .replace(/_/g, " ")
                  .replace(/=([0-9a-f]{2})/gi, (_x, h: string) => String.fromCharCode(parseInt(h, 16))),
                (c) => c.charCodeAt(0),
              );
        return new TextDecoder(charset.toLowerCase() === "utf-8" ? "utf-8" : "windows-1252", { fatal: false }).decode(
          bytes,
        );
      } catch {
        return "";
      }
    })
    .replace(/[\r\n]+/g, " ")
    .trim();
}

const header = (p: Part, name: string): string => {
  const found = (Array.isArray(p.headers) ? p.headers : []).find(
    (h) => typeof h?.name === "string" && h.name.toLowerCase() === name.toLowerCase(),
  );
  return typeof found?.value === "string" ? found.value : "";
};

/** The address inside `Name <addr@example.com>`, lower case, or "" when there is none. */
export function senderAddress(from: string): string {
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(from) ?? /([^\s<>,;"]+@[^\s<>,;"]+)/.exec(from);
  return (m?.[1] ?? "").toLowerCase().slice(0, 254);
}

/** Turns a Gmail message (`format=full`) into what the import needs. Never throws on odd input. */
export function parseMessage(id: string, payload: unknown): MailMessage {
  const root = (payload && typeof payload === "object" ? payload : {}) as Part;
  const plain: string[] = [];
  const html: string[] = [];
  const attachments: MailMessage["attachments"] = [];
  let seen = 0;
  const walk = (p: Part, depth: number) => {
    if (!p || typeof p !== "object" || ++seen > MAX_PARTS || depth > MAX_DEPTH) return;
    const type = (p.mimeType ?? "").toLowerCase();
    if (p.filename) {
      // An attachment is only noted. Its bytes are never fetched.
      attachments.push({ filename: String(p.filename).slice(0, 200), mimeType: type.slice(0, 100) });
    } else if (type === "text/plain") {
      plain.push(decodeBase64Url(p.body?.data));
    } else if (type === "text/html") {
      html.push(decodeBase64Url(p.body?.data));
    }
    for (const child of Array.isArray(p.parts) ? p.parts : []) walk(child, depth + 1);
  };
  walk(root, 0);
  const text = (plain.join("\n").trim() || htmlToText(html.join("\n"))).slice(0, MAX_BODY_CHARS);
  return {
    id,
    from: senderAddress(decodeHeader(header(root, "From"))),
    subject: decodeHeader(header(root, "Subject")),
    date: header(root, "Date").slice(0, 100),
    text,
    attachments,
  };
}

export interface GmailClient {
  /** Message ids matching a Gmail search, newest first, at most `max`. */
  listIds(token: string, q: string, max: number): Promise<string[]>;
  getMessage(token: string, id: string): Promise<MailMessage>;
  /** Ends the grant at Google. Never throws: a failure is reported as false. */
  revoke(token: string): Promise<boolean>;
}

export function createGmailClient(o: GmailOptions = {}): GmailClient {
  const doFetch = o.fetch ?? fetch;
  const base = (o.base ?? GMAIL_BASE).replace(/\/$/, "");
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function call(url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? 10_000);
      try {
        const res = await doFetch(url, { ...init, signal: controller.signal });
        if ((res.status === 429 || res.status >= 500) && attempt === 0) {
          await sleep(1000);
          continue;
        }
        return res;
      } catch (e) {
        if (attempt === 0) {
          await sleep(1000);
          continue;
        }
        throw e instanceof Error && e.name === "AbortError" ? new GmailError(504) : new GmailError(502);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  return {
    async listIds(token, q, max) {
      const ids: string[] = [];
      let page: string | undefined;
      while (ids.length < max) {
        const u = new URL(`${base}/gmail/v1/users/me/messages`);
        u.searchParams.set("q", q);
        u.searchParams.set("maxResults", String(Math.min(500, max - ids.length)));
        if (page) u.searchParams.set("pageToken", page);
        const res = await call(u.toString(), { headers: auth(token) });
        if (!res.ok) throw new GmailError(res.status);
        const body = (await res.json().catch(() => ({}))) as { messages?: { id?: unknown }[]; nextPageToken?: unknown };
        for (const m of Array.isArray(body.messages) ? body.messages : []) {
          if (typeof m?.id === "string" && /^[\w-]{1,64}$/.test(m.id)) ids.push(m.id);
        }
        page = typeof body.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken : undefined;
        if (!page) break;
      }
      return ids.slice(0, max);
    },
    async getMessage(token, id) {
      if (!/^[\w-]{1,64}$/.test(id)) throw new GmailError(400);
      const u = new URL(`${base}/gmail/v1/users/me/messages/${encodeURIComponent(id)}`);
      u.searchParams.set("format", "full");
      const res = await call(u.toString(), { headers: auth(token) });
      if (!res.ok) throw new GmailError(res.status);
      const body = (await res.json().catch(() => ({}))) as { payload?: unknown };
      return parseMessage(id, body.payload);
    },
    async revoke(token) {
      try {
        const res = await doFetch(o.revokeUrl ?? REVOKE_URL, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token }),
          signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}
