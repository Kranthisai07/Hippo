import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type { Agreement, Doc, Repository } from "core/src/contracts";
import { linkAssetHint, linkVehicleHint, type AssetRecord } from "core/src/linking";
import { pageTextKey } from "core/src/repository/shared";
import { buildIndex, chunkPages, loadIndex, serializeIndex, type Chunk } from "core/src/retrieval";
import { ExtractionSchemas, leavesToAgreementFields, type AgreementKind } from "obligation-kit";
import { syncObligations } from "../obligations";
import { PARTY_FIELD } from "../seed";
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

const FIXTURES = new URL("../../../../fixtures/", import.meta.url);
const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

interface Expected {
  docType: AgreementKind;
  pages: number;
  fields: Record<string, unknown>;
}

/** SHA-256 of every fixture document to its file stem, read once on first use. */
let fixtureHashes: Map<string, string> | undefined;
function knownFixtures(): Map<string, string> {
  fixtureHashes ??= new Map(
    readdirSync(new URL("docs/", FIXTURES))
      .filter((f) => /\.(pdf|jpg)$/.test(f))
      .map((f) => [sha256(readFileSync(new URL(`docs/${f}`, FIXTURES))), f.replace(/\.[^.]+$/, "")]),
  );
  return fixtureHashes;
}
const readJsonFile = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, FIXTURES), "utf8")) as T;

export const NOT_A_DEMO_DOC = "This build can only read the demo documents until the real reader is connected.";

/** The asset a document is about, only when there is exactly one sure match. Anything less is left for the person. */
function linkedAssets(kind: AgreementKind, fields: Record<string, unknown>, assets: AssetRecord[]): string[] {
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

export interface FixtureIngestDeps {
  repo: Repository;
  objectStore: ObjectStore;
  indexStore?: IndexStore | undefined;
  now: () => number;
  newId: () => string;
}

/**
 * Stand-in for the ingest worker (T2.2) so the web app can be built today: a file that is byte for byte one of
 * fixtures/docs gets its hand written extraction (fields `extracted`, never confirmed) and page text; anything else fails.
 */
export function createFixtureIngest(deps: FixtureIngestDeps): OnUploaded {
  const { repo, objectStore } = deps;
  return async ({ householdId: hh, docId }) => {
    const doc = await repo.getDoc(hh, docId);
    if (!doc) return;
    const bytes = await objectStore.get(doc.s3Key);
    const stem = bytes ? knownFixtures().get(sha256(bytes)) : undefined;
    if (!stem) {
      await repo.putDoc(hh, { ...doc, status: "failed", failureReason: NOT_A_DEMO_DOC });
      return;
    }
    const expected = readJsonFile<Expected>(`expected/${stem}.json`);
    const kind = expected.docType;
    const parsed = ExtractionSchemas[kind].parse(expected.fields) as Record<string, unknown>;
    const flat = leavesToAgreementFields(kind, parsed);
    const pages = readJsonFile<{ pages: string[] }>(`expected/pages/${stem}.json`).pages;
    const assets = await repo.listAssets(hh);
    const assetIds = linkedAssets(kind, flat.fields, assets);
    const nowMs = deps.now();

    const party = flat.fields[PARTY_FIELD[kind]];
    const agreement: Agreement = {
      id: `agr-${deps.newId()}`,
      kind,
      ...(typeof party === "string" ? { party } : {}),
      title: typeof flat.fields.plan === "string" ? flat.fields.plan : kind,
      assetIds,
      docId,
      fields: flat.fields,
      fieldStatus: flat.fieldStatus,
      sourceRefs: flat.sourceRefs,
      createdAt: new Date(nowMs).toISOString(),
    };
    await repo.putAgreement(hh, agreement);
    // Nothing is confirmed, so these are timeline entries without a severity and raise no alert (INTENT principle 2).
    await syncObligations(repo, hh, agreement, assets, new Date(nowMs).toISOString().slice(0, 10));

    await objectStore.put(pageTextKey(hh, docId), pagesObject(pages));
    const chunks = chunkPages(
      docId,
      pages.map((text, i) => ({ page: i + 1, text })),
    );
    await repo.putChunkMeta(hh, {
      docId,
      s3Key: `derived/${hh}/${docId}/chunks.json`,
      indexVersion: 1,
      chunkCount: chunks.length,
    });
    await updateIndex(deps.indexStore, hh, { add: chunks });
    const next: Doc = { ...doc, docType: kind, status: "needs_review", pages: pages.length, assetIds };
    await repo.putDoc(hh, next);
  };
}
