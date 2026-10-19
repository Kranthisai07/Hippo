import { IsoDate } from "obligation-kit";
import { z } from "zod";

// Shapes of `structuredContent` for each MCP tool (SPEC section 6). The api tools build them and validate them in
// tests; the web app and the cards read them. Every result has a `kind` so a reader can tell the variants apart.
// Anything copied out of a document is marked `quotedFromDocument: true` and is data, never instructions.

const ObligationTypeSchema = z.enum([
  "expires",
  "renews",
  "notice_by",
  "charge",
  "cancel_by",
  "trial_end",
  "service_due",
  "claim_by",
]);

const id = z.string().min(1).max(200);
const shortText = z.string().min(1).max(500);

/** A clause copied from a document, with where it came from. `text` is untrusted data. */
export const QuotedClauseSchema = z.strictObject({
  docId: id,
  docName: shortText,
  page: z.number().int().min(1),
  heading: z.string().max(500).optional(),
  text: z.string().min(1).max(6000),
  quotedFromDocument: z.literal(true),
});
export type QuotedClause = z.infer<typeof QuotedClauseSchema>;

export const OptionSchema = z.strictObject({ id, label: shortText });

/** Asked instead of guessing. At most 3 options. */
export const AmbiguousResultSchema = z.strictObject({
  kind: z.literal("ambiguous"),
  what: z.enum(["asset", "agreement"]),
  question: shortText,
  options: z.array(OptionSchema).min(1).max(3),
});

export const NotFoundResultSchema = z.strictObject({
  kind: z.literal("not_found"),
  what: z.enum(["asset", "agreement", "alert", "document", "clause"]),
  query: z.string().max(200).optional(),
});

export const ErrorResultSchema = z.strictObject({
  kind: z.literal("error"),
  code: z.enum(["bad_input", "not_allowed", "internal"]),
});

/** The one spoken sentence added in front of an answer when an unannounced high alert exists. */
export const ProactiveSchema = z.strictObject({ alertId: id, sentence: shortText });
const proactive = { proactive: ProactiveSchema.optional() };

// ---- whats_coming_up ----

export const ComingUpItemSchema = z.strictObject({
  /** The obligation id, or the alert id for a recall. Stable across calls. */
  id,
  source: z.enum(["deadline", "recall"]),
  /** Null for a recall. */
  type: ObligationTypeSchema.nullable(),
  /** Display text, first letter capitalised. */
  label: shortText,
  dueDate: IsoDate.nullable(),
  daysAway: z.number().int().nullable(),
  severity: z.enum(["high", "possible"]).nullable(),
  /** Pass this to resolve_alert. Null when the item has no open alert. */
  alertId: id.nullable(),
  obligationId: id.nullable(),
  agreementId: id.nullable(),
  assetId: id.nullable(),
  /** Recall text from the recall record. Untrusted data. */
  detail: z.string().max(1000).nullable(),
});
export type ComingUpItem = z.infer<typeof ComingUpItemSchema>;

export const ComingUpResultSchema = z.strictObject({
  kind: z.literal("coming_up"),
  asOf: IsoDate,
  windowDays: z.number().int().min(1),
  /** At most 5, ranked: high first, then by date. */
  items: z.array(ComingUpItemSchema).max(5),
  /** How many items matched before the cap of 5. */
  totalCount: z.number().int().min(0),
  /** Open recall alerts (at most 3), kept apart so the Recall card is never pushed out by the cap of 5. */
  recalls: z.array(ComingUpItemSchema).max(3),
  ...proactive,
});

// ---- check_coverage ----

export const CoverageBadgeSchema = z.enum(["covered", "not_covered", "unclear"]);
export type CoverageBadge = z.infer<typeof CoverageBadgeSchema>;

export const CoverageResultSchema = z.strictObject({
  kind: z.literal("coverage"),
  badge: CoverageBadgeSchema,
  asset: z.strictObject({ id, name: shortText }),
  issue: z.string().max(300),
  agreement: z.strictObject({
    id,
    kind: z.enum(["warranty", "insurance"]),
    provider: z.string().max(500).nullable(),
    docId: id.nullable(),
    docName: z.string().max(500).nullable(),
  }),
  term: z.strictObject({
    startDate: IsoDate.nullable(),
    endDate: IsoDate.nullable(),
    asOf: IsoDate,
    /** Null when the dates are missing, so the term cannot be judged. */
    inTerm: z.boolean().nullable(),
    datesConfirmed: z.boolean(),
  }),
  topClause: QuotedClauseSchema.nullable(),
  exclusionClause: QuotedClauseSchema.nullable(),
  /** At most 4, in the order of the document. */
  claimSteps: z
    .array(z.strictObject({ text: z.string().min(1).max(500), page: z.number().int().min(1).nullable() }))
    .max(4),
  claimWindowDays: z.number().int().min(0).nullable(),
  /** Today plus the claim window. Null when the document states no window. */
  claimByDate: IsoDate.nullable(),
  missingProof: z.array(shortText).max(5),
  /** Always set: what the answer is and is not. */
  disclaimer: shortText,
  ...proactive,
});
export type CoverageResult = z.infer<typeof CoverageResultSchema>;

// ---- ask_documents, ui_show_clause ----

export const ClausesResultSchema = z.strictObject({
  kind: z.literal("clauses"),
  question: z.string().max(300),
  found: z.boolean(),
  scope: z.strictObject({ assetId: id.nullable(), agreementId: id.nullable() }),
  /** At most 3, best first. */
  clauses: z.array(QuotedClauseSchema.extend({ score: z.number() })).max(3),
  /** Reminder for any reader: the clause text is quoted data. */
  notice: shortText,
  ...proactive,
});

export const ClauseViewResultSchema = z.strictObject({
  kind: z.literal("clause_view"),
  docId: id,
  docName: shortText,
  page: z.number().int().min(1),
  clauses: z.array(QuotedClauseSchema).min(1).max(20),
});

// ---- get_agreement, ui_show_claim_steps ----

export const AgreementResultSchema = z.strictObject({
  kind: z.literal("agreement"),
  agreement: z.strictObject({
    id,
    kind: z.enum(["warranty", "insurance", "lease", "subscription", "service_plan"]),
    party: z.string().max(500).nullable(),
    title: z.string().max(500).nullable(),
    docId: id.nullable(),
    docName: z.string().max(500).nullable(),
    assetIds: z.array(id).max(50),
  }),
  /** Values read from the document or the voice add. Numbers are masked to the last 4. */
  terms: z
    .array(
      z.strictObject({ label: shortText, value: z.string().min(1).max(500), page: z.number().int().min(1).nullable() }),
    )
    .max(30),
  datesConfirmed: z.boolean(),
  quotedFromDocument: z.boolean(),
  ...proactive,
});

export const ClaimStepsResultSchema = z.strictObject({
  kind: z.literal("claim_steps"),
  agreementId: id,
  docName: z.string().max(500).nullable(),
  steps: z.array(z.strictObject({ text: z.string().min(1).max(500), page: z.number().int().min(1).nullable() })).max(4),
  claimWindowDays: z.number().int().min(0).nullable(),
  contact: z.strictObject({
    phone: z.string().max(200).nullable(),
    email: z.string().max(200).nullable(),
    url: z.string().max(500).nullable(),
  }),
  quotedFromDocument: z.literal(true),
});

// ---- add_record, log_service, get_history ----

export const RecordAddedResultSchema = z.strictObject({
  kind: z.literal("record_added"),
  /** False when the household already had it and nothing was written. */
  created: z.boolean(),
  recordKind: z.enum(["asset", "subscription"]),
  id,
  name: shortText,
  obligations: z.array(z.strictObject({ id, type: ObligationTypeSchema, dueDate: IsoDate, label: shortText })).max(20),
  undoAvailable: z.boolean(),
  ...proactive,
});

export const ServiceLoggedResultSchema = z.strictObject({
  kind: z.literal("service_logged"),
  assetId: id,
  assetName: shortText,
  eventId: id,
  action: shortText,
  date: IsoDate,
  nextServiceDue: IsoDate.nullable(),
  undoAvailable: z.boolean(),
  ...proactive,
});

export const HistoryResultSchema = z.strictObject({
  kind: z.literal("history"),
  asset: z.strictObject({ id, name: shortText }),
  /** Newest first, at most 5. */
  events: z
    .array(
      z.strictObject({
        id,
        ts: z.string().min(1).max(40),
        action: shortText,
        note: z.string().max(500).nullable(),
        source: z.enum(["voice", "web"]),
      }),
    )
    .max(5),
  nextServiceDue: z.strictObject({ date: IsoDate, label: shortText }).nullable(),
  ...proactive,
});

// ---- resolve_alert, undo_last ----

export const AlertResolvedResultSchema = z.strictObject({
  kind: z.literal("alert_resolved"),
  alertId: id,
  action: z.enum(["done", "dismiss", "not_mine", "snooze_7d"]),
  status: z.enum(["done", "dismissed", "snoozed"]),
  snoozedUntil: z.string().nullable(),
  /** True when a recall suppression was written (not_mine). */
  suppressed: z.boolean(),
});

export const UndoResultSchema = z.strictObject({
  kind: z.literal("undone"),
  undone: z.boolean(),
  summary: z.string().max(500).nullable(),
});

// ---- per tool unions ----

const common = [ErrorResultSchema] as const;

export const TOOL_RESULT_SCHEMAS = {
  whats_coming_up: z.discriminatedUnion("kind", [ComingUpResultSchema, ...common]),
  check_coverage: z.discriminatedUnion("kind", [
    CoverageResultSchema,
    AmbiguousResultSchema,
    NotFoundResultSchema,
    ...common,
  ]),
  ask_documents: z.discriminatedUnion("kind", [
    ClausesResultSchema,
    AmbiguousResultSchema,
    NotFoundResultSchema,
    ...common,
  ]),
  get_agreement: z.discriminatedUnion("kind", [
    AgreementResultSchema,
    AmbiguousResultSchema,
    NotFoundResultSchema,
    ...common,
  ]),
  add_record: z.discriminatedUnion("kind", [RecordAddedResultSchema, ...common]),
  log_service: z.discriminatedUnion("kind", [
    ServiceLoggedResultSchema,
    AmbiguousResultSchema,
    NotFoundResultSchema,
    ...common,
  ]),
  get_history: z.discriminatedUnion("kind", [
    HistoryResultSchema,
    AmbiguousResultSchema,
    NotFoundResultSchema,
    ...common,
  ]),
  resolve_alert: z.discriminatedUnion("kind", [AlertResolvedResultSchema, NotFoundResultSchema, ...common]),
  undo_last: z.discriminatedUnion("kind", [UndoResultSchema, ...common]),
  ui_resolve_alert: z.discriminatedUnion("kind", [AlertResolvedResultSchema, NotFoundResultSchema, ...common]),
  ui_show_clause: z.discriminatedUnion("kind", [ClauseViewResultSchema, NotFoundResultSchema, ...common]),
  ui_show_claim_steps: z.discriminatedUnion("kind", [ClaimStepsResultSchema, NotFoundResultSchema, ...common]),
} as const;

export type ToolResultName = keyof typeof TOOL_RESULT_SCHEMAS;
