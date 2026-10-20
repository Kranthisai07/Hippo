import { describe, expect, it } from "vitest";
import { applyAlertAction } from "../src/mcp/alerts";
import { whatsComingUp } from "../src/mcp/tools/whatsComingUp";
import { A, B, check, makeContext, seeded, text } from "./helpers";

const run = async (today = "2026-10-21", window = 30) => {
  const env = await seeded(today);
  return { env, r: check("whats_coming_up", await whatsComingUp(env.ctx, { window_days: window })) };
};
const items = (r: { structuredContent?: Record<string, unknown> }) => (r.structuredContent as any).items as any[];

describe("whats_coming_up", () => {
  it("returns the Kestrel cancel-by, the car insurance renewal and the lease notice date at the anchor date", async () => {
    const { r } = await run();
    const byType = (type: string, label: RegExp) => items(r).find((i) => i.type === type && label.test(i.label));
    expect(byType("cancel_by", /Kestrel/)).toMatchObject({ dueDate: "2026-10-26", daysAway: 5, severity: "high" });
    expect(byType("renews", /Car insurance/)).toMatchObject({ dueDate: "2026-10-30", daysAway: 9, severity: "high" });
    expect(byType("notice_by", /Lease/)).toMatchObject({ dueDate: "2026-11-01", daysAway: 11, severity: "high" });
  });

  it("ranks high first and then by date, with at most 5 items for the card", async () => {
    const { r } = await run();
    const list = items(r);
    expect(list.length).toBeLessThanOrEqual(5);
    expect((r.structuredContent as any).totalCount).toBeGreaterThan(5);
    const rank = (s: string | null) => (s === "high" ? 0 : s === "possible" ? 1 : 2);
    const ranks = list.map((i) => rank(i.severity));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    const highs = list.filter((i) => i.severity === "high" && i.dueDate);
    expect(highs.map((i) => i.dueDate)).toEqual([...highs.map((i) => i.dueDate)].sort());
  });

  it("speaks at most the top 3, one line per agreement", async () => {
    const { r } = await run();
    const t = text(r);
    expect(t).toContain("Kestrel Learning cancel-by date is in 5 days");
    expect(t).toContain("car insurance renews in 9 days");
    expect(t).toContain("lease notice deadline is in 11 days");
    expect(t).not.toContain("trial ends");
    expect(t).toContain("more are in the app");
  });

  it("keeps recalls apart from the cap so the Recall card always has them", async () => {
    const { r } = await run();
    const recalls = (r.structuredContent as any).recalls as any[];
    expect(recalls.map((x) => x.alertId).sort()).toEqual(["alert-recall-26530", "alert-recall-26V332000"]);
    expect(recalls[0].detail).toMatch(/Hazard:/);
    expect(recalls.every((x) => x.source === "recall" && x.type === null)).toBe(true);
  });

  it("gives every item what a follow up needs", async () => {
    const { r } = await run();
    for (const i of items(r)) {
      expect(i.id).toBeTruthy();
      if (i.source === "deadline") expect(i.alertId === null || i.alertId.startsWith("alert-")).toBe(true);
    }
    const insurance = items(r).find((i) => i.type === "renews");
    expect(insurance.alertId).toBe("alert-agr-insurance_auto:renews:2026-10-30");
    expect(insurance.agreementId).toBe("agr-insurance_auto");
    expect(insurance.assetId).toBe("A-car");
  });

  it("respects the window", async () => {
    const { r } = await run("2026-10-21", 3);
    expect(items(r).filter((i) => i.source === "deadline")).toEqual([]);
    const wide = (await run("2026-10-21", 90)).r;
    expect(items(wide).concat((wide.structuredContent as any).recalls).length).toBeGreaterThan(0);
    expect((wide.structuredContent as any).totalCount).toBeGreaterThan(
      (await run()).r.structuredContent!.totalCount as number,
    );
  });

  it("says nothing is due when nothing is", async () => {
    const env = await seeded();
    const quiet = makeContext(env, { householdId: "hh_empty" });
    const r = check("whats_coming_up", await whatsComingUp(quiet, { window_days: 30 }));
    expect(text(r)).toBe("Nothing is due in the next 30 days.");
    expect(items(r)).toEqual([]);
  });

  it("drops a passed notice window instead of listing it", async () => {
    const { r } = await run("2026-11-15");
    expect(items(r).some((i) => i.type === "notice_by")).toBe(false);
    expect(text(r)).not.toContain("lease notice");
  });

  it("never lists an unconfirmed obligation", async () => {
    const env = await seeded();
    const a = (await env.repo.getAgreement(A, "agr-lease"))!;
    const { syncObligations } = await import("../src/obligations");
    await syncObligations(
      env.repo,
      A,
      { ...a, fieldStatus: { ...a.fieldStatus, endDate: "extracted" } },
      await env.repo.listAssets(A),
      "2026-10-21",
    );
    const r = check("whats_coming_up", await whatsComingUp(env.ctx, { window_days: 30 }));
    expect(items(r).some((i) => i.type === "notice_by" && i.alertId === null)).toBe(false);
    expect(items(r).filter((i) => i.type === "notice_by")).toEqual([]);
  });

  it("hides what was marked done, dismissed or snoozed, and shows it again after the snooze", async () => {
    const env = await seeded();
    const id = "alert-agr-insurance_auto:renews:2026-10-30";
    await applyAlertAction(env.ctx, id, "done");
    let r = check("whats_coming_up", await whatsComingUp(env.ctx, { window_days: 30 }));
    expect(text(r)).not.toContain("car insurance");

    const env2 = await seeded();
    await applyAlertAction(env2.ctx, "alert-agr-lease:notice_by:2026-11-01", "dismiss");
    r = check("whats_coming_up", await whatsComingUp(env2.ctx, { window_days: 30 }));
    expect(items(r).some((i) => i.type === "notice_by")).toBe(false);

    const env3 = await seeded();
    await applyAlertAction(env3.ctx, "alert-agr-lease:notice_by:2026-11-01", "snooze_7d");
    r = check("whats_coming_up", await whatsComingUp(env3.ctx, { window_days: 30 }));
    expect(items(r).some((i) => i.type === "notice_by")).toBe(false);
    const later = makeContext(env3, { today: "2026-10-29" });
    r = check("whats_coming_up", await whatsComingUp(later, { window_days: 30 }));
    expect(items(r).some((i) => i.type === "notice_by")).toBe(true);
  });

  it("only lists this household", async () => {
    const env = await seeded();
    const other = makeContext(env, { householdId: B });
    const r = check("whats_coming_up", await whatsComingUp(other, { window_days: 30 }));
    expect(items(r)).toEqual([]);
  });

  it("shows a recall dismissed as not mine nowhere", async () => {
    const env = await seeded();
    await applyAlertAction(env.ctx, "alert-recall-26530", "not_mine");
    const r = check("whats_coming_up", await whatsComingUp(env.ctx, { window_days: 30 }));
    expect(((r.structuredContent as any).recalls as any[]).map((x) => x.alertId)).toEqual(["alert-recall-26V332000"]);
  });
});
