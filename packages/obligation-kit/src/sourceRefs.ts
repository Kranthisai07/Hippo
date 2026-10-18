// Hallucination guard (SPEC section 7 step 4): an extracted field only survives if the quote it cites is really
// on the page it cites. Pure and deterministic. Page text is untrusted data and is only compared, never interpreted.

export interface SourceRef {
  page: number;
  quote: string;
}

/** Page text as read from the document. OCR pages get a small tolerance because OCR drops and swaps letters. */
export type PageText = string | { text: string; ocr?: boolean };

export type RejectReason = "missing_source_ref" | "page_out_of_range" | "empty_quote" | "quote_not_found";

/** No quote here on purpose: it is document text, which must not end up in logs. */
export interface Rejection {
  path: string;
  reason: RejectReason;
  page?: number;
}

/** A quote shorter than this (letters and digits only) matches almost anywhere, so it proves nothing. */
const MIN_QUOTE = 4;
/** Share of a quote that OCR may get wrong. Text layer pages get none. */
const OCR_TOLERANCE = 0.05;
const OCR_MIN_LENGTH = 20;

/** Case, spacing, line breaks, hyphenation, smart quotes and ligatures all fold away. Letters and digits stay. */
const fold = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";

/**
 * Can `pattern` be found in `text` with at most `max` edits? Digits are never forgiven: a changed, added or dropped
 * digit costs more than the allowance, so "thirty (30) days" cannot pass for "sixty (60) days".
 */
function withinEdits(pattern: string, text: string, max: number): boolean {
  const m = pattern.length;
  const cap = max + 1;
  const step = (c: string | undefined): number => (isDigit(c) ? cap : 1);
  let prev: number[] = [0];
  for (let i = 1; i <= m; i++) prev[i] = Math.min(cap, (prev[i - 1] ?? 0) + step(pattern[i - 1]));
  for (const c of text) {
    const cur: number[] = [0]; // a match may start anywhere in the text
    for (let i = 1; i <= m; i++) {
      const p = pattern[i - 1];
      const sub = p === c ? 0 : isDigit(p) || isDigit(c) ? cap : 1;
      cur[i] = Math.min(cap, (prev[i - 1] ?? cap) + sub, (prev[i] ?? cap) + step(c), (cur[i - 1] ?? cap) + step(p));
    }
    if ((cur[m] ?? cap) <= max) return true;
    prev = cur;
  }
  return false;
}

interface Folded {
  text: string;
  ocr: boolean;
}

const foldPage = (p: PageText): Folded =>
  typeof p === "string" ? { text: fold(p), ocr: false } : { text: fold(p.text), ocr: p.ocr === true };

function found(quote: string, page: Folded): boolean {
  if (page.text.includes(quote)) return true;
  if (!page.ocr || quote.length < OCR_MIN_LENGTH) return false;
  return withinEdits(quote, page.text, Math.floor(quote.length * OCR_TOLERANCE));
}

/** True when the quote is on that page (text compared after folding). Fuzzy only for OCR pages. */
export function quoteOnPage(quote: string, page: PageText): boolean {
  const q = fold(quote);
  return q.length >= MIN_QUOTE && found(q, foldPage(page));
}

const REMOVED = Symbol("removed");

/**
 * Walks extracted fields and drops every leaf `{value, sourceRef: {page, quote}}` whose quote is not on its page.
 * A failed object field becomes null and a failed array item is removed. A leaf with a value but no usable source
 * is dropped too: missing beats guessed. A null value needs no source. The input is not changed.
 */
export function verifySourceRefs<T>(fields: T, pages: PageText[]): { fields: T; rejected: Rejection[] } {
  const folded = pages.map(foldPage);
  const rejected: Rejection[] = [];

  const checkLeaf = (leaf: Record<string, unknown>, path: string): unknown => {
    if (leaf.value === null || leaf.value === undefined) return structuredClone(leaf);
    const ref = leaf.sourceRef as Partial<SourceRef> | null | undefined;
    const reject = (reason: RejectReason, page?: number) => {
      rejected.push({ path, reason, ...(page === undefined ? {} : { page }) });
      return REMOVED;
    };
    if (!ref || typeof ref.quote !== "string" || !Number.isInteger(ref.page)) return reject("missing_source_ref");
    const page = folded[(ref.page as number) - 1];
    if (!page) return reject("page_out_of_range", ref.page);
    const quote = fold(ref.quote);
    if (quote.length < MIN_QUOTE) return reject("empty_quote", ref.page);
    return found(quote, page) ? structuredClone(leaf) : reject("quote_not_found", ref.page);
  };

  const walk = (node: unknown, path: string): unknown => {
    if (Array.isArray(node)) return node.map((v, i) => walk(v, `${path}[${i}]`)).filter((v) => v !== REMOVED);
    if (node && typeof node === "object") {
      const o = node as Record<string, unknown>;
      if ("value" in o || "sourceRef" in o) return checkLeaf(o, path);
      return Object.fromEntries(
        Object.entries(o).map(([k, v]) => {
          const r = walk(v, path ? `${path}.${k}` : k);
          return [k, r === REMOVED ? null : r];
        }),
      );
    }
    return node;
  };

  const out = walk(fields, "");
  return { fields: (out === REMOVED ? null : out) as T, rejected };
}
