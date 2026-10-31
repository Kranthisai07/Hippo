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
// Known limit, time and memory: pdf.js runs in this thread and its work inside one call cannot be interrupted, so
// neither the byte cap nor the deadline bounds time or memory by itself. What bounds the heavy inputs is the linear
// pre-scan below, which inflates every zlib looking stream under hard caps BEFORE pdf.js runs and rejects bombs as
// too_large. The deadline is real only between pages (the loop yields to the event loop and checks it). The ingest
// Lambda memory and timeout are the final backstop, and a crash or timeout there must mark the document failed.
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
  constructor(
    readonly code: PdfErrorCode,
    message: string,
  ) {
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
// no way to count the real tree. So one linear pass over the single copy of the input counts page objects in the raw
// bytes and in flate object streams, and extractPages requires the count to equal numPages.
// shortcut: counts page objects textually, so an incrementally updated file that keeps a superseded page object
// over counts and is rejected as corrupt (fails closed); upgrade to a real tree walk if that bites.
const PER_STREAM_CAP = 64 * 1024 * 1024;
const TOTAL_CAP = 256 * 1024 * 1024;
const MAX_STREAMS = 200_000; // `stream` keywords examined
const MAX_INFLATES = 5_000; // zlib looking streams we attempt
const DICT_LOOKBACK = 4096; // shortcut: only this many bytes of a stream dictionary are read, from its tail

const isWs = (c: number): boolean => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
const isDelim = (c: number): boolean =>
  isWs(c) ||
  c === 0x2f ||
  c === 0x25 ||
  c === 0x28 ||
  c === 0x29 ||
  c === 0x3c ||
  c === 0x3e ||
  c === 0x5b ||
  c === 0x5d ||
  c === 0x7b ||
  c === 0x7d;
const hexVal = (c: number | undefined): number =>
  c === undefined
    ? -1
    : c >= 0x30 && c <= 0x39
      ? c - 0x30
      : c >= 0x41 && c <= 0x46
        ? c - 0x37
        : c >= 0x61 && c <= 0x66
          ? c - 0x57
          : -1;

/** Reads the name after the slash at `i`, decoding #xx escapes; null when longer than 16 bytes. `end` is the next unread offset. */
function readName(b: Buffer, i: number): { name: string; end: number } | null {
  let name = "";
  let j = i + 1;
  while (j < b.length && !isDelim(b[j]!)) {
    if (name.length >= 16) return null;
    if (b[j] === 0x23) {
      const h1 = hexVal(b[j + 1]);
      const h2 = hexVal(b[j + 2]);
      if (h1 >= 0 && h2 >= 0) {
        name += String.fromCharCode(h1 * 16 + h2);
        j += 3;
        continue;
      }
    }
    name += String.fromCharCode(b[j]!);
    j++;
  }
  return { name, end: j };
}

/** Counts `/Type /Page` (not /Pages) allowing whitespace, comments and #xx escapes the way pdf.js reads them. One forward pass. */
function countPageObjects(b: Buffer): number {
  let n = 0;
  let i = b.indexOf(0x2f);
  while (i >= 0) {
    const t = readName(b, i);
    let next = i + 1;
    if (t) {
      next = Math.max(next, t.end);
      if (t.name === "Type") {
        let j = t.end;
        for (;;) {
          while (j < b.length && isWs(b[j]!)) j++;
          if (b[j] !== 0x25) break;
          while (j < b.length && b[j] !== 0x0a && b[j] !== 0x0d) j++; // comment runs to end of line
        }
        next = Math.max(next, j);
        if (b[j] === 0x2f) {
          const v = readName(b, j);
          if (v && v.name === "Page") n++;
          if (v) next = Math.max(next, v.end);
        }
      }
    }
    i = b.indexOf(0x2f, next);
  }
  return n;
}

interface Scan {
  pages: number;
  /** An object stream we could not read, so page objects inside it are invisible to the count. */
  opaqueObjStm: boolean;
}

const unescapeNames = (s: string): string =>
  s.replace(/#([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

/**
 * The zlib header test zlib and pdf.js both apply: deflate method, a window size of at most 32 KB, a header checksum divisible by 31 and no
 * preset dictionary. Matching only the four common headers (78 01, 78 5e, 78 9c, 78 da) let a bomb behind 68 DE reach pdf.js unchecked.
 */
const looksZlib = (b0: number | undefined, b1: number | undefined): boolean =>
  b0 !== undefined &&
  b1 !== undefined &&
  (b0 & 0x0f) === 8 &&
  b0 >> 4 <= 7 &&
  ((b0 << 8) | b1) % 31 === 0 &&
  (b1 & 0x20) === 0;

/** Walks the file once, strictly forward. Throws too_large when decoding would exceed the caps. Never touches pdf.js. */
function prescan(b: Buffer): Scan {
  const scan: Scan = { pages: countPageObjects(b), opaqueObjStm: false };
  let total = 0;
  let inflates = 0;
  let seen = 0;
  let from = 0; // end of the previous stream: dictionaries are read between here and the next keyword
  let kw = b.indexOf("stream", 0, "latin1");
  while (kw >= 0) {
    const eol = b[kw + 6];
    const isKeyword = (eol === 0x0a || eol === 0x0d) && !(kw >= 3 && b.toString("latin1", kw - 3, kw) === "end");
    let next = kw + 6;
    if (isKeyword) {
      if (++seen > MAX_STREAMS) throw new PdfError("too_large", "too many streams");
      let after = kw + 6;
      if (b[after] === 0x0d) after++;
      if (b[after] === 0x0a) after++;
      const dict = unescapeNames(b.toString("latin1", Math.max(from, kw - DICT_LOOKBACK), kw));
      const isObjStm = dict.includes("/ObjStm");
      // Trust a direct /Length when endstream follows it, so "endstream" bytes inside the data cannot cut a stream short.
      let end = -1;
      const len = /\/Length\s+(\d+)(?!\d|\s+\d+\s+R)/.exec(dict.slice(dict.lastIndexOf("<<")))?.[1];
      if (len !== undefined && after + Number(len) <= b.length) {
        let k = after + Number(len);
        while (k < b.length && isWs(b[k]!)) k++;
        if (b.toString("latin1", k, k + 9) === "endstream") end = after + Number(len);
      }
      if (end < 0) {
        end = b.indexOf("endstream", after, "latin1");
        if (end < 0) end = b.length;
      }
      if (looksZlib(b[after], b[after + 1])) {
        if (++inflates > MAX_INFLATES) throw new PdfError("too_large", "too many compressed streams");
        try {
          const out = inflateSync(b.subarray(after, end), { maxOutputLength: PER_STREAM_CAP });
          total += out.length;
          if (isObjStm) scan.pages += countPageObjects(out);
        } catch (e) {
          if ((e as { code?: string }).code === "ERR_BUFFER_TOO_LARGE")
            throw new PdfError("too_large", "stream decodes past the cap");
          total += Math.max(1, end - after); // a failed inflate still costs budget
          if (isObjStm) scan.opaqueObjStm = true;
        }
        if (total > TOTAL_CAP) throw new PdfError("too_large", "document decodes past the cap");
      } else if (isObjStm && dict.includes("/Filter")) scan.opaqueObjStm = true; // ASCIIHex, LZW, a chain: not readable here
      next = Math.max(end, after);
      from = next;
    }
    kw = b.indexOf("stream", next, "latin1");
  }
  return scan;
}

export async function extractPages(input: Uint8Array, opts: ExtractOptions = {}): Promise<ExtractResult> {
  if (input.length === 0) throw new PdfError("empty", "no bytes");
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  if (input.length > maxBytes) throw new PdfError("too_large", `${input.length} bytes, cap is ${maxBytes}`);
  // One real copy, made before the first await: the pre-scan and pdf.js see the same bytes even if the caller reuses
  // or zeroes its buffer, and a Node Buffer becomes the plain Uint8Array pdf.js demands.
  const bytes = new Uint8Array(input);
  // Rule: a %PDF- header in the first KB wins, so a JPEG or PNG prefix cannot hide a text layer behind "image".
  // Otherwise an image needs its full signature at byte 0. Known but unread formats are "unsupported"; the rest "not_pdf".
  if (!hasPdfHeader(bytes)) {
    if (isImage(bytes)) return { kind: "image", pages: [makePage(1, "")] };
    throw new PdfError(isUnsupported(bytes) ? "unsupported" : "not_pdf", "not a readable PDF or image");
  }

  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  // Bounds decompression work for pdf.js and counts page objects; throws too_large before pdf.js sees the bytes.
  const scan = prescan(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length));
  const timers = opts.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  };
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

  // pdf.js may take ownership of the buffer; that is fine, the pre-scan above has finished with it.
  // isEvalSupported does not exist in 6.4.299, so there is no eval switch to turn off. maxImageSize caps decoded
  // image pixels; text extraction never decodes images, so this is defence in depth.
  const task = pdfjs.getDocument({
    data: bytes,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
    maxImageSize: 16 * 1024 * 1024,
    enableXfa: false,
    disableFontFace: true,
    useSystemFonts: false,
  });
  try {
    const doc = await guard(task.promise);
    if (doc.numPages > maxPages) throw new PdfError("too_many_pages", `${doc.numPages} pages, cap is ${maxPages}`);
    // The scan must equal /Count. Over: a lying or superseded tree. Under: the scan could not see the structure
    // (object streams it cannot read, odd generators), so a truncated page set is possible: refuse.
    if (scan.pages > doc.numPages) {
      throw scan.pages > maxPages
        ? new PdfError("too_many_pages", `${scan.pages} page objects, cap is ${maxPages}`)
        : new PdfError("corrupt", "page tree disagrees with /Count");
    }
    if (scan.pages < doc.numPages || scan.opaqueObjStm)
      throw new PdfError("unsupported", "page structure cannot be verified");
    const pages: Page[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      // A page whose content stream is corrupt yields empty text, so it is flagged needsOcr just like a scanned page.
      // That is deliberate: numbers stay aligned and OCR is attempted, but the two cases are not distinguishable here.
      await new Promise((r) => setImmediate(r)); // lets timers run: the deadline is only observable between pages
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
