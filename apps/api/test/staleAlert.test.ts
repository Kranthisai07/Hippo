import { describe, expect, it } from "vitest";
import { syncObligations } from "../src/obligations";
import { A, seeded } from "./helpers";

// Found in the T3.1 report: alert ids include the due date, so editing a date left the alert for the OLD date pending,
// a false alarm about a deadline that no longer exists.
const setup = async () => {
  const env = await seeded("2026-10-21");
  const agreements = await env.repo.listAgreements(A);
  const lease = agreements.find((a) => a.kind === "lease")!;
  const assets = await env.repo.listAssets(A);
  const alertsOf = async (agreementId: string) =>
    (await env.repo.listAlerts(A)).filter((a) => a.refId.startsWith(`${agreementId}:`));
  return { env, lease, assets, alertsOf, agreements };
};

describe("a changed date closes the alert for the old date", () => {
  it("dismisses a pending alert whose obligation no longer exists", async () => {
    const { env, lease, assets, alertsOf } = await setup();
    const before = await alertsOf(lease.id);
    expect(before.some((a) => a.refId.includes("notice_by:2026-11-01") && a.status === "pending")).toBe(true);

    const edited = { ...lease, fields: { ...lease.fields, endDate: "2027-12-31" } };
    await env.repo.putAgreement(A, edited);
    await syncObligations(env.repo, A, edited, assets, "2026-10-21");

    const after = await alertsOf(lease.id);
    const old = after.find((a) => a.refId.includes("notice_by:2026-11-01"))!;
    expect(old.status).toBe("dismissed");
    expect(after.filter((a) => a.status === "pending" || a.status === "announced")).toEqual([]);
  });

  it("also closes an announced alert, but never reopens or changes a done one", async () => {
    const { env, lease, assets, alertsOf } = await setup();
    const [first, second] = (await alertsOf(lease.id)).filter((a) => a.refId.includes(":notice_by:") || true);
    expect(first).toBeDefined();
    await env.repo.putAlert(A, { ...first!, status: "announced" });
    if (second) await env.repo.putAlert(A, { ...second, status: "done" });

    const edited = { ...lease, fields: { ...lease.fields, endDate: "2027-12-31", startDate: "2027-01-01" } };
    await syncObligations(env.repo, A, edited, assets, "2026-10-21");

    const after = await alertsOf(lease.id);
    expect(after.find((a) => a.id === first!.id)!.status).toBe("dismissed");
    if (second) expect(after.find((a) => a.id === second.id)!.status).toBe("done");
  });

  it("leaves the alerts of other agreements alone", async () => {
    const { env, lease, assets, agreements } = await setup();
    const other = agreements.find((a) => a.kind === "insurance")!;
    const mine = async () => (await env.repo.listAlerts(A)).filter((a) => a.refId.startsWith(`${other.id}:`));
    const before = await mine();
    expect(before.length).toBeGreaterThan(0);
    const edited = { ...lease, fields: { ...lease.fields, endDate: "2027-12-31" } };
    await syncObligations(env.repo, A, edited, assets, "2026-10-21");
    expect(await mine()).toEqual(before);
  });

  it("keeps an alert whose obligation is still there (running it twice changes nothing)", async () => {
    const { env, lease, assets, alertsOf } = await setup();
    const before = await alertsOf(lease.id);
    await syncObligations(env.repo, A, lease, assets, "2026-10-21");
    await syncObligations(env.repo, A, lease, assets, "2026-10-21");
    expect(await alertsOf(lease.id)).toEqual(before);
  });
});
