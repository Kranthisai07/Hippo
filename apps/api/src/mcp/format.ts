import type { Agreement, Doc, QuotedClause } from "core/src/contracts";
import type { Chunk } from "core/src/retrieval";
import { expandQuery } from "core/src/retrieval/synonyms";
import { contentStems, stem } from "core/src/retrieval/text";
import { addDays, daysBetween, type ObligationType } from "obligation-kit";
import { maskNumbers } from "./speak";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "November 12", or "November 12, 2027" when the year is not the current one. Reads the ISO date as written. */
export function speakDate(iso: string, today: string, withYear = false): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const month = MONTH_NAMES[Number(m[2]) - 1] ?? m[2];
  const day = Number(m[3]);
  return !withYear && m[1] === today.slice(0, 4) ? `${month} ${day}` : `${month} ${day}, ${m[1]}`;
}

/** "from November 12, 2025 to November 12, 2026": both years are said when the two dates are in different years. */
export function speakRange(start: string, end: string, today: string): string {
  const years = start.slice(0, 4) !== end.slice(0, 4);
  return `from ${speakDate(start, today, years)} to ${speakDate(end, today, years)}`;
}

/** "today", "tomorrow", "in 9 days" or "3 days ago". */
export function whenPhrase(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

export const capitalize = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

const KIND_WORDS = ["Warranty", "Insurance", "Lease", "Subscription", "Service"];

/** Labels from the deadline engine start with a kind word ("Insurance renews"). Spoken, that reads better in lower case. */
export function lowerKindWord(label: string): string {
  const first = label.split(" ")[0] ?? "";
  return KIND_WORDS.includes(first) ? first.toLowerCase() + label.slice(first.length) : label;
}

/** Types whose label already holds a verb ("car insurance renews"). The others are nouns ("lease notice deadline"). */
const VERB_TYPES: ReadonlySet<string> = new Set<ObligationType>(["expires", "renews", "trial_end"]);

export function typeFromRefId(refId: string): ObligationType | null {
  const m = /:(expires|renews|notice_by|charge|cancel_by|trial_end|service_due|claim_by):\d{4}-\d{2}-\d{2}$/.exec(
    refId,
  );
  return (m?.[1] as ObligationType | undefined) ?? null;
}

/** "your car insurance renews in 9 days" / "your lease notice deadline is in 11 days". */
export function deadlinePhrase(label: string, type: ObligationType | null, daysUntil: number): string {
  const subject = lowerKindWord(label);
  const when = whenPhrase(daysUntil);
  return type !== null && VERB_TYPES.has(type) ? `your ${subject} ${when}` : `your ${subject} is ${when}`;
}

export function daysUntil(today: string, iso: string): number {
  return daysBetween(today, iso);
}

export { addDays };

/** "warranty_dishwasher.pdf" becomes "warranty dishwasher". */
export function friendlyDocName(filename: string): string {
  return filename
    .replace(/\.[A-Za-z0-9]{1,5}$/, "")
    .replace(/[_-]+/g, " ")
    .trim();
}

export function docNameOf(doc: Doc | null | undefined): string {
  return doc?.filename ? doc.filename : "document";
}

/**
 * A clause for the result. The text is document text: untrusted, so it is only ever returned inside a structure marked
 * `quotedFromDocument`, with long numbers masked. A reader must treat it as data.
 */
export function quote(chunk: Chunk, docName: string): QuotedClause {
  return {
    docId: chunk.docId,
    docName,
    page: chunk.page,
    ...(chunk.heading ? { heading: maskNumbers(chunk.heading).slice(0, 500) } : {}),
    text: maskNumbers(chunk.text).slice(0, 6000),
    quotedFromDocument: true,
  };
}

const TRIM_WORDS = new Set([
  "from",
  "of",
  "to",
  "the",
  "a",
  "an",
  "and",
  "or",
  "by",
  "in",
  "for",
  "with",
  "resulting",
  "caused",
  "including",
  "that",
  "which",
  "is",
  "are",
  "on",
  "at",
]);

/** A short spoken lead from the start of a clause: at most `max` words, never ending on a joining word. */
export function clip(text: string, max: number): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length <= max) return words.join(" ").replace(/[.,;:]+$/, "");
  const kept = words.slice(0, max);
  while (kept.length > 1 && TRIM_WORDS.has(kept[kept.length - 1]!.toLowerCase().replace(/[.,;:]+$/, ""))) kept.pop();
  return kept.join(" ").replace(/[.,;:]+$/, "");
}

/** The sentences of a clause body, without its heading line. A line break also ends a sentence (policy lines). */
export function sentencesOf(chunk: Chunk): string[] {
  let body = chunk.text;
  if (chunk.heading && body.startsWith(chunk.heading)) body = body.slice(chunk.heading.length);
  return body
    .split(/(?<=[.!?])\s+|\n+/)
    .map((x) => x.replace(/\s+/g, " ").trim())
    .filter((x) => x.length > 0);
}

// Words that say little about WHICH problem a person has, so they do not make an exclusion relevant on their own.
const GENERIC = new Set(
  [
    "damage",
    "loss",
    "claim",
    "cover",
    "repair",
    "problem",
    "issue",
    "broken",
    "break",
    "insurance",
    "policy",
    "warranty",
    "car",
    "document",
  ].map(stem),
);

/** Stems of what the person said, plus the words the retrieval synonym table adds (leak: water damage, flood). */
function questionStems(question: string): Set<string> {
  return new Set(contentStems(`${question} ${expandQuery(question).join(" ")}`));
}

function overlap(sentence: string, stems: ReadonlySet<string>, ignoreGeneric: boolean): number {
  let n = 0;
  for (const t of new Set(contentStems(sentence))) if (stems.has(t) && !(ignoreGeneric && GENERIC.has(t))) n++;
  return n;
}

/** The sentence of a clause that shares the most words with the question (first on a tie), or null when none does. */
export function relevantSentence(
  chunk: Chunk,
  question: string,
  ignoreGeneric = false,
  only: RegExp | null = null,
): string | null {
  const stems = questionStems(question);
  let best: { s: string; n: number } | null = null;
  for (const s of sentencesOf(chunk)) {
    if (only && !only.test(s)) continue;
    const n = overlap(s, stems, ignoreGeneric);
    if (n > 0 && (!best || n > best.n)) best = { s, n };
  }
  return best ? best.s : null;
}

/** The sentence to quote when nothing in a clause matches the question: its first one. */
export const leadSentence = (chunk: Chunk): string => sentencesOf(chunk)[0] ?? "";

/** A sentence that says something is not covered. */
const EXCLUSION_SENTENCE = /\b(?:not\s+cover|does\s+not|do\s+not|exclu\w*|except|limitations?)\b/i;

const EXCLUDES = /^(?:this|the)\s+\w+\s+(?:also\s+)?(?:does\s+not|doesn't)\s+(?:cover|apply\s+to)\s+/i;

/** True when an exclusion clause has a sentence about the person's actual problem, not just a word like damage. */
export function exclusionApplies(chunk: Chunk, issue: string): boolean {
  return relevantSentence(chunk, issue, true, EXCLUSION_SENTENCE) !== null;
}

/** "damage caused by improper installation, including water damage", read out of the matching "does not cover ..." sentence. */
export function exclusionLead(chunk: Chunk, issue: string): string | null {
  const s = relevantSentence(chunk, issue, true, EXCLUSION_SENTENCE);
  const m = s ? EXCLUDES.exec(s) : null;
  if (!s || !m) return null;
  const lead = clip(s.slice(m[0].length), 9);
  return lead.length > 0 ? lead : null;
}

export const str = (f: Record<string, unknown>, k: string): string | null => {
  const v = f[k];
  return typeof v === "string" && v.trim() !== "" ? v : null;
};
export const num = (f: Record<string, unknown>, k: string): number | null => {
  const v = f[k];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};
export const strList = (f: Record<string, unknown>, k: string): string[] => {
  const v = f[k];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
};

/** The page of item `i` of a list field, or of a single field, when the source says. */
export function pageOf(a: Agreement, key: string, i?: number): number | null {
  const ref = a.sourceRefs[key];
  if (ref === undefined) return null;
  const one = Array.isArray(ref) ? (i === undefined ? ref[0] : ref[i]) : "page" in ref ? ref : undefined;
  return one && typeof one.page === "number" ? one.page : null;
}
