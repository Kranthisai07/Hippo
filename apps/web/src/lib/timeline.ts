import { daysBetween } from "./format";
import type { Alert, ObligationItem, ObligationType } from "./types";

export interface Entry {
  key: string;
  date: string | null;
  type: ObligationType | "recall";
  label: string;
  detail?: string;
  severity: "high" | "possible" | null;
  confirmed: boolean;
  docId?: string;
  assetId?: string;
  /** The open alert behind this entry. Only ever set on confirmed entries. */
  alert?: Alert;
}

const TYPES: ObligationType[] = [
  "expires",
  "renews",
  "notice_by",
  "charge",
  "cancel_by",
  "trial_end",
  "service_due",
  "claim_by",
];
const isOpen = (a: Alert) => a.status === "pending" || a.status === "announced";

/**
 * Merges obligations and open alerts. A date nobody has confirmed goes only into `unconfirmed`, has no severity and
 * no alert, whatever else arrives. Alerts that match no obligation (recalls, dates outside the window) stand alone.
 */
export function buildTimeline(items: ObligationItem[], alerts: Alert[]): { confirmed: Entry[]; unconfirmed: Entry[] } {
  const openByRef = new Map(alerts.filter(isOpen).map((a) => [a.refId, a]));
  const seen = new Set<string>();
  const confirmed: Entry[] = [];
  const unconfirmed: Entry[] = [];

  for (const it of items) {
    const o = it.obligation;
    seen.add(o.id);
    const base = {
      key: o.id,
      date: o.dueDate,
      type: o.type,
      label: o.label,
      ...(it.docId ? { docId: it.docId } : {}),
      ...((it.assetId ?? o.assetId) ? { assetId: (it.assetId ?? o.assetId)! } : {}),
    };
    if (it.needsConfirmation || !o.confirmed) {
      unconfirmed.push({ ...base, severity: null, confirmed: false });
      continue;
    }
    const alert = openByRef.get(o.id);
    confirmed.push({ ...base, severity: alert?.severity ?? o.severity, confirmed: true, ...(alert ? { alert } : {}) });
  }

  for (const a of alerts) {
    if (!isOpen(a) || seen.has(a.refId)) continue;
    const parsed = a.refId.split(":").at(-2) as ObligationType | undefined;
    confirmed.push({
      key: a.id,
      date: a.dueDate ?? null,
      type: a.source === "recall" ? "recall" : parsed && TYPES.includes(parsed) ? parsed : "expires",
      label: a.label,
      ...(a.detail ? { detail: a.detail } : {}),
      severity: a.severity,
      confirmed: true,
      ...(a.assetId ? { assetId: a.assetId } : {}),
      alert: a,
    });
  }
  return { confirmed, unconfirmed };
}

const rank = (s: Entry["severity"]) => (s === "high" ? 0 : s === "possible" ? 1 : 2);

/** Week buckets relative to today, high before possible inside a bucket. */
export function groupByWeek(entries: Entry[], today: string): { title: string; entries: Entry[] }[] {
  const bucketOf = (e: Entry): number => (e.date ? Math.floor(daysBetween(today, e.date) / 7) : 99);
  const sorted = [...entries].sort(
    (a, b) =>
      bucketOf(a) - bucketOf(b) || rank(a.severity) - rank(b.severity) || (a.date ?? "").localeCompare(b.date ?? ""),
  );
  const out: { title: string; entries: Entry[] }[] = [];
  for (const e of sorted) {
    const b = bucketOf(e);
    const title =
      b < 0 ? "Past due" : b === 0 ? "This week" : b === 1 ? "Next week" : b === 99 ? "No date" : `In ${b} weeks`;
    const last = out.at(-1);
    if (last && last.title === title) last.entries.push(e);
    else out.push({ title, entries: [e] });
  }
  return out;
}
