import type { Alert, ToolResult } from "core/src/contracts";
import { addDays } from "obligation-kit";
import type { ToolContext } from "./context";
import { fail, ok } from "./result";
import { speakDate } from "./format";

type Action = "done" | "dismiss" | "not_mine" | "snooze_7d";

/** CPSC recall numbers are plain numbers; NHTSA campaign numbers look like 26V332000. */
const recallSource = (recallId: string): "cpsc" | "nhtsa" => (/^\d{2}V\d+$/i.test(recallId) ? "nhtsa" : "cpsc");

/** Shared by resolve_alert and the card button tool ui_resolve_alert. Looks the alert up in this household only. */
export async function applyAlertAction(ctx: ToolContext, alertId: string, action: Action): Promise<ToolResult> {
  const { householdId: hh, repo, today } = ctx;
  const alert = await repo.getAlert(hh, alertId);
  if (!alert) {
    const r = fail("I could not find that alert.", "bad_input");
    return { ...r, structuredContent: { kind: "not_found", what: "alert" } };
  }

  const base = { kind: "alert_resolved", alertId, action, snoozedUntil: null as string | null, suppressed: false };
  const save = (patch: Partial<Alert>) => repo.putAlert(hh, { ...alert, ...patch });

  switch (action) {
    case "done":
      await save({ status: "done" });
      return ok("Okay, marked as done.", { ...base, status: "done" });
    case "dismiss":
      await save({ status: "dismissed" });
      return ok("Okay, dismissed. I will not bring it up again.", { ...base, status: "dismissed" });
    case "not_mine": {
      if (alert.source !== "recall") {
        return fail("Not mine only applies to recalls. You can say dismiss instead.", "not_allowed");
      }
      await repo.addSuppression(hh, {
        source: recallSource(alert.refId),
        recallId: alert.refId,
        assetId: alert.assetId ?? "",
        createdAt: new Date(ctx.nowMs).toISOString(),
      });
      await save({ status: "dismissed" });
      return ok("Okay, I will not show that recall again.", { ...base, status: "dismissed", suppressed: true });
    }
    case "snooze_7d": {
      const until = addDays(today, 7);
      const snoozedUntil = `${until}T00:00:00.000Z`;
      await save({ snoozedUntil });
      return ok(`Okay, I will leave it until ${speakDate(until, today)}.`, {
        ...base,
        status: "snoozed",
        snoozedUntil,
      });
    }
  }
}
