import { readFileSync } from "node:fs";
import { createMemoryRepository } from "core/src/repository";
import type { Doc } from "core/src/contracts";
import type { Ocr } from "core/src/pages";
import { createMemoryObjectStore } from "../../api/src/api/storage";
import { createMemoryIndexSource } from "../../api/src/mcp/indexCache";
import { createFixtureExtractor, createFixtureOcr } from "../src/ingest/fixtures";
import { createIngest } from "../src/ingest/ingest";
import type { Extractor } from "../src/ingest/types";

export const HH = "hh_test";
export const NOW = Date.parse("2026-10-21T12:00:00.000Z");
export const fixtureBytes = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`../../../fixtures/docs/${name}`, import.meta.url)));
export const fixtureJson = <T>(path: string): T =>
  JSON.parse(readFileSync(new URL(`../../../fixtures/${path}`, import.meta.url), "utf8")) as T;

export interface RigOptions {
  extractor?: Extractor;
  ocr?: Ocr;
  maxPages?: number;
  ocrReadsPdfPages?: boolean;
}

/** In-memory repository, object store and index, plus a pipeline wired to the fixture reader unless told otherwise. */
export function rig(opts: RigOptions = {}) {
  const repo = createMemoryRepository();
  const objectStore = createMemoryObjectStore();
  const indexStore = createMemoryIndexSource();
  const logs: string[] = [];
  const ingest = createIngest({
    repo,
    objectStore,
    indexStore,
    now: () => NOW,
    log: (l) => logs.push(l),
    ocr: opts.ocr ?? createFixtureOcr(),
    extractor: opts.extractor ?? createFixtureExtractor(),
    ...(opts.maxPages === undefined ? {} : { maxPages: opts.maxPages }),
    ...(opts.ocrReadsPdfPages === undefined ? {} : { ocrReadsPdfPages: opts.ocrReadsPdfPages }),
  });
  let n = 0;
  async function upload(bytes: Uint8Array, ext = "pdf"): Promise<string> {
    const docId = `doc${++n}`;
    const s3Key = `uploads/${HH}/${docId}/original.${ext}`;
    await objectStore.put(s3Key, bytes);
    const doc: Doc = {
      id: docId,
      s3Key,
      filename: `x.${ext}`,
      docType: "other",
      status: "uploaded",
      uploadedAt: new Date(NOW).toISOString(),
      assetIds: [],
    };
    await repo.putDoc(HH, doc);
    return docId;
  }
  const run = async (bytes: Uint8Array, ext = "pdf") => {
    const docId = await upload(bytes, ext);
    await ingest({ householdId: HH, docId });
    return { docId, doc: (await repo.getDoc(HH, docId))!, agreements: await repo.listAgreements(HH, { docId }) };
  };
  return { repo, objectStore, indexStore, logs, ingest, upload, run };
}
