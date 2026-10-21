import { PdfError, type PdfErrorCode } from "core/src/pages";
import { IngestFailure } from "./types";

// Every sentence here is shown to a person in the web app. Plain, specific, and never built from document text.

export const GENERIC_FAILURE = "We could not read this file. Try uploading it again.";
export const FILE_MISSING = "We could not find the uploaded file. Try uploading it again.";
export const PICTURE_PAGES = "Some pages are pictures. Upload photos of those pages as JPEG instead.";
export const BAD_OUTPUT = "We could not read the details in this document. Try uploading a clearer copy.";
export const NO_TEXT = "We could not find any readable text in this file. Try a clearer photo or scan.";

const PDF_REASONS: Record<PdfErrorCode, string> = {
  not_pdf: "This file is not a PDF or a photo we can read. Upload a PDF, JPEG or PNG.",
  unsupported: "We cannot read this kind of file. Print or re-save it as a PDF and upload it again.",
  corrupt: "This PDF looks damaged. Print or re-save the PDF and upload it again.",
  encrypted: "This PDF is password protected. Remove the password and upload it again.",
  too_many_pages: "This document has too many pages. Upload only the pages with the terms.",
  too_large: "This file is too large to read. Upload a smaller copy.",
  timeout: "This file took too long to read. Upload a smaller copy or fewer pages.",
  bad_ocr: GENERIC_FAILURE,
  empty: "This file has no pages. Upload a copy that opens with content.",
};

/** The sentence for a failure. Unknown errors get the generic one and are never inspected for their message. */
export function reasonFor(e: unknown): string {
  if (e instanceof IngestFailure) return e.reason;
  if (e instanceof PdfError) return PDF_REASONS[e.code] ?? GENERIC_FAILURE;
  return GENERIC_FAILURE;
}
