import type { Agreement, Asset } from "core/src/contracts";
import { AddRecordInput } from "core/src/contracts";
import { resolveAsset } from "core/src/resolver";
import { daysBetween, daysInMonth } from "obligation-kit";
import type { z } from "zod";
import { syncObligations } from "../../obligations";
import type { ToolContext, ToolHandler } from "../context";
import { speakDate } from "../format";
import { ok } from "../result";

export const description =
  "Adds something the person tells you about: a thing they own (asset) or a simple subscription with its cost and billing day. Dates they say count as confirmed. " +
  "Use it when they say they bought or signed up for something. Do not use it to log service on an item they already have (use log_service). " +
  'Examples: "I bought a Bosch dishwasher", "I signed up for a gym membership, 40 dollars monthly, on the 5th". ' +
  "For a subscription give vendor, amount, cycle and either next_charge_date (YYYY-MM-DD) or day_of_month.";

type Args = z.infer<typeof AddRecordInput>;

const UNDO_SECONDS = 24 * 3600;

/** The next date on or after `today` that falls on `day` of the month, clamped to short months. */
export function nextOnDay(day: number, today: string): string {
  const [y, m] = today.split("-").map(Number) as [number, number];
  for (let i = 0; i < 2; i++) {
    const total = y * 12 + (m - 1) + i;
    const yy = Math.floor(total / 12);
    const mm = total % 12;
    const d = Math.min(day, daysInMonth(yy, mm));
    const iso = `${String(yy).padStart(4, "0")}-${String(mm + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (daysBetween(today, iso) >= 0) return iso;
  }
  throw new Error("unreachable");
}

async function pushUndo(
  ctx: ToolContext,
  summary: string,
  inverse: Parameters<ToolContext["repo"]["pushUndo"]>[1]["inverse"],
) {
  await ctx.repo.pushUndo(ctx.householdId, {
    ts: new Date(ctx.nowMs).toISOString(),
    summary,
    inverse,
    expiresAt: Math.floor(ctx.nowMs / 1000) + UNDO_SECONDS,
  });
}

export const addRecord: ToolHandler<Args> = async (ctx, args) => {
  const { householdId: hh, repo, today } = ctx;
  const nowIso = new Date(ctx.nowMs).toISOString();

  if (args.kind === "asset") {
    const assets = await repo.listAssets(hh);
    const same = resolveAsset(args.name, assets);
    if (same.status === "match" && same.item.name.toLowerCase() === args.name.toLowerCase()) {
      return ok(`You already have ${same.item.name}, so I did not add it again.`, {
        kind: "record_added",
        created: false,
        recordKind: "asset",
        id: same.item.id,
        name: same.item.name,
        obligations: [],
        undoAvailable: false,
      });
    }
    const asset: Asset = {
      id: `asset-${ctx.newId()}`,
      name: args.name,
      aliases: [],
      category: args.category ?? "other",
      ...(args.brand ? { brand: args.brand } : {}),
      ...(args.model_number ? { modelNumber: args.model_number } : {}),
      ...(args.location ? { location: args.location } : {}),
      createdAt: nowIso,
    };
    await repo.putAsset(hh, asset);
    await pushUndo(ctx, `the ${args.name} you just added`, { type: "delete_asset", assetId: asset.id });
    return ok(`Added ${args.name} to your things. Upload its warranty in the app to track it.`, {
      kind: "record_added",
      created: true,
      recordKind: "asset",
      id: asset.id,
      name: asset.name,
      obligations: [],
      undoAvailable: true,
    });
  }

  const existing = (await repo.listAgreements(hh)).find(
    (a) => a.kind === "subscription" && (a.party ?? "").toLowerCase() === args.vendor.toLowerCase(),
  );
  if (existing) {
    return ok(`You already track ${existing.party}, so I did not add it again.`, {
      kind: "record_added",
      created: false,
      recordKind: "subscription",
      id: existing.id,
      name: existing.party ?? args.vendor,
      obligations: [],
      undoAvailable: false,
    });
  }

  const nextChargeDate = args.next_charge_date ?? (args.day_of_month ? nextOnDay(args.day_of_month, today) : null);
  const fields: Record<string, unknown> = {
    vendor: args.vendor,
    amount: args.amount,
    cycle: args.cycle,
    ...(nextChargeDate ? { nextChargeDate } : {}),
  };
  // The person said these out loud, so they count as confirmed (SPEC section 6, add_record).
  const fieldStatus = Object.fromEntries(Object.keys(fields).map((k) => [k, "confirmed" as const]));
  const agreement: Agreement = {
    id: `agr-${ctx.newId()}`,
    kind: "subscription",
    party: args.vendor,
    title: args.vendor,
    assetIds: [],
    fields,
    fieldStatus,
    sourceRefs: {},
    createdAt: nowIso,
  };
  await repo.putAgreement(hh, agreement);
  const records = await syncObligations(repo, hh, agreement, await repo.listAssets(hh), today);
  await pushUndo(ctx, `the ${args.vendor} subscription you just added`, {
    type: "delete_agreement",
    agreementId: agreement.id,
  });

  const charge = records.find((r) => r.type === "charge");
  const price = `$${args.amount} ${args.cycle}`;
  return ok(
    [
      `Added ${args.vendor}, ${price}.`,
      charge
        ? `The next charge is ${speakDate(charge.dueDate, today)}.`
        : "Tell me the charge date and I will track it.",
    ],
    {
      kind: "record_added",
      created: true,
      recordKind: "subscription",
      id: agreement.id,
      name: args.vendor,
      obligations: records.slice(0, 20).map((r) => ({ id: r.id, type: r.type, dueDate: r.dueDate, label: r.label })),
      undoAvailable: true,
    },
  );
};
