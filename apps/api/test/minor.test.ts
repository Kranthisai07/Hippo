import type { Agreement } from "core/src/contracts";
import { describe, expect, it } from "vitest";
import { checkCoverage } from "../src/mcp/tools/checkCoverage";
import { logService } from "../src/mcp/tools/logService";
import { undoLast } from "../src/mcp/tools/undoLast";
import { uiShowClaimSteps } from "../src/mcp/tools/uiShowClaimSteps";
import { A, check, connect, makeEnv, seeded } from "./helpers";

// Minor findings from the pre-merge review.

describe("tool annotations", () => {
  it("a tool that can announce an alert is not marked read only", async () => {
    const env = await makeEnv();
    const c = await connect(env, await env.tokenA());
    const { tools } = await c.client.listTools();
    const hint = (n: string) => tools.find((t) => t.name === n)?.annotations?.readOnlyHint;
    for (const name of [
      "whats_coming_up",
      "check_coverage",
      "ask_documents",
      "get_agreement",
      "get_history",
      "add_record",
      "log_service",
      "resolve_alert",
      "undo_last",
    ]) {
      expect(hint(name), name).toBe(false);
    }
    await c.close();
  });
});

describe("numbers inside claim steps are masked in the structured content too", () => {
  const withLongNumber = async () => {
    const env = await seeded("2026-10-21");
    const [w] = (await env.repo.listAgreements(A, { assetId: "A-dishwasher" })).filter((a) => a.kind === "warranty");
    const steps = ["Call and quote policy 1234 5678 9012 3456 to start the claim.", "Keep the receipt."];
    await env.repo.putAgreement(A, { ...w!, fields: { ...w!.fields, claimSteps: steps } } as Agreement);
    return { env, id: w!.id };
  };

  it("check_coverage", async () => {
    const { env } = await withLongNumber();
    const r = check("check_coverage", await checkCoverage(env.ctx, { asset: "dishwasher", issue: "leaking" }));
    const dump = JSON.stringify(r);
    expect(dump).not.toContain("1234 5678 9012 3456");
    expect(dump).toContain("ending 3456");
  });

  it("ui_show_claim_steps", async () => {
    const { env, id } = await withLongNumber();
    const r = await uiShowClaimSteps(env.ctx, { agreement_id: id });
    const dump = JSON.stringify(r);
    expect(dump).not.toContain("1234 5678 9012 3456");
    expect(dump).toContain("ending 3456");
  });
});

describe("undoing a logged service takes back the alert it raised", () => {
  it("dismisses the pending service_due alert and clears the obligation", async () => {
    const env = await seeded("2026-10-21");
    const plan: Agreement = {
      id: "AG-svc",
      kind: "service_plan",
      party: "Quick Lube",
      assetIds: ["A-car"],
      fields: { provider: "Quick Lube", intervalDays: 20 },
      fieldStatus: { provider: "confirmed", intervalDays: "confirmed" },
      sourceRefs: {},
      createdAt: "2026-10-01T00:00:00.000Z",
    };
    await env.repo.putAgreement(A, plan);

    const logged = await logService(env.ctx, { asset: "car", action: "oil change" });
    expect(logged.isError).toBeUndefined();
    const raised = (await env.repo.listAlerts(A)).filter((a) => a.refId.startsWith("AG-svc:"));
    expect(raised.length).toBeGreaterThan(0);
    expect(raised.every((a) => a.status === "pending")).toBe(true);

    const undone = await undoLast(env.ctx, {});
    expect(undone.structuredContent).toMatchObject({ undone: true });
    const after = (await env.repo.listAlerts(A)).filter((a) => a.refId.startsWith("AG-svc:"));
    expect(after.every((a) => a.status === "dismissed")).toBe(true);
    expect(await env.repo.listObligations(A, { from: "2026-10-01", to: "2027-12-31" })).not.toContainEqual(
      expect.objectContaining({ agreementId: "AG-svc" }),
    );
  });
});
