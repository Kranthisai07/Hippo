import { BillingCycle, IsoDate, count, field, leaf, money, text } from "./common";
import { z } from "zod";

export const SubscriptionSchema = z.strictObject({
  vendor: field(leaf(text)),
  plan: field(leaf(text)),
  amount: field(leaf(money)),
  cycle: field(leaf(BillingCycle)),
  nextChargeDate: field(leaf(IsoDate)),
  trialEndDate: field(leaf(IsoDate)),
  cancelNoticeDays: field(leaf(count)),
  cancelMethod: field(leaf(text)),
  /** Already masked in the document ("j***@example.com"); never a full address. */
  accountEmailHint: field(leaf(text)),
});
