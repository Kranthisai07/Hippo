import { z } from "zod";
import type { AgreementKind } from "../deadlines";
import { InsuranceSchema } from "./insurance";
import { LeaseSchema } from "./lease";
import { ServicePlanSchema } from "./servicePlan";
import { SubscriptionSchema } from "./subscription";
import { WarrantySchema } from "./warranty";

export * from "./common";
export * from "./flatten";
export { WarrantySchema } from "./warranty";
export { InsuranceSchema, PolicyType } from "./insurance";
export { LeaseSchema, NoticeDaysType } from "./lease";
export { SubscriptionSchema } from "./subscription";
export { ServicePlanSchema } from "./servicePlan";

/** One strict schema per kind of agreement. The ingest worker validates model output against exactly one of these. */
export const ExtractionSchemas = {
  warranty: WarrantySchema,
  insurance: InsuranceSchema,
  lease: LeaseSchema,
  subscription: SubscriptionSchema,
  service_plan: ServicePlanSchema,
} satisfies Record<AgreementKind, z.ZodType>;

/** What classification may answer: a kind above, or `other` (stored and searchable, no agreement, no deadlines). */
export const DocType = z.enum(["warranty", "insurance", "lease", "subscription", "service_plan", "other"]);
export type DocType = z.infer<typeof DocType>;

export type Extraction<K extends AgreementKind> = z.infer<(typeof ExtractionSchemas)[K]>;
