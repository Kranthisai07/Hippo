import { BillingCycle, IsoDate } from "obligation-kit";
import { z } from "zod";
import { ASSET_CATEGORIES } from "./entities";

// Input schemas for the MCP tools (SPEC section 6). All strict: an unknown key, including householdId, is rejected.
// Household scope comes from the auth token only, so no schema has a place to put one.

/** The thing a person names out loud ("dishwasher"), not a whole sentence: the resolver returns nothing for sentences. */
const thing = z.string().trim().min(1).max(80);
const id = z.string().trim().min(1).max(64);

export const RESOLVE_ACTIONS = ["done", "dismiss", "not_mine", "snooze_7d"] as const;
export const ResolveAction = z.enum(RESOLVE_ACTIONS);

export const WhatsComingUpInput = z.strictObject({ window_days: z.number().int().min(1).max(365).default(30) });
export const CheckCoverageInput = z.strictObject({ asset: thing, issue: z.string().trim().min(1).max(200) });
export const AskDocumentsInput = z.strictObject({
  question: z.string().trim().min(1).max(300),
  about: thing.optional(),
});
export const GetAgreementInput = z.strictObject({ about: thing });

export const AddRecordInput = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("asset"),
    name: thing,
    brand: thing.optional(),
    model_number: z.string().trim().min(1).max(40).optional(),
    category: z.enum(ASSET_CATEGORIES).optional(),
    location: thing.optional(),
  }),
  z.strictObject({
    kind: z.literal("subscription"),
    vendor: thing,
    amount: z.number().finite().min(0).max(1_000_000),
    cycle: BillingCycle,
    next_charge_date: IsoDate.optional(),
    day_of_month: z.number().int().min(1).max(31).optional(),
  }),
]);

export const LogServiceInput = z.strictObject({
  asset: thing,
  action: z.string().trim().min(1).max(120),
  date: IsoDate.optional(),
});
export const GetHistoryInput = z.strictObject({ asset: thing });
export const ResolveAlertInput = z.strictObject({ alert_id: id, action: ResolveAction });
export const UndoLastInput = z.strictObject({});

/** Only the card buttons call these (`_meta.ui.visibility: ["app"]`). */
export const UiResolveAlertInput = ResolveAlertInput;
export const UiShowClauseInput = z.strictObject({ doc_id: id, page: z.number().int().min(1) });
export const UiShowClaimStepsInput = z.strictObject({ agreement_id: id });

export const MODEL_TOOLS = {
  whats_coming_up: WhatsComingUpInput,
  check_coverage: CheckCoverageInput,
  ask_documents: AskDocumentsInput,
  get_agreement: GetAgreementInput,
  add_record: AddRecordInput,
  log_service: LogServiceInput,
  get_history: GetHistoryInput,
  resolve_alert: ResolveAlertInput,
  undo_last: UndoLastInput,
} as const;

export const APP_TOOLS = {
  ui_resolve_alert: UiResolveAlertInput,
  ui_show_clause: UiShowClauseInput,
  ui_show_claim_steps: UiShowClaimStepsInput,
} as const;

export type ModelToolName = keyof typeof MODEL_TOOLS;
export type AppToolName = keyof typeof APP_TOOLS;
export const MODEL_TOOL_NAMES = Object.keys(MODEL_TOOLS) as ModelToolName[];
export const APP_TOOL_NAMES = Object.keys(APP_TOOLS) as AppToolName[];

/**
 * What every model-facing tool returns (SPEC section 6 response contract). `content` is one or two speakable
 * sentences with no markdown or URLs. `structuredContent` carries ids and fields so follow ups can work.
 */
export const ToolResultSchema = z.strictObject({
  content: z.array(z.strictObject({ type: z.literal("text"), text: z.string().min(1) })).min(1),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean().optional(),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;
