import { z } from "zod";
import { AssetHintSchema, ContactSchema, IsoDate, count, field, leaf, text, textLeaves } from "./common";

export const WarrantySchema = z.strictObject({
  provider: field(leaf(text)),
  assetHint: field(AssetHintSchema),
  startDate: field(leaf(IsoDate)),
  termMonths: field(leaf(count)),
  endDate: field(leaf(IsoDate)),
  coverageSummary: textLeaves,
  exclusions: textLeaves,
  claimSteps: textLeaves,
  claimWindowDays: field(leaf(count)),
  contact: field(ContactSchema),
  requiresProofOfPurchase: field(leaf(z.boolean())),
});
