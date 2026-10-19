import { ResolveAlertInput } from "core/src/contracts";
import type { z } from "zod";
import { applyAlertAction } from "../alerts";
import type { ToolHandler } from "../context";

export const description =
  "Marks one alert as done, dismissed, not mine (recalls only) or snoozed for 7 days. " +
  "Use it when the person responds to something you just told them, with the alert_id from the earlier answer. Do not use it to undo an add or a log entry (use undo_last). " +
  'Examples: "dismiss that", "that recall is not mine", "remind me next week". ' +
  "action is one of done, dismiss, not_mine, snooze_7d.";

export const resolveAlert: ToolHandler<z.infer<typeof ResolveAlertInput>> = (ctx, args) =>
  applyAlertAction(ctx, args.alert_id, args.action);
