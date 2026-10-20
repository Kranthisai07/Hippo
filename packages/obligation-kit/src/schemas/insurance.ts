import { z } from "zod";
import { BillingCycle, ContactSchema, IsoDate, count, field, leaf, money, text, textLeaves } from "./common";

export const PolicyType = z.enum(["auto", "renters", "home", "other"]);

/** One vehicle a policy covers. Year is a whole year a real car could have: NHTSA matching needs it exact. */
const VehicleHint = z.strictObject({
  make: field(text),
  model: field(text),
  year: field(z.number().int().min(1886).max(2100)),
});

export const InsuranceSchema = z.strictObject({
  insurer: field(leaf(text)),
  policyType: field(leaf(PolicyType)),
  /** Exactly 4 characters: a full policy number is never stored (INTENT principle 7). */
  policyNumberLast4: field(leaf(z.string().regex(/^[A-Za-z0-9]{4}$/))),
  effectiveDate: field(leaf(IsoDate)),
  expirationDate: field(leaf(IsoDate)),
  renewal: field(leaf(z.enum(["auto", "manual"]))),
  premium: field(z.strictObject({ amount: field(leaf(money)), cycle: field(leaf(BillingCycle)) })),
  deductibles: field(z.array(leaf(z.strictObject({ coverage: text, amount: money }))).max(50)),
  coverages: textLeaves,
  exclusions: textLeaves,
  claimSteps: textLeaves,
  claimReportWindowDays: field(leaf(count)),
  contact: field(ContactSchema),
  coveredAssetHints: field(z.array(leaf(VehicleHint)).max(20)),
});
