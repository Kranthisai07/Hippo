import { UiResolveAlertInput } from "core/src/contracts";
import type { z } from "zod";
import { applyAlertAction } from "../alerts";
import type { ToolHandler } from "../context";

export const description =
  "Card button: marks an alert done, dismissed, not mine or snoozed. Called by the card, not by the model.";

export const uiResolveAlert: ToolHandler<z.infer<typeof UiResolveAlertInput>> = (ctx, args) =>
  applyAlertAction(ctx, args.alert_id, args.action);
