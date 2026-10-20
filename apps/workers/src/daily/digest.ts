import type { Household } from "core/src/contracts";
import { buildDigest } from "core/src/digest";
import type { DailyDeps, EmailOutcome } from "./types";

const DEFAULT_MAX_ITEMS = 10;

/**
 * Step 4. Builds the digest with core's buildDigest (which masks numbers and escapes text), sends it, and only then marks
 * exactly digest.alertIds as emailed. A failed send marks nothing, so the same alerts go out again on the next run.
 */
export async function runDigest(
  deps: Pick<DailyDeps, "repository" | "sender" | "now" | "appUrl" | "config">,
  householdId: string,
  household: Household,
  today: string,
): Promise<EmailOutcome> {
  if (!household.digestOn) return { status: "skipped", reason: "digest_off" };
  if (!household.email) return { status: "skipped", reason: "no_email" };

  const nowIso = new Date(deps.now()).toISOString();
  const open = await deps.repository.listAlerts(householdId, { open: true });
  // ISO timestamps compare as text. A snoozed alert stays out until its time is up.
  const alerts = open.filter((a) => !a.snoozedUntil || a.snoozedUntil <= nowIso);
  const digest = buildDigest({
    alerts,
    appUrl: deps.appUrl,
    today,
    digestOn: true,
    maxItems: deps.config?.digestMaxItems ?? DEFAULT_MAX_ITEMS,
  });
  if (!digest) return { status: "skipped", reason: "nothing_to_send" };

  if (!deps.sender) {
    return {
      status: "skipped",
      reason: "dry_run",
      preview: { subject: digest.subject, text: digest.text, alertIds: digest.alertIds },
    };
  }

  try {
    await deps.sender.send({ to: household.email, subject: digest.subject, text: digest.text, html: digest.html });
  } catch (e) {
    // The sender's own message may hold an address or a provider detail, so only the class name is kept.
    return {
      status: "failed",
      reason: `send failed (${e instanceof Error ? e.name : "unknown"})`,
      alertIds: digest.alertIds,
    };
  }
  try {
    for (const id of digest.alertIds) {
      const a = await deps.repository.getAlert(householdId, id);
      if (a) await deps.repository.putAlert(householdId, { ...a, emailedAt: nowIso });
    }
  } catch {
    // The mail is out, so this is not a failed send, but the same alerts will be mailed again: say so.
    return { status: "sent", alertIds: digest.alertIds, markFailed: true };
  }
  return { status: "sent", alertIds: digest.alertIds };
}
