// The part of ingest that does not care where the text came from: page text in, a needs_review document out. It imports
// no PDF reader, so the extension's capture path (and a Workers build) does not carry one.
import type { Doc, Repository } from "core/src/contracts";
import type { Page } from "core/src/pages";
import { ExtractionSchemas, leavesToAgreementFields, verifySourceRefs, type AgreementKind } from "obligation-kit";
import { saveIngested, type IndexStore } from "../../../api/src/api/fixtureIngest";
import { maskNumbers } from "../../../api/src/mcp/speak";
import type { ObjectStore } from "../../../api/src/api/storage";
import { BAD_OUTPUT, NO_TEXT } from "./reasons";
import { IngestFailure, type Extractor } from "./types";

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
export interface PagesDeps {
  repo: Repository;
  objectStore: ObjectStore;
  indexStore?: IndexStore | undefined;
  extractor: Extractor;
  now: () => number;
  /** Counts and field names only. Never document text, quotes or values. */
  log?: (line: string) => void;
}

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
