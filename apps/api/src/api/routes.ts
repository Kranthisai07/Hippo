import type { Auth } from "@hippo/auth";
import type { Alert, Repository } from "core/src/contracts";
import { isOpenAlert, s3KeysForDoc } from "core/src/repository/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { addDays, parseIso } from "obligation-kit";
import { z } from "zod";
import { syncObligations } from "../obligations";
import { listSubscriptions } from "../subscriptions";
import { applyAlertAction } from "../mcp/alerts";
import { maskNumbers } from "../mcp/speak";
import type { IndexCache } from "../mcp/indexCache";
import { agreementView, allReviewed, docView, isKnownField, valueSchemaOf } from "./agreements";
import { readPages, updateIndex, type IndexStore, type OnUploaded } from "./fixtureIngest";
import { enforce, type RateLimiter } from "./limiter";
import { ApiError, errorBody, notFound, readBytes, readJson } from "./http";
import { maskAlert, maskAsset, maskEvent, maskObligation } from "./mask";
import {
  isUploadType,
  MAX_UPLOAD_BYTES,
  sanitizeFilename,
  UPLOAD_TYPES,
  type LocalUploader,
  type ObjectStore,
  type Uploader,
} from "./storage";

export interface WebApiDeps {
  /** The same auth instance createApp uses. The household comes from its verifySession and from nowhere else. */
  auth: Auth;
  repo: Repository;
  objectStore: ObjectStore;
  uploader: Uploader;
  onUploaded: OnUploaded;
  indexStore: IndexStore | undefined;
  indexes: IndexCache;
  now: () => number;
  newId: () => string;
  /** Browser origins that may send writes with the cookie. The request's own origin is always allowed. */
  origins: string[];
  limiter: RateLimiter;
}

/** Every list a route returns is cut at this many rows. */
export const MAX_LIST = 200;
export const MAX_RANGE_DAYS = 400;
export const DEFAULT_RANGE_DAYS = 90;
export const UPLOADS_PER_HOUR = 30;
const HISTORY_LIMIT = 50;

const UploadBody = z.strictObject({
  filename: z.string().min(1).max(1024),
  contentType: z.string().min(1).max(200),
  size: z.number().int(),
});
const FieldBody = z.strictObject({ value: z.unknown() });
const ConfirmBody = z.strictObject({ fields: z.array(z.string().min(1).max(100)).min(1).max(100) });
const ResolveBody = z.strictObject({ action: z.enum(["done", "dismiss", "not_mine", "snooze_7d"]) });
const SettingsBody = z.strictObject({
  digestOn: z.boolean(),
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)).optional(),
});
const DeleteDataBody = z.strictObject({ confirm: z.literal("delete all my data") });

const HEIC = "HEIC photos are not supported. Convert the photo to JPEG first, then upload it.";

/** The first bytes of each allowed type, so a file cannot claim to be something else. */
const MAGIC: Record<string, number[]> = {
  "application/pdf": [0x25, 0x50, 0x44, 0x46, 0x2d],
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/png": [0x89, 0x50, 0x4e, 0x47],
};
const looksLike = (type: string, b: Uint8Array): boolean => (MAGIC[type] ?? []).every((x, i) => b[i] === x);

export function createWebApi(deps: WebApiDeps): Hono<{ Variables: { hh: string; email: string } }> {
  const { repo, objectStore } = deps;
  const api = new Hono<{ Variables: { hh: string; email: string } }>();
  const extra = new Set(deps.origins);
  const nowIso = () => new Date(deps.now()).toISOString();
  const today = () => nowIso().slice(0, 10);
  const receiving = new Set<string>();

  api.onError((err, c) => {
    if (err instanceof ApiError) return c.json(errorBody(err.status, err.message), err.status, err.headers);
    if (err instanceof HTTPException) {
      const status = err.status === 413 ? 413 : 400;
      return c.json(errorBody(status, "That request could not be read."), status);
    }
    // Never a stack trace and never the message of an unexpected error, which could hold document text.
    return c.json(errorBody(500, "Something went wrong on our side. Please try again."), 500);
  });

  api.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    // Same origin policy: a write must name its own origin (or one of the configured dev origins). A missing Origin is
    // refused too, because a browser always sends it on a write.
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const origin = c.req.header("origin");
      if (origin === undefined || (origin !== new URL(c.req.url).origin && !extra.has(origin))) {
        throw new ApiError(403, "This request did not come from the Hippo web app.");
      }
    }
    const session = await deps.auth.verifySession(c.req.header("cookie"));
    if (!session) throw new ApiError(401, "Please sign in.");
    c.set("hh", session.householdId);
    c.set("email", session.email);
    await next();
  });

  // Session

  api.get("/me", async (c) => {
    const household = await repo.getHousehold(c.var.hh);
    return c.json({ email: household?.email ?? c.var.email, digestOn: household?.digestOn ?? true });
  });

  api.get("/subscriptions", async (c) => c.json(await listSubscriptions(repo, c.var.hh, today())));

  // Uploads

  api.post("/uploads", async (c) => {
    const hh = c.var.hh;
    const body = await readJson(c, UploadBody);
    const type = body.contentType.trim().toLowerCase();
    if (/^image\/hei[cf]/.test(type) || /\.hei[cf]$/i.test(body.filename.trim())) throw new ApiError(415, HEIC);
    if (!isUploadType(type)) throw new ApiError(415, "Only PDF, JPEG and PNG files can be uploaded.");
    if (body.size < 1) throw new ApiError(400, "That file is empty.");
    if (body.size > MAX_UPLOAD_BYTES) throw new ApiError(413, "That file is larger than 15 MB.");

    await enforce(deps.limiter, `up:${hh}`, 3_600_000, UPLOADS_PER_HOUR, "Too many uploads. Please try again later.");

    const docId = `doc-${deps.newId()}`;
    // The person's file name is a label only. The key is built from ids and the type, so no name can shape a path.
    const key = `uploads/${hh}/${docId}/original.${UPLOAD_TYPES[type]}`;
    const upload = await deps.uploader.prepare({ key, contentType: type, size: body.size });
    await repo.putDoc(hh, {
      id: docId,
      s3Key: key,
      filename: sanitizeFilename(body.filename, UPLOAD_TYPES[type]),
      docType: "other",
      status: "uploaded",
      uploadedAt: nowIso(),
      assetIds: [],
    });
    return c.json({ docId, upload }, 201);
  });

  const local = deps.uploader as Partial<LocalUploader>;
  if (local.expected && local.done) {
    api.put("/uploads/:docId/content", async (c) => {
      const hh = c.var.hh;
      const doc = await repo.getDoc(hh, c.req.param("docId"));
      if (!doc) throw notFound();
      const expected = local.expected!(doc.s3Key);
      if (doc.status !== "uploaded" || !expected || receiving.has(doc.s3Key)) {
        throw new ApiError(409, "This document already has a file.");
      }
      if ((c.req.header("content-type") ?? "").trim().toLowerCase() !== expected.contentType) {
        throw new ApiError(415, "The file type does not match what you said you would upload.");
      }
      receiving.add(doc.s3Key);
      try {
        const bytes = await readBytes(c.req.raw, expected.size);
        if (bytes === null) throw new ApiError(413, "The file is bigger than the size you declared.");
        if (bytes.length !== expected.size) throw new ApiError(400, "The file is smaller than the size you declared.");
        if (!looksLike(expected.contentType, bytes)) {
          throw new ApiError(415, "The file does not look like the type you said it was.");
        }
        await objectStore.put(doc.s3Key, bytes);
        local.done!(doc.s3Key);
      } finally {
        receiving.delete(doc.s3Key);
      }
      try {
        await deps.onUploaded({ householdId: hh, docId: doc.id });
      } catch {
        const latest = await repo.getDoc(hh, doc.id);
        if (latest && (latest.status === "uploaded" || latest.status === "extracting")) {
          await repo.putDoc(hh, {
            ...latest,
            status: "failed",
            failureReason: "We could not read this file. Try uploading it again.",
          });
        }
      }
      return c.body(null, 204);
    });
  }

  // Documents

  api.get("/docs", async (c) => {
    const docs = await repo.listDocs(c.var.hh);
    return c.json({ docs: docs.slice(0, MAX_LIST).map(docView) });
  });

  api.get("/docs/:id", async (c) => {
    const hh = c.var.hh;
    const doc = await repo.getDoc(hh, c.req.param("id"));
    if (!doc) throw notFound();
    const [agreement] = await repo.listAgreements(hh, { docId: doc.id });
    return c.json({ doc: docView(doc), agreement: agreement ? agreementView(agreement) : null });
  });

  api.get("/docs/:id/pages/:n", async (c) => {
    const hh = c.var.hh;
    const doc = await repo.getDoc(hh, c.req.param("id"));
    const n = /^[0-9]{1,4}$/.test(c.req.param("n")) ? Number(c.req.param("n")) : 0;
    const pages = doc ? await readPages(objectStore, hh, doc.id) : null;
    const text = pages?.[n - 1];
    if (text === undefined) throw notFound();
    // Policy and account numbers are masked here like everywhere else (CLAUDE.md hard rule).
    return c.json({ page: n, text: maskNumbers(text) });
  });

  api.delete("/docs/:id", async (c) => {
    const hh = c.var.hh;
    const id = c.req.param("id");
    const doc = await repo.getDoc(hh, id);
    if (!doc) throw notFound();
    // Files and index entries go first and the records last, so a storage failure leaves the document in place and a
    // retry works. Deleting a file that is already gone is fine.
    const chunkMeta = await repo.getChunkMeta(hh, id);
    await objectStore.delete(s3KeysForDoc(hh, doc, chunkMeta?.s3Key));
    await updateIndex(deps.indexStore, hh, { removeDocId: id });
    const { s3Keys } = await repo.deleteDocumentCascade(hh, id);
    await objectStore.delete(s3Keys);
    return c.body(null, 204);
  });

  // Review and confirm

  /** Recomputes the agreement's obligations (alerts only from confirmed fields) and activates a fully reviewed doc. */
  async function afterReview(hh: string, agreementId: string) {
    const agreement = (await repo.getAgreement(hh, agreementId))!;
    const assets = await repo.listAssets(hh);
    const obligations = await syncObligations(repo, hh, agreement, assets, today());
    const doc = agreement.docId ? await repo.getDoc(hh, agreement.docId) : null;
    if (doc && doc.status === "needs_review" && allReviewed(agreement)) {
      await repo.putDoc(hh, { ...doc, status: "active" });
    }
    return { agreement, obligations };
  }

  api.patch("/agreements/:id/fields/:name", async (c) => {
    const hh = c.var.hh;
    const agreement = await repo.getAgreement(hh, c.req.param("id"));
    const name = c.req.param("name");
    if (!agreement || !isKnownField(agreement.kind, name)) throw notFound();
    const body = await readJson(c, FieldBody);
    const schema = valueSchemaOf(agreement.kind, name);
    if (!schema) throw new ApiError(400, "That field has several parts and cannot be edited as one value.");
    const parsed = schema.safeParse(body.value);
    if (!parsed.success) throw new ApiError(400, "That value does not fit this field.");
    await repo.putAgreement(hh, {
      ...agreement,
      fields: { ...agreement.fields, [name]: parsed.data },
      fieldStatus: { ...agreement.fieldStatus, [name]: "edited" },
    });
    const { agreement: saved } = await afterReview(hh, agreement.id);
    const field = agreementView(saved).fields.find((f) => f.name === name)!;
    return c.json({ field });
  });

  api.post("/agreements/:id/confirm", async (c) => {
    const hh = c.var.hh;
    const agreement = await repo.getAgreement(hh, c.req.param("id"));
    if (!agreement) throw notFound();
    const { fields } = await readJson(c, ConfirmBody);
    // Only names the agreement really has, and never a wildcard: a name that is not an own field is refused.
    if (!fields.every((f) => Object.hasOwn(agreement.fields, f))) {
      throw new ApiError(400, "One of those field names is not part of this agreement.");
    }
    const fieldStatus = { ...agreement.fieldStatus };
    for (const f of fields) fieldStatus[f] = "confirmed";
    await repo.putAgreement(hh, { ...agreement, fieldStatus });
    const { agreement: saved, obligations } = await afterReview(hh, agreement.id);
    return c.json({ agreement: agreementView(saved), obligations });
  });

  // Coming up, alerts, things

  api.get("/obligations", async (c) => {
    const hh = c.var.hh;
    const from = c.req.query("from") ?? today();
    if (parseIso(from) === null) throw new ApiError(400, "Dates must look like 2026-10-21.");
    const to = c.req.query("to") ?? addDays(from, DEFAULT_RANGE_DAYS);
    if (parseIso(to) === null) throw new ApiError(400, "Dates must look like 2026-10-21.");
    if (to < from) throw new ApiError(400, "The end date must not be before the start date.");
    if (addDays(from, MAX_RANGE_DAYS) < to) {
      throw new ApiError(400, `Ask for at most ${MAX_RANGE_DAYS} days at a time.`);
    }
    const [obligations, agreements] = await Promise.all([
      repo.listObligations(hh, { from, to }),
      repo.listAgreements(hh),
    ]);
    const docOf = new Map(agreements.map((a) => [a.id, a.docId]));
    const items = obligations.slice(0, MAX_LIST * 2).map((obligation) => {
      const docId = obligation.agreementId ? docOf.get(obligation.agreementId) : undefined;
      return {
        // An unconfirmed date never carries a severity, whatever was stored.
        obligation: maskObligation(obligation.confirmed ? obligation : { ...obligation, severity: null }),
        needsConfirmation: !obligation.confirmed,
        ...(docId ? { docId } : {}),
        ...(obligation.assetId ? { assetId: obligation.assetId } : {}),
      };
    });
    return c.json({ items });
  });

  api.get("/alerts", async (c) => {
    const hh = c.var.hh;
    const open = c.req.query("open");
    if (open !== undefined && open !== "true" && open !== "false")
      throw new ApiError(400, "open must be true or false.");
    let alerts: Alert[] = await repo.listAlerts(hh, open === "true" ? { open: true } : undefined);
    if (open === "false") alerts = alerts.filter((a) => !isOpenAlert(a));
    // A snoozed alert stays out of the open list until its date.
    if (open === "true") alerts = alerts.filter((a) => !a.snoozedUntil || a.snoozedUntil.slice(0, 10) <= today());
    return c.json({ alerts: alerts.slice(0, MAX_LIST).map(maskAlert) });
  });

  api.post("/alerts/:id/resolve", async (c) => {
    const hh = c.var.hh;
    const id = c.req.param("id");
    if (!(await repo.getAlert(hh, id))) throw notFound();
    const { action } = await readJson(c, ResolveBody);
    // The same function the voice tool resolve_alert uses, so both paths behave the same.
    const result = await applyAlertAction(
      { householdId: hh, repo, today: today(), nowMs: deps.now(), newId: deps.newId, indexes: deps.indexes },
      id,
      action,
    );
    if (result.isError) throw new ApiError(400, "Not mine only applies to recalls. Dismiss it instead.");
    const updated = await repo.getAlert(hh, id);
    return c.json({ alert: updated ? maskAlert(updated) : updated });
  });

  api.get("/assets", async (c) =>
    c.json({ assets: (await repo.listAssets(c.var.hh)).slice(0, MAX_LIST).map(maskAsset) }),
  );

  api.get("/assets/:id", async (c) => {
    const hh = c.var.hh;
    const asset = await repo.getAsset(hh, c.req.param("id"));
    if (!asset) throw notFound();
    const [docs, agreements, history] = await Promise.all([
      repo.listDocs(hh),
      repo.listAgreements(hh, { assetId: asset.id }),
      repo.listEvents(hh, asset.id, HISTORY_LIMIT),
    ]);
    return c.json({
      asset: maskAsset(asset),
      docs: docs
        .filter((d) => d.assetIds.includes(asset.id))
        .slice(0, MAX_LIST)
        .map(docView),
      agreements: agreements.slice(0, MAX_LIST).map(agreementView),
      history: history.map(maskEvent),
    });
  });

  // Settings and data

  api.put("/settings", async (c) => {
    const hh = c.var.hh;
    const body = await readJson(c, SettingsBody);
    const household = (await repo.getHousehold(hh)) ?? { id: hh, digestOn: true, createdAt: nowIso() };
    const next = { ...household, digestOn: body.digestOn, ...(body.email !== undefined ? { email: body.email } : {}) };
    await repo.putHousehold(hh, next);
    return c.json({ digestOn: next.digestOn, email: next.email ?? c.var.email });
  });

  api.delete("/data", async (c) => {
    const hh = c.var.hh;
    await readJson(c, DeleteDataBody);
    // Same order as deleting one document: files and index first, records last, so a failure can be retried.
    for (const doc of await repo.listDocs(hh)) {
      const chunkMeta = await repo.getChunkMeta(hh, doc.id);
      await objectStore.delete(s3KeysForDoc(hh, doc, chunkMeta?.s3Key));
    }
    await updateIndex(deps.indexStore, hh, { clear: true });
    const { s3Keys } = await repo.deleteHousehold(hh);
    await objectStore.delete(s3Keys);
    return c.body(null, 204);
  });

  api.all("*", () => {
    throw notFound();
  });

  return api;
}
