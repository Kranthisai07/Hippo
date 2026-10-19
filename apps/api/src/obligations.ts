import type { Agreement, Alert, Asset, ObligationRecord, Repository } from "core/src/contracts";
import { computeObligations, type ObligationType } from "obligation-kit";
import { capitalize, lowerGeneric } from "./mcp/format";

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

function subjectOf(agreement: Agreement, assets: Asset[]): string {
  const f = agreement.fields;
  const asset = assets.find((a) => agreement.assetIds.includes(a.id));
  const named = asset ? lowerGeneric(asset.name) : null;
  switch (agreement.kind) {
    case "warranty":
      return `${named ?? "product"} warranty`;
    case "insurance":
      return `${named ?? (typeof f.policyType === "string" ? f.policyType : "")} insurance`.trim();
    case "lease":
      return "lease";
    case "subscription":
      return typeof f.vendor === "string" && f.vendor ? f.vendor : (agreement.party ?? "subscription");
    case "service_plan":
      return `${named ?? "service plan"}`;
  }
}

export const obligationId = (agreementId: string, type: ObligationType, dueDate: string): string =>
  `${agreementId}:${type}:${dueDate}`;
export const alertIdFor = (obligation: string): string => `alert-${obligation}`;

/** Obligation records for one agreement as of `today`. The label is what is spoken ("car insurance renews"). */
export function buildObligations(agreement: Agreement, assets: Asset[], today: string): ObligationRecord[] {
  const subject = subjectOf(agreement, assets);
  const assetId = agreement.assetIds[0];
  return computeObligations(
    { kind: agreement.kind, fields: agreement.fields, fieldStatus: agreement.fieldStatus },
    today,
  ).map((o) => {
    const phrase = agreement.kind === "lease" && o.type === "charge" ? "rent due" : PHRASE[o.type];
    return {
      id: obligationId(agreement.id, o.type, o.dueDate),
      type: o.type,
      dueDate: o.dueDate,
      agreementId: agreement.id,
      ...(assetId ? { assetId } : {}),
      label: `${subject} ${phrase}`,
      confirmed: o.confirmed,
      severity: o.severity,
    };
  });
}

/**
 * Replaces the agreement's obligations and raises an alert for each confirmed one inside the alert window. An alert
 * that already exists keeps its status, so announced, done and dismissed stay that way.
 */
export async function syncObligations(
  repo: Repository,
  householdId: string,
  agreement: Agreement,
  assets: Asset[],
  today: string,
): Promise<ObligationRecord[]> {
  const records = buildObligations(agreement, assets, today);
  await repo.replaceObligations(householdId, agreement.id, records);
  for (const o of records) {
    if (!o.confirmed || o.severity === null) continue;
    const id = alertIdFor(o.id);
    if (await repo.getAlert(householdId, id)) continue;
    const alert: Alert = {
      id,
      source: "deadline",
      severity: o.severity,
      status: "pending",
      label: capitalize(o.label),
      dueDate: o.dueDate,
      refId: o.id,
      ...(o.assetId ? { assetId: o.assetId } : {}),
    };
    await repo.putAlert(householdId, alert);
  }
  return records;
}
