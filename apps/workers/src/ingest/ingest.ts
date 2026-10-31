// The real ingest (SPEC section 7, T2.2): bytes in, a needs_review document out. Every collaborator that could reach the
// network is injected, so the pipeline itself never does. Document text is untrusted data: it is read, quoted and
// matched, never obeyed, and never written to a log. Nothing here can set a field to `confirmed`.
import type { Doc, Repository } from "core/src/contracts";
import { extractPages, fillOcrPages, type Ocr } from "core/src/pages";
import type { IndexStore, OnUploaded } from "../../../api/src/api/fixtureIngest";
import type { ObjectStore } from "../../../api/src/api/storage";
import { FILE_MISSING, PICTURE_PAGES, reasonFor } from "./reasons";
import { IngestFailure, type Extractor } from "./types";
import { createPagesIngest, type ReadPage } from "./pagesIngest";

export { createPagesIngest, MAX_EXTRACT_ATTEMPTS, type PagesDeps, type ReadPage } from "./pagesIngest";

export interface IngestDeps {
  repo: Repository;
  objectStore: ObjectStore;
  indexStore?: IndexStore | undefined;
  ocr: Ocr;
  extractor: Extractor;
  now: () => number;
  /** Counts and field names only. Never document text, quotes or values. */
  log?: (line: string) => void;
  /** Cost guard (SPEC section 7): pages per document. Default is the core default. */
  maxPages?: number;
  /**
   * Whether `ocr` can read one page of a multi page PDF. False for Textract's synchronous call, which reads a whole
   * 1 page file only, so a multi page PDF with picture pages is refused with a plain reason.
   */
  ocrReadsPdfPages?: boolean;
}

export function createIngest(deps: IngestDeps): OnUploaded {
  const { repo, objectStore } = deps;
  const log = deps.log ?? (() => undefined);
  const ingestPages = createPagesIngest(deps);

  async function run(hh: string, doc: Doc): Promise<void> {
    const bytes = await objectStore.get(doc.s3Key);
    if (!bytes) throw new IngestFailure(FILE_MISSING);

    let result = await extractPages(bytes, deps.maxPages === undefined ? {} : { maxPages: deps.maxPages });
    if (result.pages.some((p) => p.needsOcr)) {
      if (result.kind === "pdf" && result.pages.length > 1 && !deps.ocrReadsPdfPages)
        throw new IngestFailure(PICTURE_PAGES);
      result = await fillOcrPages(result, deps.ocr, bytes);
    }
    await ingestPages(hh, doc, result.pages);
  }

  return async ({ householdId: hh, docId }) => {
    const doc = await repo.getDoc(hh, docId);
    if (!doc) return;
    // Already read (and maybe reviewed): a second run must not overwrite what a person has confirmed.
    if (doc.status === "needs_review" || doc.status === "active") return;
    const { failureReason: _old, ...clean } = doc;
    const extracting: Doc = { ...clean, status: "extracting" };
    await repo.putDoc(hh, extracting);
    try {
      await run(hh, extracting);
      log(`ingest ${docId}: needs_review`);
    } catch (e) {
      // A crash must never leave the document stuck in extracting.
      const reason = reasonFor(e);
      log(`ingest ${docId}: failed (${e instanceof Error ? e.name : "unknown"})`);
      await repo.putDoc(hh, { ...extracting, status: "failed", failureReason: reason });
    }
  };
}
