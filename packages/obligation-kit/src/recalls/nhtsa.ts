// NHTSA recall parsing and matching (SPEC section 10). Pure and deterministic, no network.
// Recalls are matched by make, model and year, NOT by VIN, so the wording is always "may affect".

import type { RecallAsset } from "./cpsc";

export class NhtsaApiError extends Error {
  override name = "NhtsaApiError";
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const API = "https://api.nhtsa.gov";
const MIN_YEAR = 1886;
const MAX_YEAR = 2100;

const need = (v: unknown, what: string): string => {
  if (typeof v !== "string" || v.trim() === "") throw new NhtsaApiError(`${what} is required`);
  return v.trim();
};
const needYear = (y: unknown): number => {
  if (typeof y !== "number" || !Number.isInteger(y) || y < MIN_YEAR || y > MAX_YEAR) throw new NhtsaApiError("year is invalid");
  return y;
};

export function recallsByVehicleUrl(v: { make: string; model: string; year: number }): string {
  const q = new URLSearchParams({ make: need(v.make, "make"), model: need(v.model, "model"), modelYear: String(needYear(v.year)) });
  return `${API}/recalls/recallsByVehicle?${q}`;
}

export function modelsUrl(v: { make: string; year: number }): string {
  const q = new URLSearchParams({ modelYear: String(needYear(v.year)), make: need(v.make, "make"), issueType: "r" });
  return `${API}/products/vehicle/models?${q}`;
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const results = (body: unknown): unknown[] => {
  const r = obj(body)?.results;
  if (!Array.isArray(r)) throw new NhtsaApiError("NHTSA response is malformed");
  return r;
};
const fold = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * NHTSA wants its own spellings (CR-V, not CRV). Matches by folded equality against the models list, and returns null
 * when nothing matches or when different spellings fold the same (never guess).
 */
export function canonicalizeVehicle(
  v: { make: string; model: string; year: number },
  modelsResponse: unknown,
): { nhtsaMake: string; nhtsaModel: string } | null {
  const rows = results(modelsResponse);
  const make = fold(v.make);
  const model = fold(v.model);
  if (!make || !model) return null;
  const found = new Map<string, { nhtsaMake: string; nhtsaModel: string }>();
  for (const row of rows) {
    const r = obj(row);
    if (!r || typeof r.make !== "string" || typeof r.model !== "string") continue;
    if (r.modelYear !== undefined && String(r.modelYear) !== String(v.year)) continue;
    if (fold(r.make) === make && fold(r.model) === model) found.set(`${r.make}\u0000${r.model}`, { nhtsaMake: r.make, nhtsaModel: r.model });
  }
  return found.size === 1 ? [...found.values()][0]! : null;
}

export interface NhtsaRecall {
  /** The NHTSA campaign number. */
  recallId: string;
  /** YYYY-MM-DD */
  reportDate: string;
  component: string;
  summary: string;
  consequence: string;
  remedy: string;
  manufacturer: string;
  make: string;
  model: string;
  modelYear: number;
}

/** Strict DD/MM/YYYY (NHTSA's format) to ISO. A US-style or ISO date throws rather than being guessed. */
function isoDate(s: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (!m) throw new NhtsaApiError("NHTSA date is not DD/MM/YYYY");
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) throw new NhtsaApiError("NHTSA date is not a real date");
  return `${m[3]}-${m[2]}-${m[1]}`;
}

export function parseNhtsaResponse(json: unknown): NhtsaRecall[] {
  return results(json).map((row) => {
    const r = obj(row);
    if (!r) throw new NhtsaApiError("NHTSA record is not an object");
    const s = (k: string) => (typeof r[k] === "string" ? (r[k] as string).trim() : "");
    const recallId = s("NHTSACampaignNumber");
    if (!recallId) throw new NhtsaApiError("NHTSA record has no campaign number");
    if (!/^\d{4}$/.test(s("ModelYear"))) throw new NhtsaApiError("NHTSA record has a bad ModelYear");
    return {
      recallId,
      reportDate: isoDate(s("ReportReceivedDate")),
      component: s("Component"),
      summary: s("Summary"),
      consequence: s("Consequence"),
      remedy: s("Remedy"),
      manufacturer: s("Manufacturer"),
      make: s("Make"),
      model: s("Model"),
      modelYear: Number(s("ModelYear")),
    };
  });
}

export interface NhtsaMatch {
  confidence: "high";
  wording: "may_affect";
  recallId: string;
}

/** High only when the canonical make, model and year all equal. Never names a VIN. */
export function matchNhtsaRecall(asset: RecallAsset, recall: NhtsaRecall): NhtsaMatch | null {
  const v = asset.vehicle;
  const make = v?.nhtsaMake?.trim().toUpperCase();
  const model = v?.nhtsaModel?.trim().toUpperCase();
  if (!make || !model || typeof v?.modelYear !== "number") return null;
  if (make !== recall.make.toUpperCase() || model !== recall.model.toUpperCase() || v.modelYear !== recall.modelYear) return null;
  return { confidence: "high", wording: "may_affect", recallId: recall.recallId };
}

const plain = (s: string, maxWords: number): string =>
  s
    .replace(/https?:\/\/\S+|www\.\S+/gi, " ")
    .replace(/[^\p{L}\p{N}\s'&-]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxWords)
    .join(" ");

/** One speakable sentence, under 45 words, no URL, no markdown. The label is the caller's words for the car. */
export function nhtsaSpeech(recall: NhtsaRecall, label: string): string {
  const what = plain(recall.component.split(":")[0]?.toLowerCase() ?? "", 8) || "a safety issue";
  const car = plain(label, 8) || "vehicle";
  return `A recall involving ${what} may affect your ${car}, so check your VIN on the NHTSA website.`;
}
