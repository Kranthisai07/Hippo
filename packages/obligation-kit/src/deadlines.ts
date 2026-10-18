import { addDays, addMonths, daysBetween, daysInMonth, parseIso, subtractBusinessDays } from "./dates";
import { severityFor, type ObligationType, type Severity } from "./severity";

// Same five values as the resolver's AgreementKind in packages/core. Merge them into one definition in the T1.1 contracts.
export type AgreementKind = "warranty" | "insurance" | "lease" | "subscription" | "service_plan";
export type FieldStatus = "extracted" | "confirmed" | "edited";

/** Flat field values named as in SPEC section 4. A missing or null field yields no obligation (never a guess). */
export interface AgreementInput {
  kind: AgreementKind;
  fields: Record<string, unknown>;
  /** Anything not listed counts as unconfirmed. Voice-added dates are passed in as confirmed. */
  fieldStatus?: Record<string, FieldStatus>;
}

export interface Obligation {
  type: ObligationType;
  dueDate: string;
  daysUntil: number;
  label: string;
  /** True only when every field the date depends on is confirmed or edited. */
  confirmed: boolean;
  /** Null for unconfirmed, past, or beyond 30 days. Unconfirmed never alerts. */
  severity: Severity | null;
  sourceFields: string[];
}

const KIND_LABEL: Record<AgreementKind, string> = {
  warranty: "Warranty",
  insurance: "Insurance",
  lease: "Lease",
  subscription: "Subscription",
  service_plan: "Service",
};

const TYPE_LABEL: Record<ObligationType, string> = {
  expires: "expires",
  renews: "renews",
  notice_by: "give notice by",
  charge: "next charge",
  cancel_by: "cancel by",
  trial_end: "trial ends",
  service_due: "service due",
  claim_by: "file claim by",
};

const date = (f: Record<string, unknown>, k: string): string | null => (parseIso(f[k]) === null ? null : (f[k] as string));
const count = (f: Record<string, unknown>, k: string): number | null => {
  const v = f[k];
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
};
const present = (f: Record<string, unknown>, k: string): boolean => f[k] !== null && f[k] !== undefined;

// The cycle comes from a model as free text, so accept the common spellings. T1.1 should make it an enum.
const MONTHS_PER_CYCLE: Record<string, number> = {
  monthly: 1,
  month: 1,
  "per month": 1,
  "every month": 1,
  quarterly: 3,
  semiannual: 6,
  "semi-annual": 6,
  "six-month": 6,
  annual: 12,
  annually: 12,
  yearly: 12,
  year: 12,
  "per year": 12,
  "every year": 12,
};

const DAYS_PER_CYCLE: Record<string, number> = {
  weekly: 7,
  week: 7,
  "per week": 7,
  "every week": 7,
  biweekly: 14,
  "bi-weekly": 14,
  fortnightly: 14,
  "every two weeks": 14,
  "every 2 weeks": 14,
};

/** Next charge on or after today. Steps from the original date so Jan 31 stays on the 31st when it can. */
function rollForward(first: string, cycle: unknown, today: string): { date: string; rolled: boolean } {
  const c = typeof cycle === "string" ? cycle.trim().toLowerCase().replace(/\s+/g, " ") : "";
  if (daysBetween(today, first) >= 0) return { date: first, rolled: false };
  const days = DAYS_PER_CYCLE[c];
  if (days) return { date: addDays(first, Math.ceil(daysBetween(first, today) / days) * days), rolled: true };
  const step = MONTHS_PER_CYCLE[c];
  if (!step) return { date: first, rolled: false }; // shortcut: unknown cycle is not rolled, past date stays and never alerts
  let k = 1;
  while (daysBetween(today, addMonths(first, k * step)) < 0) k++;
  return { date: addMonths(first, k * step), rolled: true };
}

/** Next occurrence of a day-of-month on or after today, clamped to short months. */
function nextMonthly(day: number, today: string): string {
  const [y, m] = today.split("-").map(Number) as [number, number];
  for (let i = 0; i < 2; i++) {
    const total = y * 12 + (m - 1) + i;
    const yy = Math.floor(total / 12);
    const mm = total % 12;
    const d = Math.min(day, daysInMonth(yy, mm));
    const iso = `${String(yy).padStart(4, "0")}-${String(mm + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (daysBetween(today, iso) >= 0) return iso;
  }
  throw new Error("unreachable");
}

/** Incident date plus a claim window. Computed at check time, so it is not part of computeObligations. */
export function claimByDate(incidentDate: string, windowDays: number): string {
  return addDays(incidentDate, windowDays);
}

/** Pure: confirmed fields plus today's date in, dated obligations out. Sorted by due date, then type. */
export function computeObligations(agreement: AgreementInput, today: string): Obligation[] {
  if (parseIso(today) === null) throw new RangeError(`today is not an ISO date: ${String(today)}`);
  const { kind, fields: f } = agreement;
  const status = agreement.fieldStatus ?? {};
  const out: Obligation[] = [];

  /** alert=false keeps an obligation on the timeline but never gives it a severity (rent, D-020). */
  const push = (type: ObligationType, dueDate: string, sourceFields: string[], alert = true) => {
    const confirmed = sourceFields.every((k) => status[k] === "confirmed" || status[k] === "edited");
    const daysUntil = daysBetween(today, dueDate);
    out.push({
      type,
      dueDate,
      daysUntil,
      label: `${KIND_LABEL[kind]} ${TYPE_LABEL[type]}`,
      confirmed,
      severity: alert ? severityFor(type, daysUntil, confirmed) : null,
      sourceFields,
    });
  };

  if (kind === "warranty") {
    const end = date(f, "endDate");
    const start = date(f, "startDate");
    const term = count(f, "termMonths");
    if (end) push("expires", end, ["endDate"]);
    else if (start && term !== null) push("expires", addMonths(start, term), ["startDate", "termMonths"]);
  }

  if (kind === "insurance") {
    const exp = date(f, "expirationDate");
    if (exp) {
      // shortcut: an auto-renewing policy whose date has passed is not rolled forward, re-confirm after renewal
      if (f.renewal === "auto") push("renews", exp, ["expirationDate", "renewal"]);
      else push("expires", exp, present(f, "renewal") ? ["expirationDate", "renewal"] : ["expirationDate"]);
    }
  }

  if (kind === "lease") {
    const end = date(f, "endDate");
    const notice = count(f, "noticeDaysToVacate");
    if (end) push("expires", end, ["endDate"]);
    if (end && notice !== null) {
      const business = f.noticeDaysType === "business";
      push("notice_by", business ? subtractBusinessDays(end, notice) : addDays(end, -notice), [
        "endDate",
        "noticeDaysToVacate",
        ...(present(f, "noticeDaysType") ? ["noticeDaysType"] : []),
      ]);
    }
    const day = count(f, "rentDueDay");
    if (day !== null && day >= 1 && day <= 31) {
      const due = nextMonthly(day, today);
      if (!end || daysBetween(due, end) >= 0) push("charge", due, ["rentDueDay"], false);
    }
  }

  if (kind === "subscription") {
    const next = date(f, "nextChargeDate");
    const trial = date(f, "trialEndDate");
    const notice = count(f, "cancelNoticeDays");
    const charge = next ? rollForward(next, f.cycle, today) : null;
    // A trial that ends on its first charge day is one event, so a confirmed trial_end covers it and charge is not
    // repeated. If the trial end is not confirmed it cannot alert, so the confirmed charge is kept.
    const trialCovers = trial && (status.trialEndDate === "confirmed" || status.trialEndDate === "edited");
    if (next && charge && !(trialCovers && charge.date === trial)) {
      push("charge", charge.date, charge.rolled ? ["nextChargeDate", "cycle"] : ["nextChargeDate"]);
    }
    if (trial) push("trial_end", trial, ["trialEndDate"]);
    if (notice !== null) {
      // While a trial is still running, the deadline is set by the trial end, not the later regular charge.
      if (trial && daysBetween(today, trial) >= 0) push("cancel_by", addDays(trial, -notice), ["trialEndDate", "cancelNoticeDays"]);
      else if (next && charge) {
        push("cancel_by", addDays(charge.date, -notice), [
          "nextChargeDate",
          "cancelNoticeDays",
          ...(charge.rolled ? ["cycle"] : []),
        ]);
      }
    }
  }

  if (kind === "service_plan") {
    const last = date(f, "lastServiceDate");
    const interval = count(f, "intervalDays");
    const next = date(f, "nextServiceDate");
    if (last && interval !== null) push("service_due", addDays(last, interval), ["lastServiceDate", "intervalDays"]);
    else if (next) push("service_due", next, ["nextServiceDate"]);
  }

  return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.type.localeCompare(b.type));
}
