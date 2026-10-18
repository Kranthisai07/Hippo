// Per page text for the ingest worker (SPEC section 7 step 1). Fails closed: any problem throws a PdfError and
// nothing partial is returned. Page text is untrusted data, so it is only joined, never interpreted, and never logged.
//
// Library: pdfjs-dist, the one SPEC suggests. Its legacy build runs on Node 22 with no canvas and no worker file
// (text extraction does not render; pdf.js falls back to an in-thread worker), and its text items carry hasEOL
// flags for rebuilding lines.
//
// Known limit, hidden text: pdf.js text extraction exposes no render mode or colour, so invisible text (Tr 3, white
// or clipped text) comes through exactly like visible text. A citation can therefore point at words a reader cannot
// see. This is one more reason page text is hostile data (INTENT principle 4): it is quoted and matched, never obeyed.
//
// Known limit, time: pdf.js runs in this thread, so a deadline can only fire between its async steps. The byte cap
// is the real bound on work; the deadline stops slow multi page documents and hung loads.
import { inflateSync } from "node:zlib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

/** A page with fewer than this many letters and digits in its text layer is treated as scanned and sent to OCR (SPEC section 7). */
export const OCR_MIN_CHARS = 50;
/** Cost guard from SPEC section 7: pages per document. */
export const DEFAULT_MAX_PAGES = 40;
/** Cost guard: input size in bytes, checked before any parsing. */
export const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
/** Cost guard: wall clock for load plus extraction. */
export const DEFAULT_TIMEOUT_MS = 10_000;

export type PdfErrorCode =
  | "not_pdf" // bytes that are neither a PDF nor a known format
  | "unsupported" // a known format we do not read (TIFF, GIF, WebP, SVG, ZIP, AVIF, mp4)
  | "corrupt"
  | "encrypted"
  | "too_many_pages"
  | "too_large"
  | "timeout"
  | "bad_ocr" // the injected OCR function returned something other than a string
  | "empty";

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
  /** The text layer was too short (see countsAsText). Stays true after OCR; check `ocrDone` for state. */
  needsOcr: boolean;
  /** True once `fillOcrPages` replaced the text with an OCR result. */
  ocrDone: boolean;
}

export interface ExtractResult {
  kind: "pdf" | "image";
  pages: Page[];
}

export interface ExtractOptions {
  maxPages?: number;
  maxBytes?: number;
  timeoutMs?: number;
  /** Injectable for tests. */
  timers?: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
}

const ascii = (b: Uint8Array, start: number, s: string): boolean =>
  b.length >= start + s.length && [...s].every((c, i) => b[start + i] === c.charCodeAt(0));

// HEIF brands that phones write for photos. Other ftyp files (mp4, mov, AVIF) are not images we read.
const HEIC_BRANDS = ["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1"];

function isImage(b: Uint8Array): boolean {
  if (ascii(b, 0, "\x89PNG\r\n\x1a\n")) return true;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;
  return ascii(b, 4, "ftyp") && HEIC_BRANDS.some((brand) => ascii(b, 8, brand));
}

// Formats we recognise but do not read. Checked after PDF and image, so they get a clearer code than not_pdf.
function isUnsupported(b: Uint8Array): boolean {
  if (ascii(b, 0, "II*\0") || ascii(b, 0, "MM\0*") || ascii(b, 0, "GIF8") || ascii(b, 0, "PK\x03\x04")) return true;
  if (ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) return true;
  if (ascii(b, 4, "ftyp")) return true; // mp4, mov, AVIF: any brand that was not HEIC
  const head = Buffer.from(b.subarray(0, 1024)).toString("latin1");
  return /^(\xef\xbb\xbf)?\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)?<svg[\s>]/i.test(head);
}

// Browsers and readers accept a header within the first KB; stricter would reject real files with leading junk.
function hasPdfHeader(b: Uint8Array): boolean {
  const end = Math.min(b.length, 1024) - 4;
  for (let i = 0; i <= end; i++) if (ascii(b, i, "%PDF-")) return true;
  return false;
}

/** Letters and digits only: trim() keeps zero width characters, controls and bare combining marks. */
export function countsAsText(text: string): number {
  return text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
}

function makePage(number: number, text: string): Page {
  return { number, text, needsOcr: countsAsText(text) < OCR_MIN_CHARS, ocrDone: false };
}

// pdf.js trusts /Count for numPages and walks the tree by it, so a lying /Count silently drops pages, and it offers
// no way to count the real tree (getPage(numPages + 1) is refused client side, and the worker side lookup skips
// pages by /Count too). So count page objects in the raw bytes, including flate object streams, and compare.
// shortcut: counts /Type /Page textually, so an incrementally updated file that keeps a superseded page object
// over counts and is rejected (fails closed); upgrade to a real tree walk if that bites.
const OBJSTM_BUDGET = 64 * 1024 * 1024;
function rawPageCount(bytes: Uint8Array): number {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  const text = buf.toString("latin1");
  const re = /\/Type\s*\/Page(?![A-Za-z])/g;
  let n = text.match(re)?.length ?? 0;
  let budget = OBJSTM_BUDGET;
  for (const m of text.matchAll(/\/Type\s*\/ObjStm/g)) {
    const kw = text.indexOf("stream", m.index);
    const end = kw < 0 ? -1 : text.indexOf("endstream", kw);
    if (end < 0 || budget <= 0) continue;
    let start = kw + 6;
    if (text[start] === "\r") start++;
    if (text[start] === "\n") start++;
    try {
      const out = inflateSync(buf.subarray(start, end), { maxOutputLength: Math.min(budget, 16 * 1024 * 1024) });
      budget -= out.length;
      n += out.toString("latin1").match(re)?.length ?? 0;
    } catch {
      // Not flate or too big: pdf.js may still read it, but we cannot count inside it.
    }
  }
  return n;
}

export async function extractPages(bytes: Uint8Array, opts: ExtractOptions = {}): Promise<ExtractResult> {
  if (bytes.length === 0) throw new PdfError("empty", "no bytes");
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  if (bytes.length > maxBytes) throw new PdfError("too_large", `${bytes.length} bytes, cap is ${maxBytes}`);
  // Rule: a %PDF- header in the first KB wins, so a JPEG or PNG prefix cannot hide a text layer behind "image".
  // Otherwise an image needs its full signature at byte 0. Known but unread formats are "unsupported"; the rest "not_pdf".
  if (!hasPdfHeader(bytes)) {
    if (isImage(bytes)) return { kind: "image", pages: [makePage(1, "")] };
    throw new PdfError(isUnsupported(bytes) ? "unsupported" : "not_pdf", "not a readable PDF or image");
  }

  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const timers = opts.timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) };
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let handle: unknown;
  const deadline = new Promise<never>((_, reject) => {
    handle = timers.setTimeout(() => reject(new PdfError("timeout", `over ${timeoutMs} ms`)), timeoutMs);
  });
  deadline.catch(() => {});
  const guard = <T>(p: Promise<T>): Promise<T> => {
    p.catch(() => {}); // an abandoned pdf.js promise must not become an unhandled rejection
    return Promise.race([p, deadline]);
  };

  // pdf.js takes ownership of the buffer it is given, so hand it a copy.
  // isEvalSupported does not exist in 6.4.299, so there is no eval switch to turn off. maxImageSize caps decoded
  // image pixels; text extraction never decodes images, so this is defence in depth.
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    verbosity: pdfjs.VerbosityLevel.ERRORS,
    maxImageSize: 16 * 1024 * 1024,
    enableXfa: false,
    disableFontFace: true,
    useSystemFonts: false,
  });
  try {
    const doc = await guard(task.promise);
    if (doc.numPages > maxPages) throw new PdfError("too_many_pages", `${doc.numPages} pages, cap is ${maxPages}`);
    const real = rawPageCount(bytes);
    if (real > doc.numPages) {
      throw real > maxPages
        ? new PdfError("too_many_pages", `${real} page objects, cap is ${maxPages}`)
        : new PdfError("corrupt", "page tree disagrees with /Count");
    }
    const pages: Page[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      // A page whose content stream is corrupt yields empty text, so it is flagged needsOcr just like a scanned page.
      // That is deliberate: numbers stay aligned and OCR is attempted, but the two cases are not distinguishable here.
      const content = await guard((await guard(doc.getPage(n))).getTextContent());
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
    timers.clearTimeout(handle);
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
