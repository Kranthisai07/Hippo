import { tokens } from "./normalize";

/** Plain shapes named after SPEC section 3. T1.1 can pass its entities straight in or map to these. */
export interface AssetLike {
  id: string;
  name: string;
  aliases?: string[];
  category?: string;
  brand?: string;
  location?: string;
}

export type AgreementKind = "warranty" | "insurance" | "lease" | "subscription" | "service_plan";

export interface AgreementLike {
  id: string;
  kind: AgreementKind;
  /** Insurer, vendor, landlord or warranty provider. */
  party?: string;
  title?: string;
  assetIds?: string[];
}

/** Never guess: more than one plausible answer is "ambiguous" with at most 3 candidates to ask about. */
export type Resolution<T> =
  | { status: "match"; item: T; score: number }
  | { status: "ambiguous"; candidates: T[] }
  | { status: "none" };

const MAX_OPTIONS = 3;
/** More than half the words must match, so one shared word ("kitchen island" vs "Kitchen water filter") is not enough. */
const MIN_SCORE = 0.6;
/** Candidates this close to the best score count as a tie. */
const TIE_MARGIN = 0.15;

const WEIGHT = { name: 1, alias: 0.9, brand: 0.6, category: 0.4, location: 0.3 } as const;

type Field = keyof typeof WEIGHT;
type FieldTokens = [Field, Set<string>][];

const assetFields = (a: AssetLike): FieldTokens => [
  ["name", new Set(tokens(a.name))],
  ...(a.aliases ?? []).map((x): [Field, Set<string>] => ["alias", new Set(tokens(x))]),
  ["brand", new Set(tokens(a.brand ?? ""))],
  ["category", new Set(tokens(a.category ?? ""))],
  ["location", new Set(tokens(a.location ?? ""))],
];

/** Share of query tokens found, each weighted by the best field that holds it. */
function coverage(query: string[], fields: FieldTokens): number {
  if (query.length === 0) return 0;
  let sum = 0;
  for (const q of query) {
    let best = 0;
    for (const [f, set] of fields) if (set.has(q)) best = Math.max(best, WEIGHT[f]);
    sum += best;
  }
  return sum / query.length;
}

const sameSet = (a: string[], b: Set<string>): boolean => a.length === b.size && a.every((t) => b.has(t));

function pick<T>(scored: { item: T; score: number; exact?: boolean }[]): Resolution<T> {
  const ranked = scored.filter((s) => s.score >= MIN_SCORE).sort((a, b) => b.score - a.score);
  const top = ranked[0];
  if (!top) return { status: "none" };
  const tied = ranked.filter((s) => top.score - s.score <= TIE_MARGIN);
  if (tied.length === 1) return { status: "match", item: top.item, score: top.score };
  // One asset named exactly what the user said beats looser matches that merely contain those words.
  const exact = tied.filter((s) => s.exact);
  const only = exact.length === 1 ? exact[0] : undefined;
  if (only) return { status: "match", item: only.item, score: only.score };
  return { status: "ambiguous", candidates: tied.slice(0, MAX_OPTIONS).map((s) => s.item) };
}

export function resolveAsset(query: string, assets: AssetLike[]): Resolution<AssetLike> {
  const q = tokens(query);
  if (q.length === 0) return { status: "none" };
  return pick(
    assets.map((item) => {
      const fields = assetFields(item);
      const exact = fields.some(([f, set]) => (f === "name" || f === "alias") && sameSet(q, set));
      return { item, score: exact ? 1 : coverage(q, fields), exact };
    }),
  );
}

// ---- agreements ----

const KIND_WORDS: Record<AgreementKind, string[]> = {
  lease: ["lease", "rent", "landlord", "apartment", "tenancy"],
  insurance: ["insurance", "policy", "insurer", "insured"],
  warranty: ["warranty", "guarantee"],
  subscription: ["subscription", "membership", "trial"],
  service_plan: ["serviceplan"],
};

function detectKind(q: string[]): { kind: AgreementKind | null; rest: string[] } {
  for (const kind of Object.keys(KIND_WORDS) as AgreementKind[]) {
    const words = KIND_WORDS[kind];
    if (q.some((t) => words.includes(t))) return { kind, rest: q.filter((t) => !words.includes(t)) };
  }
  return { kind: null, rest: q };
}

/** Finds an agreement from phrases like "car insurance", "my lease" or "the Northwind warranty". */
export function resolveAgreement(
  query: string,
  agreements: AgreementLike[],
  assets: AssetLike[] = [],
): Resolution<AgreementLike> {
  const q = tokens(query);
  if (q.length === 0) return { status: "none" };
  const { kind, rest } = detectKind(q);
  const pool = kind ? agreements.filter((a) => a.kind === kind) : agreements;
  if (pool.length === 0) return { status: "none" };

  if (rest.length === 0) {
    // Only a kind word ("my lease"): fine when there is one, otherwise ask.
    if (pool.length === 1 && pool[0]) return { status: "match", item: pool[0], score: 1 };
    return { status: "ambiguous", candidates: pool.slice(0, MAX_OPTIONS) };
  }

  const byId = new Map(assets.map((a) => [a.id, a]));
  return pick(
    pool.map((item) => {
      const fields: FieldTokens = [
        ["name", new Set(tokens(`${item.party ?? ""} ${item.title ?? ""}`))],
        ...(item.assetIds ?? []).flatMap((id) => {
          const asset = byId.get(id);
          return asset ? assetFields(asset) : [];
        }),
      ];
      return { item, score: coverage(rest, fields) };
    }),
  );
}
