import type { Alert, ToolResult } from "core/src/contracts";
import type { ToolContext } from "./context";
import { deadlinePhrase, lowerGeneric, lowerKindWord, typeFromRefId } from "./format";
import { daysBetween } from "obligation-kit";
import { speak } from "./speak";

// Proactive injection (SPEC section 6): when an unannounced high alert exists, one sentence is put in front of the
// answer and that alert is marked announced. Rules, all tested:
//  - at most one sentence per call, and at most one call per day (INTENT principle 8: never nag),
//  - never on an error, a question back to the person, resolve_alert or undo_last,
//  - confirmed deadlines and deterministic recalls only: an alert exists only for those,
//  - which alert goes first: document deadlines (renews, expires, notice_by) before recalls before the rest,
//    then the earliest date. A card is not the place for judgement, so the order is plain and written here.

const TIER = (a: Alert): number => {
  if (a.source === "recall") return 1;
  const type = typeFromRefId(a.refId);
  return type === "renews" || type === "expires" || type === "notice_by" ? 0 : 2;
};

const snoozed = (a: Alert, today: string): boolean => !!a.snoozedUntil && a.snoozedUntil.slice(0, 10) > today;

async function sentenceFor(ctx: ToolContext, alert: Alert): Promise<string> {
  const { householdId: hh, repo, today } = ctx;
  if (alert.source === "recall") {
    const asset = alert.assetId ? await repo.getAsset(hh, alert.assetId) : null;
    return `Before that, a recall may affect your ${asset ? lowerGeneric(asset.name) : "household items"}.`;
  }
  const due = alert.dueDate ?? today;
  // The obligation holds the spoken form of the label ("car insurance renews"); the alert holds the display form.
  const obligation = (await repo.listObligations(hh, { from: today, to: due })).find((o) => o.id === alert.refId);
  const label = obligation?.label ?? lowerKindWord(alert.label);
  const type = obligation?.type ?? typeFromRefId(alert.refId);
  return `Before that, ${deadlinePhrase(label, type, daysBetween(today, due))}.`;
}

export interface ProactiveOptions {
  /** Alert ids the answer already says out loud, so they are not repeated. */
  skip?: ReadonlySet<string>;
}

export async function injectProactive(
  ctx: ToolContext,
  result: ToolResult,
  opts: ProactiveOptions = {},
): Promise<ToolResult> {
  if (result.isError) return result;
  const sc = result.structuredContent;
  if (sc?.kind === "ambiguous" || sc?.kind === "not_found") return result;
  const { householdId: hh, repo, today } = ctx;

  const open = await repo.listAlerts(hh, { open: true });
  // One a day: if something was announced today, this call stays quiet.
  if (open.some((a) => a.announcedAt && a.announcedAt.slice(0, 10) === today)) return result;
  const candidates = open
    .filter((a) => a.status === "pending" && a.severity === "high" && !snoozed(a, today))
    .filter((a) => a.source === "recall" || (a.dueDate !== undefined && a.dueDate !== null && a.dueDate >= today))
    .filter((a) => !opts.skip?.has(a.id))
    .sort(
      (x, y) =>
        TIER(x) - TIER(y) || (x.dueDate ?? "9999").localeCompare(y.dueDate ?? "9999") || x.id.localeCompare(y.id),
    );
  const alert = candidates[0];
  if (!alert) return result;

  const sentence = speak(await sentenceFor(ctx, alert));
  await repo.putAlert(hh, { ...alert, status: "announced", announcedAt: new Date(ctx.nowMs).toISOString() });
  const first = result.content[0]!;
  return {
    ...result,
    content: [{ type: "text", text: `${sentence} ${first.text}` }, ...result.content.slice(1)],
    structuredContent: { ...(sc ?? {}), proactive: { alertId: alert.id, sentence } },
  };
}
