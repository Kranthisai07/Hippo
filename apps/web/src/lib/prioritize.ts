import { daysBetween } from "./format";
import type { ObligationItem, ObligationType, Subscription } from "./types";

// The "You are all set" list, ordered the way the Coming up page is: what needs a decision first (a cancel by date or the
// end of a trial), then renewals and charges, soonest first. A pure function, so it is tested without a screen.

export type Group = "soon" | "month" | "later" | "none";

export const GROUP_LABEL: Record<Group, string> = {
  soon: "Needs you soon",
  month: "Within a month",
  later: "Later",
  none: "No date found",
};
export const GROUPS: Group[] = ["soon", "month", "later", "none"];

export const SOON_DAYS = 14;
export const MONTH_DAYS = 31;

/** Dates that ask the person to do something before they pass. */
const ACT: ReadonlySet<ObligationType> = new Set(["cancel_by", "trial_end", "notice_by"]);
const KEY_TYPES: ReadonlySet<ObligationType> = new Set([...ACT, "renews", "charge", "expires"]);

export interface KeyDate {
  type: ObligationType;
  date: string;
  days: number;
}

export interface Row {
  sub: Subscription;
  key: KeyDate | null;
  group: Group;
}

const groupOf = (days: number | null): Group =>
  days === null ? "none" : days <= SOON_DAYS ? "soon" : days <= MONTH_DAYS ? "month" : "later";

export function prioritize(subs: Subscription[], items: ObligationItem[], today: string): Record<Group, Row[]> {
  const byDoc = new Map<string, ObligationItem[]>();
  for (const it of items) {
    if (!it.docId || !KEY_TYPES.has(it.obligation.type)) continue;
    byDoc.set(it.docId, [...(byDoc.get(it.docId) ?? []), it]);
  }

  const rows: Row[] = subs.map((sub) => {
    const mine = sub.docId ? (byDoc.get(sub.docId) ?? []) : [];
    const dates: KeyDate[] = mine
      .map((it) => ({ type: it.obligation.type, date: it.obligation.dueDate }))
      .concat(sub.nextChargeDate && !mine.length ? [{ type: "charge" as const, date: sub.nextChargeDate }] : [])
      .map((d) => ({ ...d, days: daysBetween(today, d.date) }))
      .filter((d) => d.days >= 0);
    // The soonest date; on a tie the one that asks for a decision.
    dates.sort((a, b) => a.days - b.days || Number(ACT.has(b.type)) - Number(ACT.has(a.type)));
    const key = dates[0] ?? null;
    return { sub, key, group: groupOf(key?.days ?? null) };
  });

  const order = (r: Row): [number, number, string] => [
    r.key && ACT.has(r.key.type) ? 0 : 1,
    r.key?.days ?? Number.MAX_SAFE_INTEGER,
    r.sub.vendor.toLowerCase(),
  ];
  rows.sort((x, y) => {
    const a = order(x);
    const b = order(y);
    return a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2]);
  });

  const out: Record<Group, Row[]> = { soon: [], month: [], later: [], none: [] };
  for (const r of rows) out[r.group].push(r);
  return out;
}
