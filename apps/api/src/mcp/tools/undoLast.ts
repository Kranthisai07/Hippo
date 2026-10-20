import type { UndoOp } from "core/src/contracts";
import { UndoLastInput } from "core/src/contracts";
import type { z } from "zod";
import { recomputeService } from "../service";
import type { ToolContext, ToolHandler } from "../context";
import { ok } from "../result";

export const description =
  "Reverts the most recent thing the person added or logged by voice, if it was in the last 24 hours. " +
  "Use it only after add_record or log_service when they say it was a mistake. Do not use it to dismiss an alert (use resolve_alert). " +
  'Examples: "undo that", "never mind, remove it", "that was wrong".';

async function applyInverse(ctx: ToolContext, op: UndoOp): Promise<void> {
  const { householdId: hh, repo } = ctx;
  switch (op.type) {
    case "delete_asset":
      await repo.deleteAsset(hh, op.assetId);
      return;
    case "delete_agreement": {
      await repo.deleteAgreement(hh, op.agreementId);
      await repo.replaceObligations(hh, op.agreementId, []);
      // Alerts have no delete in the repository, so the ones raised for this agreement are dismissed.
      for (const alert of await repo.listAlerts(hh)) {
        if (alert.refId.startsWith(`${op.agreementId}:`) && alert.status !== "dismissed") {
          await repo.putAlert(hh, { ...alert, status: "dismissed" });
        }
      }
      return;
    }
    case "delete_event": {
      await repo.deleteEvent(hh, op.assetId, op.eventId);
      const kept = new Set((await recomputeService(ctx, op.assetId)).map((o) => o.id));
      // The service_due deadline raised by the logged service is gone, so its alert must not stay pending.
      const plans = (await repo.listAgreements(hh, { assetId: op.assetId })).filter((a) => a.kind === "service_plan");
      for (const alert of await repo.listAlerts(hh)) {
        const ours = plans.some((p) => alert.refId.startsWith(`${p.id}:`));
        if (ours && !kept.has(alert.refId) && (alert.status === "pending" || alert.status === "announced")) {
          await repo.putAlert(hh, { ...alert, status: "dismissed" });
        }
      }
      return;
    }
  }
}

export const undoLast: ToolHandler<z.infer<typeof UndoLastInput>> = async (ctx) => {
  const record = await ctx.repo.popUndo(ctx.householdId, Math.floor(ctx.nowMs / 1000));
  if (!record) return ok("There is nothing to undo.", { kind: "undone", undone: false, summary: null });
  await applyInverse(ctx, record.inverse);
  return ok(`Okay, I removed ${record.summary}.`, { kind: "undone", undone: true, summary: record.summary });
};
