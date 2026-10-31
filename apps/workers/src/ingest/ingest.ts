// The real ingest (SPEC section 7, T2.2): bytes in, a needs_review document out. Every collaborator that could reach the
// network is injected, so the pipeline itself never does. Document text is untrusted data: it is read, quoted and
// matched, never obeyed, and never written to a log. Nothing here can set a field to `confirmed`.
import type { Doc, Repository } from "core/src/contracts";
import { extractPages, fillOcrPages, type Ocr, type Page } from "core/src/pages";
import { ExtractionSchemas, leavesToAgreementFields, verifySourceRefs, type AgreementKind } from "obligation-kit";
import { saveIngested, type IndexStore, type OnUploaded } from "../../../api/src/api/fixtureIngest";
import { maskNumbers } from "../../../api/src/mcp/speak";
import type { ObjectStore } from "../../../api/src/api/storage";
import { BAD_OUTPUT, FILE_MISSING, NO_TEXT, PICTURE_PAGES, reasonFor } from "./reasons";
import { IngestFailure, type Extractor } from "./types";

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

/** One model retry on invalid output, then give up (SPEC section 7 step 3). */
export const MAX_EXTRACT_ATTEMPTS = 2;

/** Masks long numbers in every stored quote (INTENT principle 7). Runs after the quote check, which needs the full text. */
function maskQuotes(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(maskQuotes);
  if (node && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node).map(([k, v]) => [
        k,
        k === "sourceRef" && v && typeof (v as { quote?: unknown }).quote === "string"
          ? { ...v, quote: maskNumbers((v as { quote: string }).quote) }
          : maskQuotes(v),
      ]),
    );
  }
  return node;
}

export type ReadPage = Pick<Page, "number" | "text" | "ocrDone">;
export type PagesDeps = Pick<IngestDeps, "repo" | "objectStore" | "indexStore" | "extractor" | "now" | "log">;

/** Page text in, a needs_review document out. The part of ingest that does not care where the text came from. */
export function createPagesIngest(deps: PagesDeps) {
  const { extractor } = deps;
  const log = deps.log ?? (() => undefined);

  async function extractValid(kind: AgreementKind, pages: Parameters<Extractor["extract"]>[1]) {
    for (let attempt = 1; attempt <= MAX_EXTRACT_ATTEMPTS; attempt++) {
      const parsed = ExtractionSchemas[kind].safeParse(await extractor.extract(kind, pages));
      if (parsed.success) return parsed.data as Record<string, unknown>;
      log(`ingest: attempt ${attempt} gave output that does not fit the ${kind} schema`);
    }
    throw new IngestFailure(BAD_OUTPUT);
  }

  return async function ingestPages(hh: string, doc: Doc, pages: ReadPage[]): Promise<void> {
    if (pages.every((p) => p.text.trim() === "")) throw new IngestFailure(NO_TEXT);

    const kind = await extractor.classify(pages);
    if (kind === "other") {
      await saveIngested(deps, {
        householdId: hh,
        doc,
        kind,
        flat: null,
        pages: pages.map((p) => p.text),
        agreementId: "",
      });
      return;
    }
    const parsed = await extractValid(kind, pages);
    const { fields, rejected } = verifySourceRefs(
      parsed,
      pages.map((p) => ({ text: p.text, ocr: p.ocrDone })),
    );
    if (rejected.length > 0)
      log(
        `ingest ${doc.id}: dropped ${rejected.length} field(s) whose quote was not on the cited page: ${rejected.map((r) => r.path).join(", ")}`,
      );

    await saveIngested(deps, {
      householdId: hh,
      doc,
      kind,
      flat: leavesToAgreementFields(kind, maskQuotes(fields) as Record<string, unknown>),
      pages: pages.map((p) => p.text),
      // One agreement per document, so a second run overwrites instead of duplicating.
      agreementId: `agr-${doc.id}`,
    });
  };
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
