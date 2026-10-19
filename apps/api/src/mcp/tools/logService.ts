import { LogServiceInput } from "core/src/contracts";
import type { z } from "zod";
import type { ToolHandler } from "../context";
import { speakDate } from "../format";
import { findAsset } from "../resolve";
import { fail, ok } from "../result";
import { recomputeService } from "../service";

export const description =
  "Logs that a service or maintenance job was done on one of the household's things, and updates its next service date. " +
  "Use it when the person says they just did or had something serviced. Do not use it to add a new item (use add_record) or to read past entries (use get_history). " +
  'Examples: "I just had the furnace serviced", "I changed the water filter on the fridge yesterday". ' +
  "Pass only the thing as asset (for example furnace), what was done as action, and date as YYYY-MM-DD only if they said one.";

const UNDO_SECONDS = 24 * 3600;

export const logService: ToolHandler<z.infer<typeof LogServiceInput>> = async (ctx, args) => {
  const { householdId: hh, repo, today } = ctx;
  const found = await findAsset(ctx, args.asset);
  if ("reply" in found) return found.reply;
  const asset = found.found;

  const date = args.date ?? today;
  if (date > today) return fail("I cannot log a service that has not happened yet. Tell me the date it was done.");

  const nowIso = new Date(ctx.nowMs).toISOString();
  const event = {
    id: `event-${ctx.newId()}`,
    assetId: asset.id,
    ts: args.date ? `${args.date}T12:00:00.000Z` : nowIso,
    action: args.action,
    source: "voice" as const,
  };
  await repo.addEvent(hh, event);
  await repo.pushUndo(hh, {
    ts: nowIso,
    summary: `the ${asset.name.toLowerCase()} service you just logged`,
    inverse: { type: "delete_event", assetId: asset.id, eventId: event.id },
    expiresAt: Math.floor(ctx.nowMs / 1000) + UNDO_SECONDS,
  });

  const due = (await recomputeService(ctx, asset.id)).find((o) => o.type === "service_due")?.dueDate ?? null;
  return ok(
    [
      `Logged: ${args.action} on your ${asset.name.toLowerCase()}, ${speakDate(date, today)}.`,
      due ? `The next service is due ${speakDate(due, today)}.` : "You can say undo if that was a mistake.",
    ],
    {
      kind: "service_logged",
      assetId: asset.id,
      assetName: asset.name,
      eventId: event.id,
      action: args.action,
      date,
      nextServiceDue: due,
      undoAvailable: true,
    },
  );
};
