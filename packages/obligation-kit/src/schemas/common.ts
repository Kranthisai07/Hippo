import { z } from "zod";
import { parseIso } from "../dates";
import { DAYS_PER_CYCLE, MONTHS_PER_CYCLE } from "../deadlines";

// Shared building blocks for the extraction schemas (SPEC section 4). Model output is untrusted: every schema is strict,
// every string is capped, and a field that is not there is null. Missing beats guessed.

/** A quote is at most 200 characters so it can be shown, stored and matched cheaply. */
export const MAX_QUOTE = 200;
/** No extracted text value needs more than this; a longer one is a model rambling or a document attacking. */
export const MAX_TEXT = 500;

export const SourceRefSchema = z.strictObject({
  page: z.number().int().min(1),
  quote: z.string().min(1).max(MAX_QUOTE),
});

/** `{value, sourceRef}`: what the model says and the words on the page that it says it from. */
export const leaf = <T extends z.ZodType>(value: T) => z.strictObject({ value, sourceRef: SourceRefSchema });

/** A field may be absent or null. Both mean "the document does not say". */
export const field = <T extends z.ZodType>(schema: T) => schema.nullish();

export const text = z.string().min(1).max(MAX_TEXT);
export const IsoDate = z.string().refine((v) => parseIso(v) !== null, "not a real calendar date (YYYY-MM-DD)");
/** A count of days or months: a whole number, not negative. */
export const count = z.number().int().min(0).max(36_500);
export const money = z.number().finite().min(0).max(100_000_000);

export const BILLING_CYCLES = ["weekly", "biweekly", "monthly", "quarterly", "semiannual", "annual"] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

const canonicalByMonths: Record<number, BillingCycle> = { 1: "monthly", 3: "quarterly", 6: "semiannual", 12: "annual" };
const canonicalByDays: Record<number, BillingCycle> = { 7: "weekly", 14: "biweekly" };

/** Every spelling the engine rolls forward, mapped to one canonical value. Built from the engine's own tables. */
const CYCLE_ALIASES: Record<string, BillingCycle> = {
  ...Object.fromEntries(Object.entries(MONTHS_PER_CYCLE).map(([k, n]) => [k, canonicalByMonths[n]!])),
  ...Object.fromEntries(Object.entries(DAYS_PER_CYCLE).map(([k, n]) => [k, canonicalByDays[n]!])),
};

const normaliseCycle = (v: unknown): unknown =>
  typeof v === "string" ? (CYCLE_ALIASES[v.trim().toLowerCase().replace(/\s+/g, " ")] ?? v) : v;

/** Free text from a model in, one of six values out. An unknown spelling fails instead of silently dropping a charge. */
export const BillingCycle = z.preprocess(normaliseCycle, z.enum(BILLING_CYCLES));

/** Phone, email and link of a claims or service desk. */
export const ContactSchema = z.strictObject({
  phone: field(leaf(text)),
  email: field(leaf(text)),
  url: field(leaf(text)),
});

/** From a warranty or service plan: what the document says the product is. Serial is the last 4 only. */
export const AssetHintSchema = z.strictObject({
  brand: field(leaf(text)),
  model: field(leaf(text)),
  /** The last 4 characters only (INTENT principle 7), never a full serial number. */
  serial: field(leaf(z.string().regex(/^[A-Za-z0-9]{1,4}$/))),
});

/** One bullet-sized statement a person reads in review: coverage, exclusion, claim step. */
export const textLeaves = field(z.array(leaf(text)).max(50));
