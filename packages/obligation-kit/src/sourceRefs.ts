// Hallucination guard (SPEC section 7 step 4): an extracted field only survives if the quote it cites is really
// on the page it cites. Pure and deterministic. Page text is untrusted data and is only compared, never interpreted.
//
// What this proves: the words of the quote are on that page. It does not prove the value is a correct reading of the
// quote, and a quote that starts mid-sentence ("be refunded" from "cannot be refunded") is still on the page.

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

/** A quote with fewer letters and digits than this matches almost anywhere, so it proves nothing. */
const MIN_QUOTE = 4;
/** Share of a quote that OCR may get wrong. Text layer pages get none. */
const OCR_TOLERANCE = 0.05;
const OCR_MIN_LENGTH = 20;
/** Fuzzy matching costs quote length times page length, so a huge OCR page is matched exactly or not at all. */
const OCR_MAX_PAGE = 50_000;

/** Marks both ends of every run of digits, so 130 does not contain 30 and 1,000 is not 10,00 or 1.000. */
const BOUND = "\u0001";
const DIGITS = /\p{N}/u;

/** Case, spacing, line breaks, hyphenation, smart quotes and ligatures fold away. Letters stay; digits keep edges. */
const fold = (s: string): string =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll(BOUND, "")
    .replace(/\p{N}+/gu, (run) => `${BOUND}${run}${BOUND}`)
    .replace(/[^\p{L}\p{N}\u0001]+/gu, "");

/** Letters and digits in a folded string, without the boundary marks. */
const significant = (folded: string): number => folded.replaceAll(BOUND, "").length;

const isDigit = (c: string): boolean => c === BOUND || (c >= "0" && c <= "9") || (c > "\u007f" && DIGITS.test(c));

/**
 * Can `pattern` be found in `text` with at most `max` edits? A digit or a digit boundary is never forgiven: changing,
 * adding or dropping one costs more than the allowance, so "thirty (30) days" cannot pass for "sixty (60) days".
 */
function withinEdits(pattern: string, text: string, max: number): boolean {
  const m = pattern.length;
  const cap = max + 1;
  const hard = Array.from(pattern, isDigit);
  let prev = new Int32Array(m + 1);
  let cur = new Int32Array(m + 1);
  for (let i = 1; i <= m; i++) prev[i] = Math.min(cap, (prev[i - 1] ?? 0) + (hard[i - 1] ? cap : 1));
  for (let j = 0; j < text.length; j++) {
    const c = text[j] as string;
    const cHard = isDigit(c);
    cur[0] = 0; // a match may start anywhere in the text
    for (let i = 1; i <= m; i++) {
      const pHard = hard[i - 1] as boolean;
      const sub = pattern[i - 1] === c ? 0 : pHard || cHard ? cap : 1;
      cur[i] = Math.min(cap, (prev[i - 1] ?? cap) + sub, (prev[i] ?? cap) + (cHard ? cap : 1), (cur[i - 1] ?? cap) + (pHard ? cap : 1));
    }
    if ((cur[m] ?? cap) <= max) return true;
    [prev, cur] = [cur, prev];
  }
  return false;
}

interface Folded {
  text: string;
  ocr: boolean;
}

/** A page with no usable text folds to empty, so every quote on it is rejected instead of the call throwing. */
const foldPage = (p: PageText | null | undefined): Folded => {
  if (typeof p === "string") return { text: fold(p), ocr: false };
  if (p && typeof p.text === "string") return { text: fold(p.text), ocr: p.ocr === true };
  return { text: "", ocr: false };
};

function found(quote: string, page: Folded): boolean {
  if (page.text.includes(quote)) return true;
  const n = significant(quote);
  if (!page.ocr || n < OCR_MIN_LENGTH || page.text.length > OCR_MAX_PAGE) return false;
  return withinEdits(quote, page.text, Math.floor(n * OCR_TOLERANCE));
}

/** True when the quote is on that page (text compared after folding). Fuzzy only for OCR pages. */
export function quoteOnPage(quote: string, page: PageText): boolean {
  const q = fold(quote);
  return significant(q) >= MIN_QUOTE && found(q, foldPage(page));
}

const REMOVED = Symbol("removed");

/**
 * Walks extracted fields and drops every leaf `{value, sourceRef: {page, quote}}` whose quote is not on its page.
 * A failed object field becomes null and a failed array item is removed. A leaf with a value but no usable source
 * is dropped too: missing beats guessed. A kept leaf is rebuilt as just `{value, sourceRef}`, so nothing unchecked
 * can ride along beside a verified quote. A null value needs no source. The input is not changed.
 * The values themselves are not inspected: the extraction schema must be strict about what a value can hold.
 */
export function verifySourceRefs<T>(fields: T, pages: PageText[]): { fields: T; rejected: Rejection[] } {
  const folded = pages.map(foldPage);
  const rejected: Rejection[] = [];

  const checkLeaf = (leaf: Record<string, unknown>, path: string): unknown => {
    if (leaf.value === null || leaf.value === undefined) return { value: null };
    const ref = leaf.sourceRef as Partial<SourceRef> | null | undefined;
    const reject = (reason: RejectReason, page?: number) => {
      rejected.push({ path, reason, ...(page === undefined ? {} : { page }) });
      return REMOVED;
    };
    if (!ref || typeof ref.quote !== "string" || !Number.isInteger(ref.page)) return reject("missing_source_ref");
    const page = folded[(ref.page as number) - 1];
    if (!page) return reject("page_out_of_range", ref.page);
    const quote = fold(ref.quote);
    if (significant(quote) < MIN_QUOTE) return reject("empty_quote", ref.page);
    if (!found(quote, page)) return reject("quote_not_found", ref.page);
    return { value: structuredClone(leaf.value), sourceRef: { page: ref.page, quote: ref.quote } };
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
