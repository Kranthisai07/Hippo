export type ObligationType =
  | "expires"
  | "renews"
  | "notice_by"
  | "charge"
  | "cancel_by"
  | "trial_end"
  | "service_due"
  | "claim_by";

export type Severity = "high" | "possible";

/** Only obligations due within this many days can alert at all (SPEC section 5). */
export const ALERT_WINDOW_DAYS = 30;

/** High severity window per type (D-015). trial_end and claim_by use 7 days: an assumption, change it here. */
export const HIGH_WITHIN_DAYS: Record<ObligationType, number> = {
  expires: 14,
  renews: 14,
  notice_by: 14,
  cancel_by: 14,
  charge: 7,
  service_due: 7,
  trial_end: 7,
  claim_by: 7,
};

/** Null means "never alert": unconfirmed, already past, or outside the 30 day window. */
export function severityFor(type: ObligationType, daysUntil: number, confirmed: boolean): Severity | null {
  if (!confirmed || daysUntil < 0 || daysUntil > ALERT_WINDOW_DAYS) return null;
  return daysUntil <= HIGH_WITHIN_DAYS[type] ? "high" : "possible";
}
