// Links what a document says it is about (brand, model, serial, or a vehicle) to an asset the household already has,
// or proposes a new one for the review screen (SPEC section 7 step 5). Deterministic, no LLM. The user confirms
// every link in review, so the job here is to never claim more than the evidence shows.
import type { AssetLike } from "../resolver";

export interface AssetRecord extends AssetLike {
  modelNumber?: string | null;
  serialLast4?: string | null;
  upc?: string | null;
  vehicle?: { make: string; model: string; modelYear: number; nhtsaMake?: string; nhtsaModel?: string } | null;
}

/** From a warranty or service plan: `assetHint {brand, model, serial}` in SPEC section 4. */
export interface AssetHint {
  brand?: string | null;
  model?: string | null;
  serial?: string | null;
}

/** From an insurance policy: one entry of `coveredAssetHints`. */
export interface VehicleHint {
  make?: string | null;
  model?: string | null;
  year?: number | null;
}

export interface AssetDraft {
  name: string;
  brand?: string;
  modelNumber?: string;
  serialLast4?: string;
  category?: string;
  vehicle?: { make: string; model: string; modelYear?: number };
}

export type Link =
  | { status: "match"; asset: AssetRecord }
  | { status: "ambiguous"; candidates: AssetRecord[] }
  | { status: "propose"; draft: AssetDraft }
  | { status: "none" };

const MAX_OPTIONS = 3;
/** A model number shorter than this ("A1") says too little to tell two products apart. */
const MIN_MODEL = 3;

/**
 * Letters and digits of any script, lowercase, accents dropped: NW-DW500 and nw dw 500 are the same model. A brand in
 * another script keeps its letters, so it still counts as a brand. Numbers are accepted because models come from JSON.
 */
const key = (s: unknown): string => {
  const text = typeof s === "string" ? s : typeof s === "number" ? String(s) : "";
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
};

const last4 = (s: unknown): string => key(s).slice(-4);
const clean = (s: unknown): string | undefined =>
  typeof s === "string" ? s.trim() || undefined : typeof s === "number" ? String(s) : undefined;

/** A model written with the brand in front ("Acme DW500" for brand Acme) is the model DW500. */
const modelKey = (model: unknown, brand: unknown): string => {
  const m = key(model);
  const b = key(brand);
  return b && m.startsWith(b) && m.length - b.length >= MIN_MODEL ? m.slice(b.length) : m;
};

const byName = (a: AssetRecord, b: AssetRecord): number => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
const ask = (found: AssetRecord[]): Link => ({
  status: "ambiguous",
  candidates: [...found].sort(byName).slice(0, MAX_OPTIONS),
});

function draftFor(hint: AssetHint): Link {
  const brand = clean(hint.brand);
  const written = clean(hint.model);
  const modelNumber =
    brand &&
    written &&
    written.toLowerCase().startsWith(brand.toLowerCase()) &&
    modelKey(written, brand) !== key(written)
      ? written.slice(brand.length).trim()
      : written;
  const serial = last4(hint.serial);
  const name = [brand, modelNumber].filter(Boolean).join(" ");
  const draft: AssetDraft = { name };
  if (brand) draft.brand = brand;
  if (modelNumber) draft.modelNumber = modelNumber;
  if (serial.length === 4) draft.serialLast4 = serial;
  return { status: "propose", draft };
}

/**
 * A model number is the only evidence strong enough to say "this is the same product". It must match, the brand must
 * not contradict it, and a stated serial last 4 must not differ (a different serial is a second unit). A brand alone
 * is never a match: it can only be a question. No evidence at all means the document describes something new.
 */
export function linkAssetHint(hint: AssetHint, assets: AssetRecord[]): Link {
  const brand = key(hint.brand);
  const model = modelKey(hint.model, hint.brand);
  const serial = last4(hint.serial);
  const hasModel = model.length >= MIN_MODEL;
  if (!hasModel && !brand) return { status: "none" };

  const sameBrand = (a: AssetRecord) => !brand || !a.brand || key(a.brand) === brand;
  const sameUnit = (a: AssetRecord) => !(serial.length === 4 && a.serialLast4 && last4(a.serialLast4) !== serial);

  if (hasModel) {
    const same = assets.filter((a) => modelKey(a.modelNumber, a.brand) === model && sameBrand(a) && sameUnit(a));
    // A unit whose serial matches beats one that merely has no serial recorded.
    const exact = serial.length === 4 ? same.filter((a) => a.serialLast4 && last4(a.serialLast4) === serial) : [];
    const pool = exact.length ? exact : same;
    if (pool.length === 1 && pool[0]) return { status: "match", asset: pool[0] };
    if (pool.length > 1) return ask(pool);
    // The household may have this brand without a model recorded (added by voice). That could be the same thing.
    const unknownModel = assets.filter((a) => brand && key(a.brand) === brand && !key(a.modelNumber));
    return unknownModel.length ? ask(unknownModel) : draftFor(hint);
  }

  const sameMake = assets.filter((a) => key(a.brand) === brand);
  return sameMake.length ? ask(sameMake) : draftFor(hint);
}

/**
 * Make, model and year must all agree (the NHTSA spellings count too). A different year is a different car. With no
 * year in the document, even one match is only a question.
 */
export function linkVehicleHint(hint: VehicleHint, assets: AssetRecord[]): Link {
  const make = key(hint.make);
  const model = key(hint.model);
  if (!make || !model) return { status: "none" };
  // Anything that is not a plausible model year (NaN, 20200, 0) is no year at all, so it can only lead to a question.
  const year =
    typeof hint.year === "number" && Number.isInteger(hint.year) && hint.year >= 1886 && hint.year <= 2100
      ? hint.year
      : null;

  const cars = assets.filter(
    (a) =>
      a.vehicle &&
      [key(a.vehicle.make), key(a.vehicle.nhtsaMake)].includes(make) &&
      [key(a.vehicle.model), key(a.vehicle.nhtsaModel)].includes(model),
  );
  if (year === null && cars.length) return ask(cars);
  const sameYear = cars.filter((a) => a.vehicle?.modelYear === year);
  if (sameYear.length === 1 && sameYear[0]) return { status: "match", asset: sameYear[0] };
  if (sameYear.length > 1) return ask(sameYear);

  const make0 = clean(hint.make) ?? "";
  const model0 = clean(hint.model) ?? "";
  const vehicle: NonNullable<AssetDraft["vehicle"]> = { make: make0, model: model0 };
  if (year !== null) vehicle.modelYear = year;
  return {
    status: "propose",
    draft: {
      name: [year, make0, model0].filter((p) => p !== null && p !== "").join(" "),
      category: "vehicle",
      vehicle,
    },
  };
}
