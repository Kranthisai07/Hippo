/**
 * A retrievable piece of one document page.
 *
 * `text` and `heading` are DOCUMENT TEXT: untrusted data. They are returned exactly as extracted and must be
 * treated as quoted material by any caller, never as instructions to a model.
 */
export interface Chunk {
  /** `docId:page:index`, where index counts chunks within the page from 0. */
  id: string;
  docId: string;
  /** 1 based page number the text came from. A chunk never spans pages. */
  page: number;
  text: string;
  wordCount: number;
  /** The clause or section heading line this chunk sits under, when the page had one. */
  heading?: string;
}

export interface PageInput {
  page: number;
  text: string;
}

export const TARGET_WORDS = 120;
export const HARD_MAX_WORDS = 200;
/** A numbered line ("1. Stop using") only starts a new chunk once the current one has this many words. */
const NUMBERED_SPLIT_MIN_WORDS = 60;

const SECTION_RE = /^(?:section|article|clause|part|schedule|exhibit)\s+(?:\d+|[ivxlc]+\b)/i;
const NUMBERED_RE = /^\d{1,3}[.)]\s+\S/;

function countWords(s: string): number {
  let n = 0;
  const re = /\S+/g;
  while (re.exec(s) !== null) n++;
  return n;
}

function isHeading(trimmed: string): boolean {
  if (SECTION_RE.test(trimmed)) return true;
  if (trimmed.length > 80 || countWords(trimmed) > 12) return false;
  if (trimmed.endsWith(":")) return true;
  return trimmed !== trimmed.toLowerCase() && trimmed === trimmed.toUpperCase();
}

/** Linear time sentence split: a sentence ends at . ! ? followed by whitespace or the end of the text. */
function sentences(s: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if ((c === "." || c === "!" || c === "?") && (i + 1 === s.length || /\s/.test(s[i + 1]!))) {
      out.push(s.slice(start, i + 1));
      start = i + 1;
      while (start < s.length && /\s/.test(s[start]!)) start++;
      i = start - 1;
    }
  }
  if (start < s.length) out.push(s.slice(start));
  return out;
}

function splitByWords(s: string, size: number): string[] {
  const out: string[] = [];
  const re = /\S+/g;
  let first = -1;
  let end = 0;
  let n = 0;
  for (let m = re.exec(s); m !== null; m = re.exec(s)) {
    if (n === 0) first = m.index;
    end = m.index + m[0].length;
    if (++n === size) {
      out.push(s.slice(first, end));
      n = 0;
    }
  }
  if (n > 0) out.push(s.slice(first, end));
  return out;
}

/** Break one line into units of at most HARD_MAX_WORDS: sentences packed to the target, then words. */
function expandLine(line: string): string[] {
  if (countWords(line) <= HARD_MAX_WORDS) return [line];
  const out: string[] = [];
  let cur: string[] = [];
  let curWords = 0;
  const flush = () => {
    if (cur.length > 0) out.push(cur.join(" "));
    cur = [];
    curWords = 0;
  };
  for (const sentence of sentences(line)) {
    const w = countWords(sentence);
    if (w > HARD_MAX_WORDS) {
      flush();
      out.push(...splitByWords(sentence, TARGET_WORDS));
      continue;
    }
    if (curWords + w > TARGET_WORDS) flush();
    cur.push(sentence);
    curWords += w;
  }
  flush();
  return out;
}

function chunkPage(docId: string, page: number, text: string, out: Chunk[]): void {
  let heading: string | undefined;
  let buf: string[] = [];
  let bufWords = 0;
  let index = 0;

  const flush = () => {
    const body = buf.join("\n").trim();
    buf = [];
    bufWords = 0;
    if (body === "") return;
    const chunk: Chunk = { id: `${docId}:${page}:${index++}`, docId, page, text: body, wordCount: countWords(body) };
    if (heading !== undefined) chunk.heading = heading;
    out.push(chunk);
  };

  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed === "") {
      flush();
      heading = undefined;
      continue;
    }
    if (isHeading(trimmed)) {
      flush();
      heading = trimmed;
    } else if (NUMBERED_RE.test(trimmed) && bufWords >= NUMBERED_SPLIT_MIN_WORDS) {
      flush();
    }
    for (const unit of expandLine(raw)) {
      const w = countWords(unit);
      if (buf.length > 0 && bufWords + w > TARGET_WORDS) flush();
      buf.push(unit);
      bufWords += w;
    }
  }
  flush();
}

/**
 * Split extracted page text into clause sized chunks. Pure and deterministic. Blank lines, section headings,
 * ALL CAPS lines and lines ending with a colon always start a new chunk; numbered list items start one only once
 * the current chunk is half full, so claim steps stay with their heading. Chunks are packed to about 120 words and
 * never exceed 200. Pages are never merged and pages without text produce no chunks.
 */
export function chunkPages(docId: string, pages: readonly PageInput[]): Chunk[] {
  const out: Chunk[] = [];
  for (const p of pages) chunkPage(docId, p.page, p.text, out);
  return out;
}
