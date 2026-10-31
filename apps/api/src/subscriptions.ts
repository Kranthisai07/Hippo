import type { Agreement, Doc, Repository } from "core/src/contracts";
import { computeObligations } from "obligation-kit";
import { pageOf } from "./mcp/format";
import { maskNumbers } from "./mcp/speak";

export interface SubscriptionView {
  agreementId: string;
  docId: string | null;
  vendor: string;
  plan: string | null;
  amount: number | null;
  cycle: string | null;
  nextChargeDate: string | null;
  /** True when a person confirmed the price, the cycle and any next charge date. Only these count in the total. */
  confirmed: boolean;
  /** Where the price came from. Null for a subscription added by voice. */
  source: { docName: string; page: number | null } | null;
}

/** How many charges a cycle makes in a year. */
const PER_YEAR: Record<string, number> = {
  weekly: 52,
  biweekly: 26,
  monthly: 12,
  quarterly: 4,
  semiannual: 2,
  annual: 1,
};

const reviewed = (a: Agreement, field: string): boolean =>
  a.fieldStatus[field] === "confirmed" || a.fieldStatus[field] === "edited";

/** The page behind what the card shows: the price, or the dates when the page gave no price. */
const firstPage = (a: Agreement): number | null =>
  ["amount", "nextChargeDate", "trialEndDate", "vendor"].map((f) => pageOf(a, f)).find((p) => p !== null) ?? null;

function viewOf(a: Agreement, today: string, docs: Map<string, Doc>): SubscriptionView {
  const { amount, cycle, nextChargeDate, plan, vendor } = a.fields;
  const charge = computeObligations({ kind: a.kind, fields: a.fields, fieldStatus: a.fieldStatus }, today).find(
    (o) => o.type === "charge",
  );
  const doc = a.docId ? docs.get(a.docId) : undefined;
  const name = typeof vendor === "string" ? vendor : (a.party ?? "Subscription");
  return {
    agreementId: a.id,
    docId: a.docId ?? null,
    vendor: maskNumbers(name),
    plan: typeof plan === "string" ? maskNumbers(plan) : null,
    amount: typeof amount === "number" ? amount : null,
    cycle: typeof cycle === "string" ? cycle : null,
    // The engine rolls a billing date forward. A trial has no charge obligation yet, so its first charge date is read as is.
    nextChargeDate: charge?.dueDate ?? (typeof nextChargeDate === "string" ? nextChargeDate : null),
    confirmed:
      reviewed(a, "amount") &&
      reviewed(a, "cycle") &&
      (typeof nextChargeDate !== "string" || reviewed(a, "nextChargeDate")),
    source: doc ? { docName: maskNumbers(doc.filename), page: firstPage(a) } : null,
  };
}

/** Every subscription of the household, by vendor, and what the confirmed ones cost a month. */
export async function listSubscriptions(repo: Repository, householdId: string, today: string) {
  const agreements = (await repo.listAgreements(householdId)).filter((a) => a.kind === "subscription");
  const docs = new Map((await repo.listDocs(householdId)).map((d) => [d.id, d]));
  const all = agreements.map((a) => viewOf(a, today, docs)).sort((x, y) => x.vendor.localeCompare(y.vendor));
  const yearly = all.reduce(
    (sum, s) => sum + (s.confirmed && s.amount !== null ? s.amount * (PER_YEAR[s.cycle ?? ""] ?? 0) : 0),
    0,
  );
  return { subscriptions: all.slice(0, 200), monthlyTotal: Math.round((yearly / 12) * 100) / 100 };
}
