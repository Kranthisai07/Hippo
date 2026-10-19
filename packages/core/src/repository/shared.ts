import type { Alert, Asset, Agreement, Doc, ObligationRecord, ServiceEvent } from "../contracts";

// Pure helpers shared by the memory and the DynamoDB repositories, so both order and cascade identically.
// Nothing here imports the AWS SDK.

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function assertHouseholdId(householdId: string): void {
  if (typeof householdId !== "string" || householdId.length === 0)
    throw new Error("householdId must be a non-empty string");
}

export const byNameThenId = (a: Asset, b: Asset): number => cmp(a.name, b.name) || cmp(a.id, b.id);
export const byUploadedDescThenId = (a: Doc, b: Doc): number => cmp(b.uploadedAt, a.uploadedAt) || cmp(a.id, b.id);
export const byCreatedThenId = (a: Agreement, b: Agreement): number => cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id);
export const byDueThenId = (a: ObligationRecord, b: ObligationRecord): number =>
  cmp(a.dueDate, b.dueDate) || cmp(a.id, b.id);
export const byTsDescThenId = (a: ServiceEvent, b: ServiceEvent): number => cmp(b.ts, a.ts) || cmp(a.id, b.id);

export const SEVERITY_RANK = { high: 0, possible: 1 } as const;

/** High severity first, then earliest due date (no due date last), then id. */
export const byAlertOrder = (a: Alert, b: Alert): number =>
  SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || cmp(a.dueDate ?? "￿", b.dueDate ?? "￿") || cmp(a.id, b.id);

export const isOpenAlert = (a: Alert): boolean => a.status === "pending" || a.status === "announced";

/**
 * Where the ingest worker keeps the per-page text of a document (SPEC section 7 says only "store page texts in S3").
 * The layout is our choice, kept here so the delete cascade and the worker agree on it.
 */
export function pageTextKey(householdId: string, docId: string): string {
  return `text/${householdId}/${docId}/pages.json`;
}

/** Every S3 key a document owns: the original, its page text and its chunk file. Unique and sorted. */
export function s3KeysForDoc(householdId: string, doc: Doc, chunkS3Key: string | undefined): string[] {
  const keys = [doc.s3Key, pageTextKey(householdId, doc.id)];
  if (chunkS3Key) keys.push(chunkS3Key);
  return [...new Set(keys)].sort();
}

/** The ids of everything derived from one document, given the household's agreements, obligations and alerts. */
export function derivedFromDoc(
  docId: string,
  agreements: Agreement[],
  obligations: ObligationRecord[],
  alerts: Alert[],
): { agreementIds: string[]; obligationIds: string[]; alertIds: string[] } {
  const agreementIds = agreements.filter((a) => a.docId === docId).map((a) => a.id);
  const agSet = new Set(agreementIds);
  const obligationIds = obligations
    .filter((o) => o.agreementId !== undefined && agSet.has(o.agreementId))
    .map((o) => o.id);
  const obSet = new Set(obligationIds);
  const alertIds = alerts.filter((a) => a.source === "deadline" && obSet.has(a.refId)).map((a) => a.id);
  return { agreementIds, obligationIds, alertIds };
}
