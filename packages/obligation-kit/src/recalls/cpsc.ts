// CPSC recall parsing and matching (SPEC section 10). Pure and deterministic, no network. Recall text is untrusted
// data: it is only compared, never interpreted.
//
// Evidence ladder (INTENT principle 2): HIGH needs deterministic evidence (UPC, or a structured model plus the brand).
// The brand must be in the SAME product Name as the model; Description, Importers, Manufacturers and Distributors
// support POSSIBLE only. POSSIBLE is brand plus product-name overlap. Anything else is no match. The record Title is never evidence: CPSC
// record 26569 has a Joolz title on a CooCooBaby recall.

export class CpscApiError extends Error {
  override name = "CpscApiError";
}

const BASE = "https://www.saferproducts.gov/RestWebServices/Recall";
// Verified live. LastPublishDateStart/End and a UPC filter are UNVERIFIED (filtered queries were failing on the
// day of testing), so they are left out on purpose. Unknown names return the whole database, hence the throw.
const ALLOWED = new Set(["RecallDateStart", "RecallDateEnd", "RecallNumber", "ProductName"]);

/** `format=json` is always sent because the default is XML. */
export function buildCpscUrl(params: Record<string, string>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (!ALLOWED.has(k)) throw new CpscApiError(`unknown CPSC parameter: ${k}`);
    if (typeof v !== "string" || v.trim() === "") throw new CpscApiError(`empty value for CPSC parameter: ${k}`);
    q.set(k, v.trim());
  }
  q.set("format", "json");
  return `${BASE}?${q.toString()}`;
}

export type CpscRaw = Record<string, unknown>;

/**
 * A database failure arrives as HTTP 200 with ONE fake record (RecallID 0, no RecallNumber). Treating it as an
 * empty list would be a false all-clear, so it throws. A real empty result is [].
 */
export function parseCpscResponse(json: unknown, opts: { maxRecords?: number } = {}): CpscRaw[] {
  const max = opts.maxRecords ?? 2000;
  if (!Array.isArray(json)) throw new CpscApiError("CPSC response is not a list");
  if (json.length >= max) throw new CpscApiError(`CPSC result ceiling exceeded (${max})`);
  for (const r of json) {
    if (!r || typeof r !== "object" || Array.isArray(r)) throw new CpscApiError("CPSC record is not an object");
    const rec = r as CpscRaw;
    if (rec.RecallID === 0 || typeof rec.RecallNumber !== "string" || rec.RecallNumber.trim() === "") {
      throw new CpscApiError("CPSC returned an error record");
    }
  }
  return json as CpscRaw[];
}

export interface CpscRecall {
  recallNumber: string;
  /** YYYY-MM-DD */
  recallDate: string;
  /** For display only. Never evidence. */
  title: string;
  url: string;
  productNames: string[];
  /** Structured Product.Model values only (display). Matching uses `products`. */
  models: string[];
  /** Each product's own Name and Model, so brand and model can be tied to one product. */
  products: { name: string; model: string }[];
  /** Digits, left padded to 14. */
  upcs: string[];
  hazards: string[];
  remedies: string[];
  /** Separate texts (not joined) that may name the brand. Never the Title. */
  brandEvidence: string[];
}

/**
 * Digits only. Only 12 (UPC-A), 13 (EAN-13) and 14 digit values are accepted and left padded to 14 so they compare
 * equal. Anything else (8 digit EAN-8 or UPC-E, odd lengths) and any all-zero value is null, never padded.
 */
export function normalizeUpc(v: string | null | undefined): string | null {
  const d = (v ?? "").replace(/[\s-]/g, "");
  if (!/^\d{12,14}$/.test(d) || /^0+$/.test(d)) return null;
  return d.padStart(14, "0");
}

const arr = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [];
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const names = (v: unknown, key = "Name"): string[] => arr(v).map((x) => str(x[key])).filter(Boolean);

export function normalizeCpscRecall(raw: CpscRaw): CpscRecall {
  const recallNumber = str(raw.RecallNumber);
  if (!recallNumber) throw new CpscApiError("CPSC record has no RecallNumber");
  const date = /^(\d{4}-\d{2}-\d{2})(?:T|$)/.exec(str(raw.RecallDate))?.[1];
  if (!date) throw new CpscApiError("CPSC record has a malformed RecallDate");
  const productNames = names(raw.Products);
  const description = str(raw.Description);
  return {
    recallNumber,
    recallDate: date,
    title: str(raw.Title),
    url: str(raw.URL),
    productNames,
    models: names(raw.Products, "Model"),
    products: arr(raw.Products).map((x) => ({ name: str(x.Name), model: str(x.Model) })),
    // A field may hold a list ("a, b; c"), so every piece is a candidate.
    upcs: arr(raw.ProductUPCs)
      .flatMap((x) => str(x.UPC).split(/[,;\s]+/))
      .map(normalizeUpc)
      .filter((x): x is string => x !== null),
    hazards: names(raw.Hazards),
    remedies: names(raw.Remedies),
    brandEvidence: [
      ...productNames,
      ...(description ? [description] : []),
      ...names(raw.Importers),
      ...names(raw.Manufacturers),
      ...names(raw.Distributors),
    ],
  };
}

export interface RecallAsset {
  id: string;
  name: string;
  brand?: string | null;
  modelNumber?: string | null;
  upc?: string | null;
  vehicle?: { nhtsaMake?: string | null; nhtsaModel?: string | null; modelYear?: number | null } | null;
}

export type CpscEvidence = "upc" | "model_brand" | "brand_name";
export interface CpscMatch {
  confidence: "high" | "possible";
  evidence: CpscEvidence;
}

/**
 * Separators (space, hyphen, underscore, slash, dot) become one marker, not nothing, so "1-23" and "12-3" differ.
 * A marker between a letter and a digit is dropped so "NW-DW500" equals "nw dw 500".
 */
const modelKey = (s: string): string =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\-_/.]+/g, "-")
    .replace(/^-|-$/g, "")
    .replace(/(?<=\p{L})-(?=\p{N})|(?<=\p{N})-(?=\p{L})/gu, "");
const usableModel = (key: string): boolean => /\p{L}/u.test(key) && /\p{N}/u.test(key) || key.replace(/[^\p{L}\p{N}]/gu, "").length >= 4;
const words = (s: string): string[] => s.normalize("NFKC").toLowerCase().replace(/['’]/g, "").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const BRAND_STOP = new Set(["a", "an", "the", "and", "of", "co", "inc", "llc", "ltd"]);
const STOP = new Set(["the", "a", "an", "and", "or", "of", "for", "with", "by", "in", "to", "set", "pack", "new", "oz", "kit", "pcs"]);

/** Whole-word, in sequence, inside a single text. Boon is not found in Boone. */
function hasBrand(brandWords: string[], texts: string[]): boolean {
  if (brandWords.length === 0) return false;
  return texts.some((t) => {
    const w = words(t);
    for (let i = 0; i + brandWords.length <= w.length; i++) if (brandWords.every((b, j) => w[i + j] === b)) return true;
    return false;
  });
}

const stem = (w: string): string => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);

export function matchCpscRecall(asset: RecallAsset, recall: CpscRecall): CpscMatch | null {
  const upc = normalizeUpc(asset.upc);
  if (upc && recall.upcs.includes(upc)) return { confidence: "high", evidence: "upc" };

  const brandWords = words(asset.brand ?? "");
  // A one character or stopword brand is too weak to be evidence at any level.
  if (brandWords.join("").length < 2 || brandWords.every((w) => BRAND_STOP.has(w))) return null;
  if (!hasBrand(brandWords, recall.brandEvidence)) return null;

  const model = modelKey(asset.modelNumber ?? "");
  if (usableModel(model)) {
    const sameModel = recall.products.filter((p) => modelKey(p.model) === model);
    // High only when brand and model sit on the same product. Brand elsewhere in the record caps at possible.
    if (sameModel.some((p) => hasBrand(brandWords, [p.name]))) return { confidence: "high", evidence: "model_brand" };
    if (sameModel.length > 0) return { confidence: "possible", evidence: "model_brand" };
  }

  const skip = new Set(brandWords);
  const content = (s: string) => words(s).filter((w) => !STOP.has(w) && !skip.has(w)).map(stem);
  const theirs = new Set(recall.productNames.flatMap(content));
  if (content(asset.name).some((w) => theirs.has(w))) return { confidence: "possible", evidence: "brand_name" };
  return null;
}

export interface CpscAssetMatch extends CpscMatch {
  assetId: string;
  recallNumber: string;
}

const lt = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Order independent: the result is sorted by asset id, then high before possible, then recall number. */
export function matchCpscRecalls(
  assets: RecallAsset[],
  recalls: CpscRecall[],
  opts: { suppressed?: (assetId: string, recallNumber: string) => boolean } = {},
): CpscAssetMatch[] {
  const out = new Map<string, CpscAssetMatch>();
  for (const a of assets) {
    for (const r of recalls) {
      if (opts.suppressed?.(a.id, r.recallNumber)) continue;
      const m = matchCpscRecall(a, r);
      if (m) out.set(`${a.id}\u0000${r.recallNumber}`, { assetId: a.id, recallNumber: r.recallNumber, ...m });
    }
  }
  const rank = (c: string) => (c === "high" ? 0 : 1);
  return [...out.values()].sort(
    (x, y) => lt(x.assetId, y.assetId) || rank(x.confidence) - rank(y.confidence) || lt(x.recallNumber, y.recallNumber),
  );
}

/** Client side hazard filter (whole word, any of). No words means no filtering. */
export function filterByHazard(recalls: CpscRecall[], hazardWords: string[]): CpscRecall[] {
  const want = new Set(hazardWords.flatMap(words));
  if (want.size === 0) return recalls;
  return recalls.filter((r) => r.hazards.some((h) => words(h).some((w) => want.has(w))));
}
