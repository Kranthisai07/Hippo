import type { Agreement, Doc, DocType, Repository } from "core/src/contracts";
import { linkAssetHint, linkVehicleHint, type AssetRecord } from "core/src/linking";
import { pageTextKey } from "core/src/repository/shared";
import { buildIndex, chunkPages, loadIndex, serializeIndex, type Chunk } from "core/src/retrieval";
import type { AgreementFields, AgreementKind } from "obligation-kit";
import { PARTY_FIELD, syncObligations } from "../obligations";
import type { IndexSource } from "../mcp/indexCache";
import type { ObjectStore } from "./storage";

/** Called once the bytes of an upload are stored. The real ingest worker replaces this (docs/WEB_API.md). */
export type OnUploaded = (event: { householdId: string; docId: string }) => Promise<void> | void;

/** Where the household clause index lives: S3 in production, a Map locally. */
export type IndexStore = IndexSource & { put(householdId: string, serialized: string): Promise<void> | void };

/** Adds the chunks of some documents to, or removes the chunks of one document from, the household index. */
export async function updateIndex(
  store: IndexStore | undefined,
  householdId: string,
  change: { add?: Chunk[]; removeDocId?: string; clear?: boolean },
): Promise<void> {
  if (!store) return;
  const current = change.clear ? null : await store.load(householdId);
  const kept = current ? [...loadIndex(current).chunks.values()].filter((c) => c.docId !== change.removeDocId) : [];
  const ids = new Set((change.add ?? []).map((c) => c.docId));
  await store.put(
    householdId,
    serializeIndex(buildIndex([...kept.filter((c) => !ids.has(c.docId)), ...(change.add ?? [])])),
  );
}

/** What the ingest stores under pageTextKey: one string per page, page 1 first. */
export const pagesObject = (pages: string[]): Uint8Array => new TextEncoder().encode(JSON.stringify({ pages }));

export async function readPages(store: ObjectStore, householdId: string, docId: string): Promise<string[] | null> {
  const bytes = await store.get(pageTextKey(householdId, docId));
  if (!bytes) return null;
  try {
    const v = JSON.parse(new TextDecoder().decode(bytes)) as { pages?: unknown };
    return Array.isArray(v.pages) && v.pages.every((p) => typeof p === "string") ? (v.pages as string[]) : null;
  } catch {
    return null;
  }
}

/** The asset a document is about, only when there is exactly one sure match. Anything less is left for the person. */
export function linkedAssets(kind: AgreementKind, fields: Record<string, unknown>, assets: AssetRecord[]): string[] {
  const hint = fields.assetHint as { brand?: string; model?: string; serial?: string } | undefined;
  if ((kind === "warranty" || kind === "service_plan") && hint) {
    const link = linkAssetHint(hint, assets);
    return link.status === "match" ? [link.asset.id] : [];
  }
  const cars = fields.coveredAssetHints;
  if (kind === "insurance" && Array.isArray(cars) && cars.length === 1) {
    const link = linkVehicleHint(cars[0] as { make?: string; model?: string; year?: number }, assets);
    return link.status === "match" ? [link.asset.id] : [];
  }
  return [];
}

export interface SavedIngest {
  householdId: string;
  doc: Doc;
  kind: DocType;
  /** Null for a document that is not an agreement (kind "other"): stored and searchable, no agreement. */
  flat: AgreementFields | null;
  pages: string[];
  agreementId: string;
}

/**
 * The save half of every ingest, shared by the fixture ingest and the real pipeline: the agreement with every field
 * as the caller gives it (the ingest passes only `extracted`, so nothing is confirmed and no alert can exist), the
 * obligations, the page text under derived/, the clause chunks and index, then the Doc as needs_review.
 */
export async function saveIngested(deps: Omit<FixtureIngestDeps, "newId">, a: SavedIngest): Promise<void> {
  const { repo, objectStore } = deps;
  const { householdId: hh, doc, kind, flat, pages } = a;
  const nowMs = deps.now();
  let assetIds: string[] = [];
  if (flat && kind !== "other") {
    const assets = await repo.listAssets(hh);
    assetIds = linkedAssets(kind, flat.fields, assets);
    const party = flat.fields[PARTY_FIELD[kind]];
    const agreement: Agreement = {
      id: a.agreementId,
      kind,
      ...(typeof party === "string" ? { party } : {}),
      title: typeof flat.fields.plan === "string" ? flat.fields.plan : kind,
      assetIds,
      docId: doc.id,
      fields: flat.fields,
      fieldStatus: flat.fieldStatus,
      sourceRefs: flat.sourceRefs,
      createdAt: new Date(nowMs).toISOString(),
    };
    await repo.putAgreement(hh, agreement);
    // Nothing is confirmed, so these are timeline entries without a severity and raise no alert (INTENT principle 2).
    await syncObligations(repo, hh, agreement, assets, new Date(nowMs).toISOString().slice(0, 10));
  }
  await objectStore.put(pageTextKey(hh, doc.id), pagesObject(pages));
  const chunks = chunkPages(
    doc.id,
    pages.map((text, i) => ({ page: i + 1, text })),
  );
  await repo.putChunkMeta(hh, {
    docId: doc.id,
    s3Key: `derived/${hh}/${doc.id}/chunks.json`,
    indexVersion: 1,
    chunkCount: chunks.length,
  });
  await updateIndex(deps.indexStore, hh, { add: chunks });
  const { failureReason: _gone, ...rest } = doc;
  await repo.putDoc(hh, { ...rest, docType: kind, status: "needs_review", pages: pages.length, assetIds });
}

export interface FixtureIngestDeps {
  repo: Repository;
  objectStore: ObjectStore;
  indexStore?: IndexStore | undefined;
  now: () => number;
  newId: () => string;
}
