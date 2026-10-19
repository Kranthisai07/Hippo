import { APP_TOOLS, MODEL_TOOLS, type ToolResult } from "core/src/contracts";
import type { ZodType } from "zod";
import type { ToolContext, ToolHandler } from "./context";
import { addRecord, description as addRecordDescription } from "./tools/addRecord";
import { askDocuments, description as askDocumentsDescription } from "./tools/askDocuments";
import { checkCoverage, description as checkCoverageDescription } from "./tools/checkCoverage";
import { getAgreement, description as getAgreementDescription } from "./tools/getAgreement";
import { getHistory, description as getHistoryDescription } from "./tools/getHistory";
import { logService, description as logServiceDescription } from "./tools/logService";
import { resolveAlert, description as resolveAlertDescription } from "./tools/resolveAlert";
import { uiResolveAlert, description as uiResolveAlertDescription } from "./tools/uiResolveAlert";
import { uiShowClaimSteps, description as uiShowClaimStepsDescription } from "./tools/uiShowClaimSteps";
import { uiShowClause, description as uiShowClauseDescription } from "./tools/uiShowClause";
import { undoLast, description as undoLastDescription } from "./tools/undoLast";
import { whatsComingUp, description as whatsComingUpDescription } from "./tools/whatsComingUp";

export interface ToolDef {
  name: string;
  description: string;
  schema: ZodType;
  // Arguments are parsed by the schema before the handler runs.
  handler: ToolHandler<never>;
  /** Model facing tools may carry the one proactive sentence. resolve_alert and undo_last never do. */
  proactive: boolean;
  /** Visible to the card only (`_meta.ui.visibility: ["app"]`). */
  app: boolean;
  readOnly: boolean;
}

const def = <A>(
  name: string,
  description: string,
  schema: ZodType<A>,
  handler: (ctx: ToolContext, args: A) => Promise<ToolResult>,
  o: { proactive: boolean; app?: boolean; readOnly: boolean },
): ToolDef => ({
  name,
  description,
  schema,
  handler: handler as ToolHandler<never>,
  proactive: o.proactive,
  app: o.app ?? false,
  readOnly: o.readOnly,
});

export const TOOLS: ToolDef[] = [
  def("whats_coming_up", whatsComingUpDescription, MODEL_TOOLS.whats_coming_up, whatsComingUp, {
    proactive: true,
    readOnly: true,
  }),
  def("check_coverage", checkCoverageDescription, MODEL_TOOLS.check_coverage, checkCoverage, {
    proactive: true,
    readOnly: true,
  }),
  def("ask_documents", askDocumentsDescription, MODEL_TOOLS.ask_documents, askDocuments, {
    proactive: true,
    readOnly: true,
  }),
  def("get_agreement", getAgreementDescription, MODEL_TOOLS.get_agreement, getAgreement, {
    proactive: true,
    readOnly: true,
  }),
  def("add_record", addRecordDescription, MODEL_TOOLS.add_record, addRecord, { proactive: true, readOnly: false }),
  def("log_service", logServiceDescription, MODEL_TOOLS.log_service, logService, { proactive: true, readOnly: false }),
  def("get_history", getHistoryDescription, MODEL_TOOLS.get_history, getHistory, { proactive: true, readOnly: true }),
  def("resolve_alert", resolveAlertDescription, MODEL_TOOLS.resolve_alert, resolveAlert, {
    proactive: false,
    readOnly: false,
  }),
  def("undo_last", undoLastDescription, MODEL_TOOLS.undo_last, undoLast, { proactive: false, readOnly: false }),
  def("ui_resolve_alert", uiResolveAlertDescription, APP_TOOLS.ui_resolve_alert, uiResolveAlert, {
    proactive: false,
    app: true,
    readOnly: false,
  }),
  def("ui_show_clause", uiShowClauseDescription, APP_TOOLS.ui_show_clause, uiShowClause, {
    proactive: false,
    app: true,
    readOnly: true,
  }),
  def("ui_show_claim_steps", uiShowClaimStepsDescription, APP_TOOLS.ui_show_claim_steps, uiShowClaimSteps, {
    proactive: false,
    app: true,
    readOnly: true,
  }),
];
