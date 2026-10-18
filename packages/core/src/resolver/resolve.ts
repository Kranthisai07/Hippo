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

// Same five values as obligation-kit's AgreementKind. Merge them into one definition in the T1.1 contracts.
export type AgreementKind = "warranty" | "insurance" | "lease" | "subscription" | "service_plan";

export interface AgreementLike {
  id: string;
  kind: AgreementKind;
  /** Insurer, vendor, landlord or warranty provider. */
  party?: string;
  title?: string;
  assetIds?: string[];
}

/** Never guess: a match is one sure answer. Anything less sure is "ambiguous" with at most 3 things to ask about. */
export type Resolution<T> =
  | { status: "match"; item: T }
  | { status: "ambiguous"; candidates: T[] }
  | { status: "none" };

const MAX_OPTIONS = 3;

interface Entry<T> {
  item: T;
  key: string;
  id: string;
  /** Says what the thing IS, not just what it is near. */
  strong: boolean;
  /** The query is exactly one of its names. */
  exact: boolean;
}

const order = <T>(a: Entry<T>, b: Entry<T>): number => a.key.localeCompare(b.key) || a.id.localeCompare(b.id);

/**
 * One strong candidate, or one exact name among several, is a match. Several strong ones are asked about.
 * With no strong one, candidates that merely contain the words are offered as a question, never as an answer
 * ("tv" with only a "TV stand" asks "do you mean the TV stand?").
 */
function decide<T>(entries: Entry<T>[]): Resolution<T> {
  const strong = entries.filter((e) => e.strong).sort(order);
  const exact = strong.filter((e) => e.exact);
  const sure = strong.length === 1 ? strong[0] : exact.length === 1 ? exact[0] : undefined;
  if (sure) return { status: "match", item: sure.item };
  const asks = strong.length ? strong : [...entries].sort(order);
  return asks.length ? { status: "ambiguous", candidates: asks.slice(0, MAX_OPTIONS).map((e) => e.item) } : { status: "none" };
}

/** The last word of a name that is not a model number: Fridge water filter is a filter, iPhone 15 is a phone. */
const headOf = (words: string[]): string | undefined => [...words].reverse().find((w) => !/\d/.test(w)) ?? words.at(-1);

interface Words {
  /** Every word the asset can be found by. */
  all: Set<string>;
  /** The words that say what it is: head of the name and of each alias, brand, category. */
  heads: Set<string>;
  names: Set<string>[];
}

function assetWords(a: AssetLike): Words {
  const names = [tokens(a.name), ...(a.aliases ?? []).map(tokens)];
  const brand = tokens(a.brand ?? "");
  const category = tokens(a.category ?? "");
  const heads = new Set([...names.map(headOf).filter((w): w is string => !!w), ...brand, ...category]);
  return { all: new Set([...names.flat(), ...brand, ...category, ...tokens(a.location ?? "")]), heads, names: names.map((n) => new Set(n)) };
}

export function resolveAsset(query: string, assets: AssetLike[]): Resolution<AssetLike> {
  const q = tokens(query);
  if (q.length === 0) return { status: "none" };
  return decide(
    assets.flatMap((item) => {
      const w = assetWords(item);
      // Every word the user said must be explained, so one different word ("upstairs" vs "Downstairs") rules it out.
      if (!q.every((t) => w.all.has(t))) return [];
      const exact = w.names.some((n) => n.size === q.length && q.every((t) => n.has(t)));
      return [{ item, key: item.name, id: item.id, strong: q.some((t) => w.heads.has(t)), exact }];
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

const labelOf = (a: AgreementLike): string => `${a.party ?? ""} ${a.title ?? ""}`.trim();

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

  const byId = new Map(assets.map((a) => [a.id, a]));
  return decide(
    pool.flatMap((item) => {
      const label = tokens(labelOf(item));
      const linked = (item.assetIds ?? []).flatMap((id) => {
        const asset = byId.get(id);
        return asset ? [assetWords(asset)] : [];
      });
      const found = new Set([...label, ...linked.flatMap((w) => [...w.all])]);
      if (!rest.every((t) => found.has(t))) return [];
      // Same rule as assets: a word of the agreement's own name, or a head word of what it covers, says what it is.
      // "fridge warranty" for the Fridge water filter's warranty is a question. A kind word alone ("my lease") is enough.
      const heads = new Set([...label, ...linked.flatMap((w) => [...w.heads])]);
      const strong = rest.length === 0 || rest.some((t) => heads.has(t));
      return [{ item, key: labelOf(item), id: item.id, strong, exact: false }];
    }),
  );
}
