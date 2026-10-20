import type { Agreement, Alert, Asset, ObligationRecord, Repository } from "core/src/contracts";
import { computeObligations, type ObligationType } from "obligation-kit";
import type { HouseholdReport, RunError } from "./types";

// Steps 1 and 2 of SPEC section 10. Ids match apps/api/src/obligations.ts, so the voice path and this job never make
// two alerts for one obligation.
export const obligationId = (agreementId: string, type: ObligationType, dueDate: string): string =>
  `${agreementId}:${type}:${dueDate}`;
export const alertIdFor = (obligation: string): string => `alert-${obligation}`;

const PHRASE: Record<ObligationType, string> = {
  expires: "expires",
  renews: "renews",
  notice_by: "notice deadline",
  cancel_by: "cancel-by date",
  charge: "next charge",
  trial_end: "trial ends",
  service_due: "service date",
  claim_by: "claim deadline",
};

const capitalize = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function subjectOf(agreement: Agreement, assets: Asset[]): string {
  const f = agreement.fields;
  const asset = assets.find((a) => agreement.assetIds.includes(a.id));
  switch (agreement.kind) {
    case "warranty":
      return `${asset?.name ?? "product"} warranty`;
    case "insurance":
      return `${asset?.name ?? (typeof f.policyType === "string" ? f.policyType : "")} insurance`.trim();
    case "lease":
      return "lease";
    case "subscription":
      return typeof f.vendor === "string" && f.vendor ? f.vendor : (agreement.party ?? "subscription");
    case "service_plan":
      return asset?.name ?? "service plan";
  }
}

export function buildObligations(agreement: Agreement, assets: Asset[], today: string): ObligationRecord[] {
  const subject = subjectOf(agreement, assets);
  const assetId = agreement.assetIds[0];
  return computeObligations(
    { kind: agreement.kind, fields: agreement.fields, fieldStatus: agreement.fieldStatus },
    today,
  ).map((o) => ({
    id: obligationId(agreement.id, o.type, o.dueDate),
    type: o.type,
    dueDate: o.dueDate,
    agreementId: agreement.id,
    ...(assetId ? { assetId } : {}),
    label: `${subject} ${agreement.kind === "lease" && o.type === "charge" ? "rent due" : PHRASE[o.type]}`,
    confirmed: o.confirmed,
    severity: o.severity,
  }));
}

type Counts = Pick<
  HouseholdReport,
  "obligationsComputed" | "alertsCreated" | "alertsRefreshed" | "alertsLeftAlone" | "alertsDismissed"
>;

/**
 * Recomputes every agreement's obligations, then creates, refreshes or dismisses deadline alerts.
 * Only an obligation that is confirmed AND has a severity can have an alert (D-006); rent never has a severity (D-020).
 */
export async function syncDeadlines(
  repo: Repository,
  householdId: string,
  today: string,
): Promise<{ counts: Counts; errors: RunError[] }> {
  const counts: Counts = {
    obligationsComputed: 0,
    alertsCreated: 0,
    alertsRefreshed: 0,
    alertsLeftAlone: 0,
    alertsDismissed: 0,
  };
  const errors: RunError[] = [];
  const assets = await repo.listAssets(householdId);
  const wanted = new Map<string, ObligationRecord>();
  let allComputed = true;

  for (const agreement of await repo.listAgreements(householdId)) {
    let records: ObligationRecord[];
    try {
      records = buildObligations(agreement, assets, today);
    } catch {
      // Bad data in one agreement must not stop the others, nor dismiss alerts we could not recompute.
      allComputed = false;
      errors.push({
        source: "obligations",
        kind: "unexpected",
        message: `could not compute obligations for agreement ${agreement.id}`,
      });
      continue;
    }
    await repo.replaceObligations(householdId, agreement.id, records);
    counts.obligationsComputed += records.length;
    for (const o of records) if (o.confirmed && o.severity !== null) wanted.set(alertIdFor(o.id), o);
  }

  const existing = new Map((await repo.listAlerts(householdId)).map((a) => [a.id, a]));

  for (const [id, o] of wanted) {
    const label = capitalize(o.label);
    const old = existing.get(id);
    if (!old) {
      const alert: Alert = {
        id,
        source: "deadline",
        severity: o.severity!,
        status: "pending",
        label,
        dueDate: o.dueDate,
        refId: o.id,
        ...(o.assetId ? { assetId: o.assetId } : {}),
      };
      await repo.putAlert(householdId, alert);
      counts.alertsCreated++;
      continue;
    }
    // Done and dismissed stay closed. An announced alert stays announced; only its severity can rise as the date nears.
    const open = old.status === "pending" || old.status === "announced";
    if (open && old.severity === "possible" && o.severity === "high") {
      await repo.putAlert(householdId, { ...old, severity: "high" });
      counts.alertsRefreshed++;
    } else {
      counts.alertsLeftAlone++;
    }
  }

  if (allComputed) {
    for (const old of existing.values()) {
      if (old.source !== "deadline" || old.status !== "pending" || wanted.has(old.id)) continue;
      await repo.putAlert(householdId, { ...old, status: "dismissed" });
      counts.alertsDismissed++;
    }
  }
  return { counts, errors };
}
