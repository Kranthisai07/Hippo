// OCR is injected so this module never touches AWS. The real Textract adapter belongs to a later task; its limits
// (sync image size and formats, async job needs for PDFs) are unverified and belong in docs/VERIFIED.md first.
import type { ExtractResult } from "./extract";

/** `image` is the page raster or the original image bytes; a fake in tests can ignore it. */
export type Ocr = (page: { number: number; image?: Uint8Array }) => Promise<string>;

/** Calls `ocr` once per page that needs it, in page order, and returns a new result with the same page numbers. */
export async function fillOcrPages(result: ExtractResult, ocr: Ocr, image?: Uint8Array): Promise<ExtractResult> {
  const pages = [];
  for (const p of result.pages) {
    if (!p.needsOcr) {
      pages.push(p);
      continue;
    }
    pages.push({ ...p, text: await ocr({ number: p.number, image }) });
  }
  return { ...result, pages };
}
