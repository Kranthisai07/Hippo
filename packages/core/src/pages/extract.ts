// Per page text for the ingest worker (SPEC section 7 step 1). Fails closed: any problem throws a PdfError and
// nothing partial is returned. Page text is untrusted data, so it is only joined, never interpreted, and never logged.
//
// Library: pdfjs-dist, the one SPEC suggests. Its legacy build runs on Node 22 with no canvas and no worker file
// (text extraction does not render; pdf.js falls back to an in-thread worker), and its text items carry hasEOL
// flags for rebuilding lines.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

/** A page whose trimmed text layer is shorter than this is treated as scanned and sent to OCR (SPEC section 7). */
export const OCR_MIN_CHARS = 50;
/** Cost guard from SPEC section 7: pages per document. */
export const DEFAULT_MAX_PAGES = 40;

export type PdfErrorCode = "not_pdf" | "corrupt" | "encrypted" | "too_many_pages" | "empty";

export class PdfError extends Error {
  constructor(readonly code: PdfErrorCode, message: string) {
    super(message);
    this.name = "PdfError";
  }
}

export interface Page {
  /** 1 based and stable: this is the citation page number. */
  number: number;
  text: string;
  needsOcr: boolean;
}

export interface ExtractResult {
  kind: "pdf" | "image";
  pages: Page[];
}

export interface ExtractOptions {
  maxPages?: number;
}

const ascii = (b: Uint8Array, start: number, s: string): boolean =>
  b.length >= start + s.length && [...s].every((c, i) => b[start + i] === c.charCodeAt(0));

// HEIF brands that phones write for photos. Other ftyp files (mp4, mov) are not images.
const HEIC_BRANDS = ["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1"];

function isImage(b: Uint8Array): boolean {
  if (b[0] === 0x89 && ascii(b, 1, "PNG")) return true;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;
  return ascii(b, 4, "ftyp") && HEIC_BRANDS.some((brand) => ascii(b, 8, brand));
}

// Browsers and readers accept a header within the first KB; stricter would reject real files with leading junk.
function hasPdfHeader(b: Uint8Array): boolean {
  const end = Math.min(b.length, 1024) - 4;
  for (let i = 0; i <= end; i++) if (ascii(b, i, "%PDF-")) return true;
  return false;
}

function makePage(number: number, text: string): Page {
  return { number, text, needsOcr: text.trim().length < OCR_MIN_CHARS };
}

export async function extractPages(bytes: Uint8Array, opts: ExtractOptions = {}): Promise<ExtractResult> {
  if (bytes.length === 0) throw new PdfError("empty", "no bytes");
  if (isImage(bytes)) return { kind: "image", pages: [makePage(1, "")] };
  if (!hasPdfHeader(bytes)) throw new PdfError("not_pdf", "missing %PDF header");

  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  // pdf.js takes ownership of the buffer it is given, so hand it a copy.
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  });
  try {
    const doc = await task.promise;
    if (doc.numPages > maxPages) throw new PdfError("too_many_pages", `${doc.numPages} pages, cap is ${maxPages}`);
    const pages: Page[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const content = await (await doc.getPage(n)).getTextContent();
      pages.push(makePage(n, joinItems(content.items)));
    }
    return { kind: "pdf", pages };
  } catch (e) {
    if (e instanceof PdfError) throw e;
    const name = e instanceof Error ? e.name : "";
    if (name === "PasswordException") throw new PdfError("encrypted", "password protected");
    // Deliberately no cause or message: pdf.js messages can echo document content.
    throw new PdfError("corrupt", "unreadable PDF");
  } finally {
    await task.destroy();
  }
}

// Items are runs of text; hasEOL marks the end of a visual line. No spaces are invented between runs on one line
// because downstream matching folds spacing anyway.
function joinItems(items: ReadonlyArray<unknown>): string {
  let out = "";
  for (const it of items) {
    const item = it as { str?: string; hasEOL?: boolean };
    if (typeof item.str !== "string") continue;
    out += item.str;
    if (item.hasEOL) out += "\n";
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}
