// Same split as MiniSearch's default tokenizer so query analysis and the index agree on token boundaries.
const SPLIT_RE = /[\n\r\p{Z}\p{P}]+/u;

/** Query words that carry no meaning for clause lookup. Applied to the QUERY only, never to stored text. */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  "the",
  "a",
  "an",
  "of",
  "to",
  "and",
  "or",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "am",
  "in",
  "on",
  "at",
  "by",
  "for",
  "with",
  "from",
  "into",
  "as",
  "about",
  "than",
  "then",
  "my",
  "i",
  "me",
  "we",
  "our",
  "you",
  "your",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "what",
  "whats",
  "which",
  "who",
  "whom",
  "when",
  "where",
  "why",
  "how",
  "does",
  "do",
  "did",
  "doing",
  "done",
  "can",
  "could",
  "should",
  "would",
  "will",
  "shall",
  "may",
  "have",
  "has",
  "had",
  "having",
  "there",
  "any",
  "some",
  "if",
  "so",
  "tell",
  "say",
  "please",
]);

export const MAX_QUERY_CHARS = 1000;

export function tokenize(s: string): string[] {
  const out: string[] = [];
  for (const t of s.toLowerCase().split(SPLIT_RE)) if (t !== "") out.push(t);
  return out;
}

/**
 * Light suffix stripping so "leaking", "leaks" and "leaked" meet at "leak". Not a linguistic stemmer: it only has
 * to be the same function at index time and query time.
 */
export function stem(term: string): string {
  let t = term;
  if (t.length > 4 && t.endsWith("ies")) t = `${t.slice(0, -3)}y`;
  else if (t.length > 5 && t.endsWith("ing")) t = t.slice(0, -3);
  else if (t.length > 4 && t.endsWith("ed")) t = t.slice(0, -2);
  else if (t.length > 4 && t.endsWith("es") && /(?:s|x|z|ch|sh)es$/.test(t)) t = t.slice(0, -2);
  else if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") && !t.endsWith("us")) t = t.slice(0, -1);
  if (t.length > 3 && t.endsWith("e")) t = t.slice(0, -1);
  return t;
}

/** Stemmed, stop word free tokens of a string, in order. */
export function contentStems(s: string): string[] {
  const out: string[] = [];
  for (const t of tokenize(s)) if (!STOP_WORDS.has(t)) out.push(stem(t));
  return out;
}
