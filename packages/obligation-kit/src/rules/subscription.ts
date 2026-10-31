// A reader with no model: fixed patterns over the visible text of a billing page, a receipt or a checkout. Pure and
// deterministic. The text is untrusted data, so it is only matched, never obeyed. Every value carries the words it came
// from, which the quote check tests again. When a page gives two answers the field stays null: missing beats guessed,
// and a person confirms whatever is left before it can alert.
import { parseIso } from "../dates";
import { MAX_QUOTE, type BillingCycle } from "../schemas/common";

export interface RuleLeaf<T> {
  value: T;
  sourceRef: { page: number; quote: string };
}

/** The shape of SubscriptionSchema. A field the page does not settle is null. */
export interface SubscriptionRuleFields {
  vendor: RuleLeaf<string> | null;
  plan: RuleLeaf<string> | null;
  amount: RuleLeaf<number> | null;
  cycle: RuleLeaf<BillingCycle> | null;
  nextChargeDate: RuleLeaf<string> | null;
  trialEndDate: RuleLeaf<string> | null;
  cancelNoticeDays: RuleLeaf<number> | null;
  cancelMethod: RuleLeaf<string> | null;
  accountEmailHint: RuleLeaf<string> | null;
}

export interface RuleHints {
  /** The site the text came from, used to tell the vendor from a generic page title. */
  host?: string;
}

/** A hostile page cannot make matching slow: both caps bound the work. */
const MAX_LINES = 2000;
const MAX_SEGMENT = 1000;
/** A label on its own line, with its value on the next (a table or a definition list). */
const MAX_LABEL = 40;
const MAX_PLAN = 60;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const NAMED_MDY = new RegExp(`\\b${MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "gi");
const NAMED_DMY = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}\\.?,?\\s+(\\d{4})\\b`, "gi");
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const SLASH_DATE = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g;

interface FoundDate {
  iso: string | null;
  index: number;
}

const isoOf = (y: number, m: number, d: number): string | null => {
  const iso = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return parseIso(iso) === null ? null : iso;
};

const monthNumber = (name: string): number => MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;

/** Dates that state their year, in reading order. A slash date with two possible readings has `iso: null`. */
function datesIn(segment: string): FoundDate[] {
  const out: FoundDate[] = [];
  for (const m of segment.matchAll(NAMED_MDY)) {
    out.push({ iso: isoOf(Number(m[3]), monthNumber(m[1]!), Number(m[2])), index: m.index });
  }
  for (const m of segment.matchAll(NAMED_DMY)) {
    out.push({ iso: isoOf(Number(m[3]), monthNumber(m[2]!), Number(m[1])), index: m.index });
  }
  for (const m of segment.matchAll(ISO_DATE)) {
    out.push({ iso: isoOf(Number(m[1]), Number(m[2]), Number(m[3])), index: m.index });
  }
  for (const m of segment.matchAll(SLASH_DATE)) {
    const [a, b, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const iso = a === b || b > 12 ? isoOf(y, a, b) : a > 12 ? isoOf(y, b, a) : null;
    out.push({ iso, index: m.index });
  }
  return out.sort((x, y) => x.index - y.index);
}

/** Lines, then sentences, with a short label line joined to the value under it. */
function segmentsOf(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, MAX_LINES);
  const joined: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const next = lines[i + 1];
    // A line that already holds its value ("Plan: Family") is no label, and a line that names its own label is no value.
    const label = line.length <= MAX_LABEL && !/\d/.test(line) && !/[.!?]$/.test(line) && !/:\s*\S/.test(line);
    const value = next !== undefined && next.length <= MAX_LABEL && !next.includes(":");
    if (label && value && (/\d/.test(next) || /^(?:your |current )?plan:?$/i.test(line))) {
      joined.push(`${line.replace(/:$/, "")}: ${next}`);
      i++;
    } else {
      joined.push(line);
    }
  }
  return joined.flatMap((l) => l.split(/(?<=[.!?])\s+(?=[A-Z$])/)).map((s) => s.slice(0, MAX_SEGMENT));
}

/** The words around `index`, at most the quote limit, so a long line still gives a short quote holding the evidence. */
function quoteAt(segment: string, index: number): string {
  if (segment.length <= MAX_QUOTE) return segment;
  const start = Math.max(0, Math.min(index - 60, segment.length - MAX_QUOTE));
  return segment.slice(start, start + MAX_QUOTE).trim();
}

const leaf = <T>(value: T, quote: string): RuleLeaf<T> => ({ value, sourceRef: { page: 1, quote } });

/** One answer, or null when the page gives more than one. */
function only<T>(found: { key: string; value: T }[]): T | null {
  return new Set(found.map((f) => f.key)).size === 1 ? found[0]!.value : null;
}

// Price and cycle

const PRICE = /(?<![A-Za-z])(?:US)?\$\s?(\d{1,3}(?:,\d{3})+|\d{1,7})(?:\.(\d{2}))?(?![\d,]*\d)/g;
const NOT_THE_PRICE_BEFORE =
  /\b(?:was|save|saves|saving|savings|spent|lifetime|off|discount|credit|coupon|refund|refunded|from|tax|shipping|fee|deposit|regularly|normally|up to)\b[^$]*$/i;
/** Earlier in the sentence, however far from the number. After it they are fine: "$99/year (savings of 20%)". */
const NOT_THE_PRICE_LEAD = /\b(?:savings|spent)\b/i;
/** A price in another currency is not one this reader can state, so the page gets no price at all. */
const FOREIGN_CURRENCY = /\b(?:CAD|AUD|NZD|EUR|GBP|INR|JPY)\b/;
const NOT_THE_PRICE_AFTER = /^\s*(?:off|credit|discount|savings?|gift|in\b|tax|shipping|fee)/i;
/** "/month", "per month", "a year", "every 3 months". */
const CYCLE_AFTER = /^\s*(?:USD\s*)?(?:\/|per\s|a\s|each\s|every\s)\s*(\d{1,2}\s+)?(mo|mos|month|months|yr|yrs|year|years|annum|wk|week|weeks|quarter|quarters)\b/i;
/** The same, said before the price: "Billed every 3 months: $30.00". */
const CYCLE_EVERY = /\bevery\s+(\d{1,2}\s+)?(month|months|year|years|week|weeks|quarter|quarters)\b/i;
const CYCLE_WORD = /\b(monthly|annually|annual|yearly|quarterly|biweekly|bi-weekly|weekly|semiannually|semi-annually)\b/gi;
const STRONG_PRICE =
  /\b(?:your\s+(?:current\s+)?(?:plan|subscription|membership)|current\s+plan|next\s+(?:charge|payment|bill)|amount|total|you(?:'|’)ll\s+be|will\s+be\s+(?:charged|billed)|billed|price\s+after\s+trial|renews?)\b/i;

const CYCLE_BY_WORD: Record<string, BillingCycle> = {
  monthly: "monthly",
  annually: "annual",
  annual: "annual",
  yearly: "annual",
  quarterly: "quarterly",
  biweekly: "biweekly",
  "bi-weekly": "biweekly",
  weekly: "weekly",
  semiannually: "semiannual",
  "semi-annually": "semiannual",
};

function cycleFromUnit(rawCount: string | undefined, rawUnit: string): BillingCycle | null {
  const n = rawCount ? Number(rawCount.trim()) : 1;
  const unit = rawUnit.toLowerCase();
  const months = /^mo/.test(unit) ? n : /^(?:yr|year|annum)/.test(unit) ? n * 12 : /^quarter/.test(unit) ? n * 3 : null;
  if (months === null) return n === 1 ? "weekly" : n === 2 ? "biweekly" : null;
  return months === 1 ? "monthly" : months === 3 ? "quarterly" : months === 6 ? "semiannual" : months === 12 ? "annual" : null;
}

/** Cycle words in a segment. Yearly plus monthly in one sentence settles nothing, so the caller gets one or none. */
function cycleWordIn(segment: string): { cycle: BillingCycle; index: number } | null {
  const found = [...segment.matchAll(CYCLE_WORD)].map((m) => ({
    cycle: CYCLE_BY_WORD[m[1]!.toLowerCase()]!,
    index: m.index,
  }));
  return new Set(found.map((f) => f.cycle)).size === 1 ? found[0]! : null;
}

interface PriceCandidate {
  amount: number;
  cycle: BillingCycle | null;
  strong: boolean;
  segment: string;
  index: number;
}

function priceCandidates(segments: string[]): PriceCandidate[] {
  const out: PriceCandidate[] = [];
  for (const segment of segments) {
    const prices = [...segment.matchAll(PRICE)];
    for (const m of prices) {
      const after = segment.slice(m.index + m[0].length);
      if (NOT_THE_PRICE_LEAD.test(segment.slice(0, m.index))) continue;
      if (NOT_THE_PRICE_BEFORE.test(segment.slice(Math.max(0, m.index - 14), m.index))) continue;
      if (NOT_THE_PRICE_AFTER.test(after)) continue;
      const amount = Number(`${m[1]!.replaceAll(",", "")}.${m[2] ?? "00"}`);
      if (amount <= 0) continue;
      const unit = CYCLE_AFTER.exec(after);
      const every = prices.length === 1 ? CYCLE_EVERY.exec(segment) : null;
      const word = prices.length === 1 ? cycleWordIn(segment) : null;
      const said = unit ?? every;
      const cycle = said ? cycleFromUnit(said[1], said[2]!) : (word?.cycle ?? null);
      // "every 2 years" is a cycle the engine has no name for. It must not borrow another cycle from the page.
      if (said && cycle === null) continue;
      out.push({ amount, cycle, strong: STRONG_PRICE.test(segment), segment, index: m.index });
    }
  }
  return out;
}

function priceAndCycle(segments: string[]): Pick<SubscriptionRuleFields, "amount" | "cycle"> {
  const none = { amount: null, cycle: null };
  if (segments.some((s) => FOREIGN_CURRENCY.test(s) && /\$/.test(s))) return none;
  const candidates = priceCandidates(segments);
  // A receipt says "Total $99.00" on one line and "Billed annually" on another, so a labelled price may borrow the
  // one cycle the page states. An unlabelled price with no cycle of its own is a purchase, not a subscription.
  const stated = segments.flatMap((segment) => {
    const hit = cycleWordIn(segment);
    return hit ? [{ key: hit.cycle, value: leaf(hit.cycle, quoteAt(segment, hit.index)) }] : [];
  });
  const pageCycle = stated.length > 0 ? only(stated) : null;
  const strong = candidates.filter((c) => c.strong);
  const pool = strong.length > 0 ? strong : candidates.filter((c) => c.cycle !== null);
  const usable = pool.flatMap((c) => {
    if (c.cycle !== null) return [{ c, cycle: leaf(c.cycle, quoteAt(c.segment, c.index)) }];
    return pageCycle ? [{ c, cycle: pageCycle }] : [];
  });
  if (usable.length === 0) return none;
  const best = only(
    usable.map((u) => ({ key: `${u.c.amount}|${u.cycle.value}`, value: u })),
  );
  if (!best) return none;
  return { amount: leaf(best.c.amount, quoteAt(best.c.segment, best.c.index)), cycle: best.cycle };
}

// Dates

const NEXT_CHARGE =
  /\b(?:next\s+(?:charge|payment|bill|billing|renewal|invoice)|first\s+(?:charge|payment|bill)|renews?|renewal\s+date|auto-?renews?|will\s+(?:be\s+)?(?:automatically\s+)?(?:charged?|billed?)|you(?:'|’)ll\s+be\s+(?:charged|billed))\b/i;
/** The status of this plan, not a sentence about cancelling in general: that would clear real dates. */
const NOT_A_CHARGE =
  /\b(?:will\s+not|won(?:'|’)t|does\s+not|no\s+longer)\s+(?:\w+\s+)?(?:auto-?)?renew|\b(?:plan|subscription|membership)\s+(?:is|was|has\s+been)\s+cancel+ed\b|^(?:status:\s*)?cancel+ed\b/i;
/** A date after these words is behind us: "Renews monthly | Last invoice October 3, 2026". */
const PAST_DATE = /\b(?:last|previous|most\s+recent|past)\s+(?:invoice|payment|charge|bill|billing|renewal)\b/i;
const TRIAL_END =
  /\btrial\b[^.!?]*?\b(?:ends?|ending|expires?|expiring|through|until)\b|\b(?:ends?|expires?)\b[^.!?]*?\btrial\b/i;

/** The date a label points at: the first one after it, or the only one in the segment. */
function labelledDates(segments: string[], label: RegExp) {
  return segments.flatMap((segment) => {
    const m = label.exec(segment);
    if (!m) return [];
    const dates = datesIn(segment);
    const end = m.index + m[0].length;
    const date = dates.find((d) => d.index >= end) ?? (dates.length === 1 ? dates[0] : undefined);
    if (!date?.iso) return [];
    const lead = date.index < end ? segment.slice(Math.max(0, date.index - 24), date.index) : segment.slice(end, date.index);
    if (PAST_DATE.test(lead)) return [];
    return [{ key: date.iso, value: leaf(date.iso, quoteAt(segment, date.index)) }];
  });
}

const dateField = (segments: string[], label: RegExp): RuleLeaf<string> | null => {
  const found = labelledDates(segments, label);
  // A page that says the plan is over or will not renew has no next charge, whatever other dates it shows.
  if (label === NEXT_CHARGE && segments.some((s) => NOT_A_CHARGE.test(s))) return null;
  return found.length > 0 ? only(found) : null;
};

// Cancel terms

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, five: 5, seven: 7, ten: 10, fourteen: 14, thirty: 30 };
const CANCEL_NOTICE =
  /\bcancel\w*\b[^.!?]*?\b(\d{1,3}|one|two|three|five|seven|ten|fourteen|thirty)\s*(?:\(\d{1,3}\)\s*)?(business\s+days?|days?|hours?)\s+(?:before|prior)\b/i;
const CANCEL_HOW = /^(?:how\s+to\s+cancel|to\s+cancel)[^:,]{0,40}[:,]\s*(.{4,})$/i;
const CANCEL_ANYTIME = /^cancel\s+(?:any\s?time|at\s+any\s+time)\b.{0,160}$/i;

function cancelNotice(segments: string[]): RuleLeaf<number> | null {
  const found = segments.flatMap((segment) => {
    const m = CANCEL_NOTICE.exec(segment);
    if (!m) return [];
    const n = NUMBER_WORDS[m[1]!.toLowerCase()] ?? Number(m[1]);
    const unit = m[2]!.toLowerCase();
    // The field counts calendar days. Business days are a different number, and an hour count only fits in whole days.
    if (unit.startsWith("business") || (unit.startsWith("hour") && n % 24 !== 0)) return [];
    const days = unit.startsWith("hour") ? n / 24 : n;
    return [{ key: String(days), value: leaf(days, quoteAt(segment, m.index)) }];
  });
  return found.length > 0 ? only(found) : null;
}

function cancelMethod(segments: string[]): RuleLeaf<string> | null {
  for (const segment of segments) {
    const how = CANCEL_HOW.exec(segment);
    if (how) return leaf(how[1]!.slice(0, MAX_QUOTE), quoteAt(segment, 0));
    if (CANCEL_ANYTIME.test(segment)) return leaf(segment, quoteAt(segment, 0));
  }
  return null;
}

// Vendor, plan and account hint

const PROCESSORS = new Set(["stripe", "paypal", "paddle", "chargebee", "recurly", "fastspring", "gumroad", "lemonsqueezy"]);
const GENERIC = new Set(
  "account accounts billing bill checkout complete confirmed confirmation invoice manage manager membership memberships my order orders payment payments plan plans pricing receipt receipts settings subscription subscriptions thanks thank you your".split(
    " ",
  ),
);

const folded = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** The name a site goes by: `fernwood-streaming` from `account.fernwood-streaming.example`. */
function hostLabel(host: string): string | null {
  const parts = host.toLowerCase().replace(/^www\./, "").split(".").slice(0, -1);
  const last = parts.at(-1);
  const label = last && last.length <= 3 && parts.length > 1 ? parts.at(-2) : last;
  return label && !PROCESSORS.has(label) ? label : null;
}

function vendorOf(text: string, host: string | undefined): RuleLeaf<string> | null {
  const title = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean)?.slice(0, MAX_QUOTE);
  if (!title) return null;
  const parts = title
    .split(/\s+[|:·•–—-]\s+/)
    .map((p) => p.split(/\s+/).filter((w) => !GENERIC.has(w.toLowerCase())).join(" "))
    .filter((p) => folded(p).length > 0);
  const label = host ? hostLabel(host) : null;
  const named = parts.find((p) => {
    const f = folded(p);
    const l = label ? folded(label) : "";
    return l !== "" && (f.includes(l) || l.includes(f));
  });
  const name = named ?? parts[0];
  return name ? leaf(name, title) : null;
}

const PLAN = /^(?:your\s+|current\s+)?(?:plan(?:\s+name)?|membership|tier)\s*[:\-]\s*(.+)$/i;

function planOf(segments: string[]): RuleLeaf<string> | null {
  const found = segments.flatMap((segment) => {
    const m = PLAN.exec(segment);
    const value = m?.[1]?.split(/\s+[-–—]\s+|\$/)[0]?.trim();
    if (!value || value.length > MAX_PLAN) return [];
    return [{ key: value.toLowerCase(), value: leaf(value, quoteAt(segment, 0)) }];
  });
  return found.length > 0 ? only(found) : null;
}

/** Every run is bounded, so a line of stars cannot make matching slow. */
const MASKED_EMAIL = /[\w.+-]{0,3}\*{2,20}[\w.+-]{0,40}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,4}/;

function emailHint(segments: string[]): RuleLeaf<string> | null {
  for (const segment of segments) {
    const m = MASKED_EMAIL.exec(segment);
    if (m) return leaf(m[0], quoteAt(segment, m.index));
  }
  return null;
}

/** Reads one page of text. The first line is taken as the page title. Nothing here sets a field to confirmed. */
export function extractSubscriptionRules(text: string, hints: RuleHints = {}): SubscriptionRuleFields {
  const segments = segmentsOf(text);
  return {
    vendor: vendorOf(text, hints.host),
    plan: planOf(segments),
    ...priceAndCycle(segments),
    nextChargeDate: dateField(segments, NEXT_CHARGE),
    trialEndDate: dateField(segments, TRIAL_END),
    cancelNoticeDays: cancelNotice(segments),
    cancelMethod: cancelMethod(segments),
    accountEmailHint: emailHint(segments),
  };
}

/** A price with a cycle, a renewal date or a trial end. A vendor name alone is not a subscription. */
export const looksLikeSubscription = (f: SubscriptionRuleFields): boolean =>
  (f.amount !== null && f.cycle !== null) || f.nextChargeDate !== null || f.trialEndDate !== null;
