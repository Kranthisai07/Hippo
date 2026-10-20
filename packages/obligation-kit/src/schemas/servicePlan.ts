import { z } from "zod";
import { AssetHintSchema, IsoDate, count, field, leaf, text, textLeaves } from "./common";

export const ServicePlanSchema = z.strictObject({
  provider: field(leaf(text)),
  assetHint: field(AssetHintSchema),
  intervalDays: field(leaf(count)),
  nextServiceDate: field(leaf(IsoDate)),
  included: textLeaves,
});
