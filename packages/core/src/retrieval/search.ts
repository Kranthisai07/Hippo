import MiniSearch, { type Options, type SearchOptions } from "minisearch";
import type { Chunk } from "./chunk";
import { expandQuery } from "./synonyms";
import { contentStems, MAX_QUERY_CHARS, STOP_WORDS, stem, tokenize } from "./text";

/** A household with more chunks than this should be capped with `capChunks` before indexing (SPEC section 6). */
export const MAX_CHUNKS = 2000;

/**
 * Hits below this score are dropped so an off-topic question returns an empty list ("nothing relevant found").
 * Calibrated on the 17 chunks of the six demo documents with minScore 0: weak lexical coincidences scored 1.7 to
 * 2.1 ("when does my warranty expire", "what is the date today"), the weakest genuine one word or two word
 * questions 2.3 to 2.5 ("dishwasher", "how much is rent"), full questions 4 to 120. Off-topic questions with no
 * shared word score nothing at all. BM25+ idf grows with corpus size, so a larger household only scores higher.
 * It is an absolute score: a household with one or two documents scores low and needs a lower value.
 */
export const DEFAULT_MIN_SCORE = 2.25;

const FORMAT_VERSION = 1;
/** Only this many top BM25+ candidates are re-scored for phrase matches and considered for the result. */
const RERANK_CANDIDATES = 50;
const PHRASE_BONUS = 0.25;
const MAX_PHRASE_BONUS_TERMS = 4;
const MAX_QUERY_TOKENS = 40;

export interface ClauseIndex {
  readonly engine: MiniSearch<Chunk>;
  readonly chunks: ReadonlyMap<string, Chunk>;
}

export interface Hit {
  /** Document text: untrusted data. */
  chunk: Chunk;
  score: number;
}

export interface SearchParams {
  /** Maximum hits to return. Default 3. */
  limit?: number;
  /** Minimum score for a hit. Default DEFAULT_MIN_SCORE. Pass 0 to see everything that matched at all. */
  minScore?: number;
  /** Only search chunks of these documents. An empty list matches nothing. */
  docIds?: readonly string[];
  /** Only search chunks this predicate accepts, for example the documents linked to one asset. */
  assetFilter?: (chunk: Chunk) => boolean;
}

// Functions are not serialized by MiniSearch, so build and load must share this one options object.
function engineOptions(): Options<Chunk> {
  return {
    idField: "id",
    fields: ["text", "heading"],
    processTerm: (term) => stem(term.toLowerCase()),
    searchOptions: {
      combineWith: "OR",
      boost: { heading: 2 },
      prefix: (term) => term.length >= 4,
      fuzzy: false,
      weights: { prefix: 0.3, fuzzy: 0 },
    },
  };
}

const byId = (a: Chunk, b: Chunk) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Build an index. Works for any number of chunks (use `capChunks` first to honour MAX_CHUNKS). Input order does
 * not matter: chunks are indexed in id order, and a repeated id keeps its first chunk.
 */
export function buildIndex(chunks: readonly Chunk[]): ClauseIndex {
  const sorted = [...chunks].sort(byId);
  const map = new Map<string, Chunk>();
  for (const c of sorted) if (!map.has(c.id)) map.set(c.id, c);
  const engine = new MiniSearch<Chunk>(engineOptions());
  engine.addAll([...map.values()]);
  return { engine, chunks: map };
}

export function serializeIndex(index: ClauseIndex): string {
  return JSON.stringify({ v: FORMAT_VERSION, index: index.engine.toJSON(), chunks: [...index.chunks.values()] });
}

export function loadIndex(json: string): ClauseIndex {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null) throw new Error("Not a clause index");
  const { v, index, chunks } = parsed as { v?: unknown; index?: unknown; chunks?: unknown };
  if (v !== FORMAT_VERSION || typeof index !== "object" || index === null || !Array.isArray(chunks)) {
    throw new Error("Not a clause index");
  }
  const map = new Map<string, Chunk>();
  for (const c of chunks as Chunk[]) map.set(c.id, c);
  const engine = MiniSearch.loadJS<Chunk>(index as Parameters<typeof MiniSearch.loadJS>[0], engineOptions());
  return { engine, chunks: map };
}

/**
 * Return the chunks to index and the chunks left out, in input order. Preferred documents are kept first;
 * everything else fills the remaining room. Nothing is dropped without being returned in `dropped`.
 */
export function capChunks(
  chunks: readonly Chunk[],
  preferDocIds: readonly string[] = [],
  max: number = MAX_CHUNKS,
): { kept: Chunk[]; dropped: Chunk[] } {
  if (chunks.length <= max) return { kept: [...chunks], dropped: [] };
  const prefer = new Set(preferDocIds);
  const rank = chunks.map((c, i) => ({ c, i, p: prefer.has(c.docId) ? 0 : 1 }));
  rank.sort((a, b) => a.p - b.p || a.i - b.i);
  const keepIdx = new Set(rank.slice(0, max).map((r) => r.i));
  const kept: Chunk[] = [];
  const dropped: Chunk[] = [];
  chunks.forEach((c, i) => (keepIdx.has(i) ? kept : dropped).push(c));
  return { kept, dropped };
}

function bigrams(stems: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < stems.length; i++) out.push(`${stems[i]} ${stems[i + 1]}`);
  return out;
}

// Per index cache of each chunk's adjacent word pairs, filled on first use so repeat searches stay cheap.
const pairCache = new WeakMap<ClauseIndex, Map<string, Set<string>>>();

function pairsOf(index: ClauseIndex, chunk: Chunk): Set<string> {
  let cache = pairCache.get(index);
  if (!cache) pairCache.set(index, (cache = new Map()));
  let pairs = cache.get(chunk.id);
  if (!pairs) {
    pairs = new Set(bigrams(contentStems(chunk.heading ? `${chunk.heading}\n${chunk.text}` : chunk.text)));
    cache.set(chunk.id, pairs);
  }
  return pairs;
}

function phraseMatches(index: ClauseIndex, chunk: Chunk, queryBigrams: readonly string[]): number {
  if (queryBigrams.length === 0) return 0;
  const have = pairsOf(index, chunk);
  let n = 0;
  for (const b of queryBigrams) if (have.has(b)) n++;
  return n;
}

/**
 * Rank chunks for a question. Stop words are removed from the query, a small synonym table widens it, and phrase
 * and prefix matches score higher. Results are sorted by score, ties by chunk id, and only hits at or above
 * `minScore` are returned, so an unrelated question yields [].
 */
export function searchIndex(index: ClauseIndex, query: string, params: SearchParams = {}): Hit[] {
  const { limit = 3, minScore = DEFAULT_MIN_SCORE, docIds, assetFilter } = params;
  if (limit <= 0) return [];
  const words = tokenize(query.slice(0, MAX_QUERY_CHARS))
    .filter((t) => !STOP_WORDS.has(t))
    .slice(0, MAX_QUERY_TOKENS);
  if (words.length === 0) return [];

  const allowed = docIds ? new Set(docIds) : undefined;
  const filter: SearchOptions["filter"] | undefined =
    allowed || assetFilter
      ? (r) => {
          const c = index.chunks.get(r.id as string);
          if (!c) return false;
          if (allowed && !allowed.has(c.docId)) return false;
          return assetFilter ? assetFilter(c) : true;
        }
      : undefined;

  const extra = expandQuery(words.join(" ")).slice(0, MAX_QUERY_TOKENS);
  const queries: (string | { queries: string[]; prefix: false })[] = [words.join(" ")];
  if (extra.length > 0) queries.push({ queries: [extra.join(" ")], prefix: false });
  const raw = index.engine.search({ queries, combineWith: "OR" }, filter ? { filter } : {});

  const queryBigrams = bigrams(words.map(stem));
  const hits: Hit[] = [];
  // raw is sorted by BM25+ score; only the best candidates are re-scored and considered.
  const candidates = Math.max(RERANK_CANDIDATES, limit);
  for (let i = 0; i < raw.length && i < candidates; i++) {
    const r = raw[i]!;
    const chunk = index.chunks.get(r.id as string)!;
    const bonus = PHRASE_BONUS * Math.min(phraseMatches(index, chunk, queryBigrams), MAX_PHRASE_BONUS_TERMS);
    const score = r.score * (1 + bonus);
    if (score >= minScore) hits.push({ chunk, score });
  }
  hits.sort((a, b) => b.score - a.score || byId(a.chunk, b.chunk));
  return hits.slice(0, limit);
}
