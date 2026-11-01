import type { ObligationType, SourceRef, SourceRefTree } from "./types";

// Everything here returns plain strings. Callers render them as React text children, never as HTML.

export function humanize(name: string): string {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** A value as lines of text. Groups become "part: value" lines, lists become one line per item. */
export function valueLines(value: unknown): string[] {
  if (value === null || value === undefined || value === "") return ["Not stated"];
  if (Array.isArray(value)) return value.length ? value.flatMap((v) => valueLines(v)) : ["Not stated"];
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      valueLines(v).map((line, i) => (i === 0 ? `${humanize(k)}: ${line}` : line)),
    );
  }
  if (typeof value === "boolean") return [value ? "Yes" : "No"];
  return [String(value)];
}

/** Only a single text or number value can be edited as one value (the server refuses groups and lists). */
export const isEditable = (value: unknown): value is string | number =>
  typeof value === "string" || typeof value === "number";

export interface Ref extends SourceRef {
  part?: string;
}

export function collectRefs(tree: SourceRefTree | null): Ref[] {
  if (!tree) return [];
  if (Array.isArray(tree)) return tree;
  if (typeof (tree as SourceRef).page === "number" && typeof (tree as SourceRef).quote === "string") {
    return [tree as SourceRef];
  }
  return Object.entries(tree as Record<string, SourceRef>).map(([part, r]) => ({ part: humanize(part), ...r }));
}

// ISO dates (YYYY-MM-DD) are compared as UTC days so time zones cannot move them.
const dayNumber = (iso: string): number => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
export const addDays = (iso: string, n: number): string =>
  new Date((dayNumber(iso) + n) * 86_400_000).toISOString().slice(0, 10);
export const daysBetween = (fromIso: string, toIso: string): number =>
  Math.round(dayNumber(toIso) - dayNumber(fromIso));

export function daysAwayText(today: string, due: string): string {
  const n = daysBetween(today, due);
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n === -1) return "1 day ago";
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function chipParts(iso: string): { month: string; day: string } {
  const [, m, d] = iso.split("-");
  return { month: MONTHS[Number(m) - 1] ?? "", day: String(Number(d)) };
}

/** "2026-11-03" as "Nov 3, 2026". Anything that is not an ISO date comes back unchanged. */
export function readableDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && month ? `${month} ${Number(m[3])}, ${m[1]}` : iso;
}

export const KIND_LABEL: Record<ObligationType | "recall", string> = {
  expires: "Expires",
  renews: "Renewals",
  notice_by: "Notice",
  charge: "Charges",
  cancel_by: "Cancel by",
  trial_end: "Trials",
  service_due: "Service",
  claim_by: "Claims",
  recall: "Recalls",
};

const ACTION: Record<ObligationType, string> = {
  expires: "Expires on",
  renews: "Renews on",
  notice_by: "Give notice by",
  charge: "Next charge on",
  cancel_by: "Cancel by",
  trial_end: "Trial ends on",
  service_due: "Service due on",
  claim_by: "File a claim by",
};

export const plainAction = (type: ObligationType, dueDate: string, label = ""): string =>
  `${type === "charge" && /rent due/i.test(label) ? "Rent due on" : ACTION[type]} ${dueDate}`;

/** Which field a deadline was computed from, so the page can quote the clause. First match wins. */
export const SOURCE_FIELDS: Record<ObligationType, string[]> = {
  notice_by: ["noticeDaysToVacate", "endDate"],
  expires: ["endDate", "expirationDate"],
  renews: ["expirationDate", "endDate", "nextChargeDate"],
  cancel_by: ["cancelNoticeDays", "nextChargeDate"],
  charge: ["nextChargeDate"],
  trial_end: ["trialEndDate"],
  service_due: ["nextServiceDate", "intervalDays"],
  claim_by: ["claimWindowDays", "claimReportWindowDays", "endDate"],
};

export const DEMO_TODAY_NOTE = "The date comes from the server clock.";
