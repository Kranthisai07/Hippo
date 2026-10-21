import type {
  AgreementView,
  Alert,
  AlertAction,
  Asset,
  Doc,
  DocDetail,
  FieldView,
  Me,
  ObligationItem,
  ObligationRecord,
  ServiceEvent,
  UploadTicket,
} from "./types";

// One function per route of docs/WEB_API.md. The browser calls its own origin; the cookie is HttpOnly and never read here.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// /oauth answers with a bare code string ({"error":"rate_limited"}), /api with {error:{code,message}}. Both end up here.
const OAUTH_MESSAGES: Record<string, string> = {
  access_denied: "That did not work. Check the email and the code, then try again.",
  invalid_request: "Enter a valid email address.",
  forbidden_origin: "This page is not allowed to sign in from this address.",
};

const FALLBACK: Record<number, string> = {
  401: "Please sign in again.",
  403: "That is not allowed from this page.",
  404: "We could not find that.",
  413: "That is too large.",
  415: "That kind of file is not supported.",
  429: "Too many tries. Please wait a little and try again.",
};

export async function parseError(res: Response): Promise<ApiError> {
  let code = "http_" + res.status;
  let message = "";
  try {
    const body: unknown = await res.json();
    const err = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
    if (typeof err === "string") {
      code = err;
      message = OAUTH_MESSAGES[err] ?? "";
    } else if (err && typeof err === "object") {
      const e = err as { code?: unknown; message?: unknown };
      if (typeof e.code === "string") code = e.code;
      if (typeof e.message === "string") message = e.message;
    }
  } catch {
    // Not JSON (a proxy error page, for example). The text is never shown.
  }
  const header = Number(res.headers.get("Retry-After"));
  const retryAfter = res.status === 429 && Number.isFinite(header) && header > 0 ? Math.ceil(header) : undefined;
  if (res.status === 429 && (code === "rate_limited" || !message)) {
    message = retryAfter ? `Too many tries. Please wait ${retryAfter} seconds and try again.` : FALLBACK[429]!;
  }
  if (!message) message = FALLBACK[res.status] ?? "Something went wrong on our side. Please try again.";
  return new ApiError(res.status, code, message, retryAfter);
}

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method, credentials: "same-origin" };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, "network", "We could not reach the server. Check your connection and try again.");
  }
  if (!res.ok) throw await parseError(res);
  return res;
}

async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
  return (await (await send(method, path, body)).json()) as T;
}

const id = encodeURIComponent;

export const api = {
  // Session
  demoSession: () => json<{ email: string }>("POST", "/oauth/session", { demo: true }),
  magicCode: (email: string) => json<{ ok: true }>("POST", "/oauth/magic-code", { email }),
  session: (email: string, code: string) => json<{ email: string }>("POST", "/oauth/session", { email, code }),
  logout: () => json<{ ok: true }>("POST", "/oauth/logout", {}),
  me: () => json<Me>("GET", "/api/me"),

  // Documents
  announceUpload: (f: { filename: string; contentType: string; size: number }) =>
    json<UploadTicket>("POST", "/api/uploads", f),
  async putUpload(upload: UploadTicket["upload"], file: Blob): Promise<void> {
    let res: Response;
    try {
      res = await fetch(upload.url, {
        method: upload.method,
        headers: upload.headers,
        body: file,
        credentials: "same-origin",
      });
    } catch {
      throw new ApiError(0, "network", "We could not reach the server. Check your connection and try again.");
    }
    if (!res.ok) throw await parseError(res);
  },
  listDocs: () => json<{ docs: Doc[] }>("GET", "/api/docs"),
  getDoc: (docId: string) => json<DocDetail>("GET", `/api/docs/${id(docId)}`),
  getPage: (docId: string, page: number) =>
    json<{ page: number; text: string }>("GET", `/api/docs/${id(docId)}/pages/${page}`),
  deleteDoc: async (docId: string): Promise<void> => void (await send("DELETE", `/api/docs/${id(docId)}`)),

  // Review
  patchField: (agreementId: string, name: string, value: unknown) =>
    json<{ field: FieldView }>("PATCH", `/api/agreements/${id(agreementId)}/fields/${id(name)}`, { value }),
  confirmFields: (agreementId: string, fields: string[]) =>
    json<{ agreement: AgreementView; obligations: ObligationRecord[] }>(
      "POST",
      `/api/agreements/${id(agreementId)}/confirm`,
      { fields },
    ),

  // Coming up
  listObligations: (from?: string, to?: string) => {
    const q = new URLSearchParams();
    if (from) q.set("from", from);
    if (to) q.set("to", to);
    const s = q.toString();
    return json<{ items: ObligationItem[] }>("GET", `/api/obligations${s ? "?" + s : ""}`);
  },
  listAlerts: (openOnly = true) => json<{ alerts: Alert[] }>("GET", `/api/alerts${openOnly ? "?open=true" : ""}`),
  resolveAlert: (alertId: string, action: AlertAction) =>
    json<{ alert: Alert }>("POST", `/api/alerts/${id(alertId)}/resolve`, { action }),

  // Things
  listAssets: () => json<{ assets: Asset[] }>("GET", "/api/assets"),
  getAsset: (assetId: string) =>
    json<{ asset: Asset; docs: Doc[]; agreements: AgreementView[]; history: ServiceEvent[] }>(
      "GET",
      `/api/assets/${id(assetId)}`,
    ),

  // Settings and data
  putSettings: (s: { digestOn: boolean; email?: string }) =>
    json<{ digestOn: boolean; email?: string }>("PUT", "/api/settings", s),
  deleteAllData: async (): Promise<void> => void (await send("DELETE", "/api/data", { confirm: "delete all my data" })),
};
