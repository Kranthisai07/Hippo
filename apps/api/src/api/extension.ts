import { unauthorized, type Auth } from "@hippo/auth";
import type { Doc, Repository } from "core/src/contracts";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { maskNumbers } from "../mcp/speak";
import { listSubscriptions } from "../subscriptions";
import { ApiError, errorBody, readJson } from "./http";
import { sha256Hex } from "./hash";
import { enforce, type RateLimiter } from "./limiter";
import { UPLOADS_PER_HOUR } from "./routes";
import { sanitizeFilename } from "./storage";

// What the browser extension calls. Bearer tokens, because an extension has no session cookie on this site. No model and
// nothing confirmed here: a capture lands on the same review screen as an upload.

export type CaptureResult =
  | { status: "saved" | "failed" }
  /** No subscription on the page. Nothing was stored. */
  | { status: "none" }
  /** The household already tracks this vendor. `docId` is null for a subscription added by voice. */
  | { status: "duplicate"; docId: string | null };

export type OnCaptured = (event: {
  householdId: string;
  doc: Doc;
  /** The page title on line one, then the visible text. Numbers are masked. Untrusted. */
  text: string;
  host: string;
}) => Promise<CaptureResult>;

export interface ExtensionDeps {
  auth: Auth;
  repo: Repository;
  onCaptured: OnCaptured | undefined;
  allowedOrigins: ReadonlySet<string>;
  limiter: RateLimiter;
  now: () => number;
}

export const MAX_CAPTURE_CHARS = 60_000;
/** Saved pages one household may keep. Delete some in Hippo to save more. */
export const MAX_CAPTURED_PAGES = 200;
/** JSON escapes and multibyte text can make a page of MAX_CAPTURE_CHARS several times its length in bytes. */
const MAX_CAPTURE_BYTES = 256 * 1024;
const SCOPE = "mcp:tools";
const READS_PER_MINUTE = 60;

const CaptureBody = z.strictObject({
  title: z.string().max(300),
  /** The site name only. A path or a query string can hold a token, so it does not fit this pattern. */
  host: z
    .string()
    .max(253)
    .regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i),
  text: z.string().min(1).max(MAX_CAPTURE_CHARS),
});

const reviewUrl = (docId: string): string => `/review/${docId}`;

export function createExtensionApi(deps: ExtensionDeps): Hono<{ Variables: { hh: string } }> {
  const { repo } = deps;
  const ext = new Hono<{ Variables: { hh: string } }>();
  const today = () => new Date(deps.now()).toISOString().slice(0, 10);

  ext.onError((err, c) => {
    if (err instanceof ApiError) return c.json(errorBody(err.status, err.message), err.status, err.headers);
    if (err instanceof HTTPException) return c.json(errorBody(400, "That request could not be read."), 400);
    // Never a stack trace and never the message of an unexpected error, which could hold page text.
    return c.json(errorBody(500, "Something went wrong on our side. Please try again."), 500);
  });

  ext.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Vary", "Origin");
    const origin = c.req.header("origin");
    // Exact match against the list. "null" and every other origin are refused, and nothing here is a wildcard.
    if (origin !== undefined && !deps.allowedOrigins.has(origin)) {
      throw new ApiError(403, "This request did not come from the Hippo extension.");
    }
    if (origin !== undefined) c.header("Access-Control-Allow-Origin", origin);
    // A preflight carries no token, so it is answered before the bearer check.
    if (c.req.method === "OPTIONS") {
      c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      c.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
      c.header("Access-Control-Max-Age", "600");
      return c.body(null, 204);
    }
    // The household comes from the token and from nowhere else.
    const user = await deps.auth.verifyBearer(c.req.header("authorization"));
    if (!user || !user.scope.split(" ").includes(SCOPE)) {
      // unauthorized() is a fresh Response, so the headers set above are not on it.
      const denied = unauthorized();
      denied.headers.set("Vary", "Origin");
      if (origin !== undefined) denied.headers.set("Access-Control-Allow-Origin", origin);
      return denied;
    }
    c.set("hh", user.householdId);
    await next();
  });

  ext.get("/subscriptions", async (c) => {
    await enforce(deps.limiter, `sub:${c.var.hh}`, 60_000, READS_PER_MINUTE, "Too many requests. Please slow down.");
    return c.json(await listSubscriptions(repo, c.var.hh, today()));
  });

  ext.post("/captures", async (c) => {
    if (!deps.onCaptured) {
      throw new ApiError(403, "Saving pages is off on this public demo. Run Hippo on your own machine to save pages.");
    }
    const hh = c.var.hh;
    const body = await readJson(c, CaptureBody, MAX_CAPTURE_BYTES);

    await enforce(
      deps.limiter,
      `cap:${hh}`,
      3_600_000,
      UPLOADS_PER_HOUR,
      "Too many pages saved. Please try again later.",
    );

    // Masked again here: a client is never trusted to have done it.
    const title = maskNumbers(body.title.replace(/\s+/g, " ").trim());
    const text = `${title}\n${maskNumbers(body.text)}`;

    // The id comes from the text, so the same page saved twice is the same document.
    const docId = `doc-${(await sha256Hex(text)).slice(0, 24)}`;
    const existing = await repo.getDoc(hh, docId);
    if (existing && existing.status !== "failed") {
      throw new ApiError(409, "This page is already saved.", { "X-Hippo-Doc": docId });
    }
    // shortcut: counts by listing the household's documents, which is fine at this cap and not for thousands.
    const held = (await repo.listDocs(hh)).filter((d) => d.s3Key.startsWith("captures/")).length;
    if (held >= MAX_CAPTURED_PAGES) {
      throw new ApiError(
        422,
        `You have saved ${MAX_CAPTURED_PAGES} pages, which is the limit. Delete some in Hippo to save more.`,
      );
    }
    const doc: Doc = {
      id: docId,
      s3Key: `captures/${hh}/${docId}/page.txt`,
      // The site name is masked too: a host can hold an account number, and this name is quoted back by the voice tools.
      filename: sanitizeFilename(maskNumbers(`${body.host.toLowerCase()} ${title}`).replace(/[\\/]/g, " "), "txt"),
      docType: "other",
      status: "uploaded",
      uploadedAt: new Date(deps.now()).toISOString(),
      assetIds: [],
    };
    const result = await deps.onCaptured({ householdId: hh, doc, text, host: body.host.toLowerCase() });
    if (result.status === "duplicate") {
      throw new ApiError(
        409,
        "You already track this subscription.",
        result.docId ? { "X-Hippo-Doc": result.docId } : {},
      );
    }
    if (result.status === "none") return c.json({ saved: false });
    if (result.status === "failed") throw new ApiError(500, "We could not read this page. Please try again.");
    return c.json({ saved: true, docId, reviewUrl: reviewUrl(docId) }, 201);
  });

  return ext;
}
