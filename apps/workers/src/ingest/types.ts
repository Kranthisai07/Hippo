import type { Page } from "core/src/pages";
import type { AgreementKind } from "obligation-kit";

/** What classification may answer. `other` is stored and searchable, with no agreement and no deadlines. */
export type Kind = AgreementKind | "other";

/** The page text handed to a model: untrusted data, one entry per page, page 1 first. */
export type ExtractorPage = Pick<Page, "number" | "text">;

/**
 * Reads a document. Injected so the pipeline never owns a network client. `extract` returns whatever the reader
 * produced (parsed JSON, or the raw string if it was not JSON): the pipeline validates it, the reader never judges it.
 */
export interface Extractor {
  classify(pages: ExtractorPage[]): Promise<Kind>;
  extract(kind: AgreementKind, pages: ExtractorPage[]): Promise<unknown>;
}

/**
 * An error whose message is already a plain sentence for the person. Only this class (and PdfError) is ever shown;
 * any other thrown error becomes the generic failure so no message, stack or document text can leak.
 */
export class IngestFailure extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "IngestFailure";
  }
}
