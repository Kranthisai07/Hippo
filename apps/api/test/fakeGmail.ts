// A fake Gmail and a fake revoke endpoint for the import tests: no network, and every call is counted so a test can say what
// was asked for and, as important, what was not (no attachment is ever fetched, the token is never in an address).

export interface FakeMail {
  id: string;
  from: string;
  subject: string;
  date?: string;
  text?: string;
  html?: string;
  /** Attachment file names. The fake has no bytes to give: a request for one fails the test. */
  attachments?: string[];
  /** Which search finds it. */
  kind: "subscription" | "document" | "other";
}

export const b64url = (s: string): string => Buffer.from(s, "utf8").toString("base64url");

export function mailPayload(m: FakeMail): unknown {
  const parts: unknown[] = [];
  if (m.text !== undefined)
    parts.push({ mimeType: "text/plain", filename: "", body: { data: b64url(m.text), size: m.text.length } });
  if (m.html !== undefined)
    parts.push({ mimeType: "text/html", filename: "", body: { data: b64url(m.html), size: m.html.length } });
  for (const f of m.attachments ?? []) {
    parts.push({ mimeType: "application/pdf", filename: f, body: { attachmentId: `att-${m.id}`, size: 12345 } });
  }
  return {
    mimeType: "multipart/mixed",
    headers: [
      { name: "From", value: m.from },
      { name: "Subject", value: m.subject },
      { name: "Date", value: m.date ?? "Mon, 20 Oct 2026 10:00:00 +0000" },
    ],
    parts: [{ mimeType: "multipart/alternative", filename: "", parts }],
  };
}

export interface FakeGmailOptions {
  token?: string;
  /** Ids per page of a list answer. Default 500 (Gmail's own maximum). */
  pageSize?: number;
  /** The first list call answers this status once. */
  listFailsOnce?: number;
  /** A message id that answers this status every time. */
  getFails?: Record<string, number>;
  /** Make a list call never finish, to test the timeout. */
  hang?: boolean;
}

export function createFakeGmail(mails: FakeMail[], o: FakeGmailOptions = {}) {
  const token = o.token ?? "ya29.fake-access-token";
  const calls = {
    list: 0,
    get: 0,
    revoke: 0,
    attachment: 0,
    urls: [] as string[],
    bodies: [] as string[],
    queries: [] as string[],
  };
  const revoked: string[] = [];
  let listFailed = false;
  const json = (v: unknown, status = 200) =>
    new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

  const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.urls.push(url.toString());
    if (url.pathname === "/revoke") {
      calls.revoke++;
      const t = new URLSearchParams(String(init.body)).get("token") ?? "";
      calls.bodies.push(String(init.body));
      if (t === token) {
        revoked.push(t);
        return json({}, 200);
      }
      return json({ error: "invalid_token" }, 400);
    }
    const authz = new Headers(init.headers).get("authorization");
    if (authz !== `Bearer ${token}`) return json({ error: { code: 401 } }, 401);
    if (o.hang)
      return new Promise((_r, rej) =>
        init.signal?.addEventListener("abort", () => rej(new DOMException("a", "AbortError"))),
      );

    if (/\/messages\/[^/]+\/attachments\//.test(url.pathname)) {
      calls.attachment++;
      return json({ error: "an attachment was fetched" }, 500);
    }
    const one = /\/gmail\/v1\/users\/me\/messages\/([^/?]+)$/.exec(url.pathname);
    if (one) {
      calls.get++;
      const id = decodeURIComponent(one[1]!);
      if (o.getFails?.[id]) return json({ error: { code: o.getFails[id] } }, o.getFails[id]);
      const m = mails.find((x) => x.id === id);
      if (!m) return json({ error: { code: 404 } }, 404);
      if (url.searchParams.get("format") !== "full") return json({ error: "format" }, 400);
      return json({ id, payload: mailPayload(m) });
    }
    if (url.pathname === "/gmail/v1/users/me/messages") {
      calls.list++;
      if (o.listFailsOnce && !listFailed) {
        listFailed = true;
        return json({ error: { code: o.listFailsOnce } }, o.listFailsOnce);
      }
      const q = url.searchParams.get("q") ?? "";
      calls.queries.push(q);
      const wanted = q.includes("has:attachment") ? "document" : "subscription";
      const all = mails.filter((m) => m.kind === wanted);
      const size = Math.min(Number(url.searchParams.get("maxResults") ?? 100), o.pageSize ?? 500);
      const start = Number(url.searchParams.get("pageToken") ?? 0);
      const slice = all.slice(start, start + size);
      return json({
        ...(slice.length ? { messages: slice.map((m) => ({ id: m.id, threadId: `t-${m.id}` })) } : {}),
        ...(start + size < all.length ? { nextPageToken: String(start + size) } : {}),
        resultSizeEstimate: all.length,
      });
    }
    return json({ error: "not found" }, 404);
  }) as typeof fetch;

  return { fetch: fakeFetch, token, calls, revoked };
}
