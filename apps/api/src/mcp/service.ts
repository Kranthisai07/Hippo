import type { ObligationRecord } from "core/src/contracts";
import type { ToolContext } from "./context";
import { syncObligations } from "../obligations";

/** Events are read back newest first, so the first one is the last service. */
const EVENTS_READ = 50;

/**
 * Recomputes the next service date of every service plan on this asset from the last logged event
 * (service_due = last event + interval, SPEC section 5). A voice logged date counts as confirmed.
 */
export async function recomputeService(ctx: ToolContext, assetId: string): Promise<ObligationRecord[]> {
  const { householdId: hh, repo, today } = ctx;
  const plans = (await repo.listAgreements(hh, { assetId })).filter((a) => a.kind === "service_plan");
  if (plans.length === 0) return [];
  const [events, assets] = await Promise.all([repo.listEvents(hh, assetId, EVENTS_READ), repo.listAssets(hh)]);
  const out: ObligationRecord[] = [];
  for (const plan of plans) {
    if (events.length === 0) {
      await repo.replaceObligations(hh, plan.id, []);
      continue;
    }
    const lastServiceDate = events[0]!.ts.slice(0, 10);
    const overlay = {
      ...plan,
      fields: { ...plan.fields, lastServiceDate },
      fieldStatus: { ...plan.fieldStatus, lastServiceDate: "confirmed" as const },
    };
    out.push(...(await syncObligations(repo, hh, overlay, assets, today)));
  }
  return out;
}
