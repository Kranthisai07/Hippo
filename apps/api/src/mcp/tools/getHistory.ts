import { GetHistoryInput } from "core/src/contracts";
import { addDays } from "obligation-kit";
import type { z } from "zod";
import type { ToolHandler } from "../context";
import { speakDate } from "../format";
import { findAsset } from "../resolve";
import { ok } from "../result";

export const description =
  "Reads back the last service or maintenance entries for one of the household's things and when its next service is due. " +
  "Use it for questions about past service. Do not use it to record a new service (use log_service) or to read a warranty (use get_agreement). " +
  'Examples: "when did I last service the furnace", "what is the history on my car". ' +
  "Pass only the thing as asset (for example furnace), not the whole sentence.";

const SHOWN = 5;

export const getHistory: ToolHandler<z.infer<typeof GetHistoryInput>> = async (ctx, args) => {
  const { householdId: hh, repo, today } = ctx;
  const found = await findAsset(ctx, args.asset);
  if ("reply" in found) return found.reply;
  const asset = found.found;

  const events = await repo.listEvents(hh, asset.id, SHOWN);
  const due = (await repo.listObligations(hh, { from: addDays(today, -365), to: addDays(today, 730) }))
    .filter((o) => o.type === "service_due" && o.assetId === asset.id)
    .sort((a, b) => b.dueDate.localeCompare(a.dueDate))[0];
  const next = due ? { date: due.dueDate, label: due.label } : null;

  const structured = {
    kind: "history",
    asset: { id: asset.id, name: asset.name },
    events: events.map((e) => ({ id: e.id, ts: e.ts, action: e.action, note: e.note ?? null, source: e.source })),
    nextServiceDue: next,
  };
  const name = asset.name.toLowerCase();
  const nextLine = next
    ? next.date < today
      ? `Service was due ${speakDate(next.date, today)}.`
      : `The next service is due ${speakDate(next.date, today)}.`
    : "";
  const last = events[0];
  if (!last) return ok([`I have no service history for your ${name}.`, nextLine], structured);
  return ok(
    [`Last service on your ${name}: ${last.action}, ${speakDate(last.ts.slice(0, 10), today)}.`, nextLine],
    structured,
  );
};
