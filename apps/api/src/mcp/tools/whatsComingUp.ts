import type { ComingUpItem } from "core/src/contracts";
import { WhatsComingUpInput } from "core/src/contracts";
import { addDays } from "obligation-kit";
import type { z } from "zod";
import type { ToolHandler } from "../context";
import { capitalize, daysUntil, deadlinePhrase, lowerKindWord } from "../format";
import { ok } from "../result";

export const description =
  "Lists what is coming up for the household: confirmed deadlines such as renewals, notice dates, cancel-by dates and warranty ends, plus open alerts, most urgent first. " +
  "Use it for questions about dates and what needs attention. Do not use it to check coverage for a broken item (use check_coverage) or to read a document (use ask_documents). " +
  'Examples: "what is coming up this month", "anything due soon", "what do I need to cancel". ' +
  "window_days is how far ahead to look, 30 by default.";

type Args = z.infer<typeof WhatsComingUpInput>;

const SPOKEN_ITEMS = 3;
const CARD_ITEMS = 5;
const rank = { high: 0, possible: 1 } as const;

export const whatsComingUp: ToolHandler<Args> = async (ctx, args) => {
  const { householdId: hh, repo, today } = ctx;
  const windowDays = args.window_days ?? 30;
  const to = addDays(today, windowDays);
  const [obligations, alerts] = await Promise.all([repo.listObligations(hh, { from: today, to }), repo.listAlerts(hh)]);

  // Done and dismissed mean handled for good (INTENT principle 8). A snoozed alert is hidden until its date.
  const snoozed = (a: { snoozedUntil?: string | null }) => !!a.snoozedUntil && a.snoozedUntil.slice(0, 10) > today;
  const handled = new Set(
    alerts.filter((a) => a.status === "done" || a.status === "dismissed" || snoozed(a)).map((a) => a.refId),
  );
  const open = new Map(
    alerts.filter((a) => (a.status === "pending" || a.status === "announced") && !snoozed(a)).map((a) => [a.refId, a]),
  );

  const items: ComingUpItem[] = [];
  const spokenOf = new Map<string, string>();
  const seen = new Set<string>();
  for (const o of obligations) {
    if (!o.confirmed || handled.has(o.id)) continue;
    const alert = open.get(o.id);
    seen.add(o.id);
    spokenOf.set(o.id, o.label);
    items.push({
      id: o.id,
      source: "deadline",
      type: o.type,
      label: capitalize(o.label),
      dueDate: o.dueDate,
      daysAway: daysUntil(today, o.dueDate),
      severity: alert?.severity ?? o.severity,
      alertId: alert?.id ?? null,
      obligationId: o.id,
      agreementId: o.agreementId ?? null,
      assetId: o.assetId ?? null,
      detail: null,
    });
  }
  for (const a of open.values()) {
    if (seen.has(a.refId)) continue;
    // A deadline alert whose obligation is outside the window is not coming up yet.
    if (a.source === "deadline" && (!a.dueDate || a.dueDate < today || a.dueDate > to)) continue;
    spokenOf.set(a.id, lowerKindWord(a.label));
    items.push({
      id: a.id,
      source: a.source,
      type: null,
      label: capitalize(a.label),
      dueDate: a.dueDate ?? null,
      daysAway: a.dueDate ? daysUntil(today, a.dueDate) : null,
      severity: a.severity,
      alertId: a.id,
      obligationId: a.source === "deadline" ? a.refId : null,
      agreementId: null,
      assetId: a.assetId ?? null,
      detail: a.detail ?? null,
    });
  }

  items.sort(
    (x, y) =>
      (x.severity ? rank[x.severity] : 2) - (y.severity ? rank[y.severity] : 2) ||
      (x.dueDate ?? "9999").localeCompare(y.dueDate ?? "9999") ||
      x.id.localeCompare(y.id),
  );

  const structured = {
    kind: "coming_up",
    asOf: today,
    windowDays,
    items: items.slice(0, CARD_ITEMS),
    totalCount: items.length,
    recalls: items.filter((i) => i.source === "recall").slice(0, 3),
  };
  if (items.length === 0) return ok(`Nothing is due in the next ${windowDays} days.`, structured);

  // One spoken line per agreement: a trial end and its cancel-by date are the same story.
  const groups = new Map<string, ComingUpItem>();
  for (const i of items) {
    const key = i.agreementId ?? i.id;
    if (!groups.has(key)) groups.set(key, i);
  }
  const spoken = [...groups.values()];
  const phrases = spoken
    .slice(0, SPOKEN_ITEMS)
    .map((i) =>
      i.source === "recall"
        ? `a recall notice, ${i.label}`
        : deadlinePhrase(spokenOf.get(i.id) ?? i.label, i.type, i.daysAway ?? 0),
    );
  const list =
    phrases.length > 1 ? `${phrases.slice(0, -1).join(", ")}, and ${phrases[phrases.length - 1]}` : (phrases[0] ?? "");
  const more = spoken.length - phrases.length;
  return ok([`Coming up: ${list}.`, more > 0 ? `${more} more are in the app.` : ""], structured);
};
