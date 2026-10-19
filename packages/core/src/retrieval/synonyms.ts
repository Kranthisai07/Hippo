import { contentStems, stem, tokenize, STOP_WORDS } from "./text";

/**
 * The ONLY synonym table. Each row is a group of phrases that people use interchangeably when they talk about
 * the same clause in the demo vocabulary. If a query contains any phrase of a group, the words of the other
 * phrases are added to the query as extra, non prefix terms. Matching is on stemmed words with stop words
 * removed, so "break the lease" and "breaking a lease" are the same phrase. Keep rows short and specific:
 * every row widens recall and can cost precision.
 */
export const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ["leak", "water damage", "flood", "burst pipe"],
  ["break the lease", "early termination", "terminate", "end the lease", "cancel the lease"],
  ["cancel", "cancellation", "unsubscribe"],
  ["renew", "renewal", "auto renew"],
  ["claim", "file a claim", "report a loss"],
  ["deductible", "out of pocket"],
  ["notice", "notify"],
];

interface CompiledGroup {
  phrases: { stems: string[]; words: string[] }[];
}

const COMPILED: CompiledGroup[] = SYNONYM_GROUPS.map((g) => ({
  phrases: g.map((p) => {
    const words = tokenize(p).filter((w) => !STOP_WORDS.has(w));
    return { stems: words.map(stem), words };
  }),
}));

function containsRun(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/** Extra query words implied by the synonym table, excluding words the query already contains. */
export function expandQuery(query: string): string[] {
  const qStems = contentStems(query);
  const have = new Set(qStems);
  const extra: string[] = [];
  for (const group of COMPILED) {
    if (!group.phrases.some((p) => containsRun(qStems, p.stems))) continue;
    for (const p of group.phrases) {
      for (let i = 0; i < p.words.length; i++) {
        const s = p.stems[i]!;
        if (have.has(s)) continue;
        have.add(s);
        extra.push(p.words[i]!);
      }
    }
  }
  return extra;
}
