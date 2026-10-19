import type { Asset } from "core/src/contracts";
import { describe, expect, it } from "vitest";
import { addRecord, nextOnDay } from "../src/mcp/tools/addRecord";
import { askDocuments } from "../src/mcp/tools/askDocuments";
import { getAgreement } from "../src/mcp/tools/getAgreement";
import { getHistory } from "../src/mcp/tools/getHistory";
import { logService } from "../src/mcp/tools/logService";
import { resolveAlert } from "../src/mcp/tools/resolveAlert";
import { uiResolveAlert } from "../src/mcp/tools/uiResolveAlert";
import { uiShowClaimSteps } from "../src/mcp/tools/uiShowClaimSteps";
import { uiShowClause } from "../src/mcp/tools/uiShowClause";
import { undoLast } from "../src/mcp/tools/undoLast";
import { whatsComingUp } from "../src/mcp/tools/whatsComingUp";
import { A, B, check, makeContext, seeded, text } from "./helpers";

const sc = (r: { structuredContent?: Record<string, unknown> }) => r.structuredContent as any;

describe("ask_documents", () => {
  it("returns the top clauses with document name and page", async () => {
    const { ctx } = await seeded();
    const r = check(
      "ask_documents",
      await askDocuments(ctx, { question: "what does my lease say about breaking it early" }),
    );
    expect(sc(r).found).toBe(true);
    expect(sc(r).clauses.length).toBeLessThanOrEqual(3);
    expect(sc(r).clauses[0]).toMatchObject({ docName: "lease.pdf", page: 4, quotedFromDocument: true });
    expect(text(r)).toContain("page 4");
    expect(text(r)).toContain("Quoted from lease");
  });

  it("finds the deductible and quotes the matching line, not the page header", async () => {
    const { ctx } = await seeded();
    const r = check("ask_documents", await askDocuments(ctx, { question: "what is my car insurance deductible" }));
    expect(text(r)).toContain("Collision: $500 deductible");
    expect(text(r)).not.toContain("1200 Maple");
    expect(sc(r).clauses[0].docName).toBe("insurance_auto.pdf");
  });

  it("says nothing relevant was found for an off topic question", async () => {
    const { ctx } = await seeded();
    for (const q of ["capital of France", "xyzzy plugh", "banana bread recipe"]) {
      const r = check("ask_documents", await askDocuments(ctx, { question: q }));
      expect(sc(r).found, q).toBe(false);
      expect(sc(r).clauses).toEqual([]);
      expect(text(r)).toContain("nothing relevant");
    }
  });

  it("limits the search to one asset when about names it", async () => {
    const { ctx } = await seeded();
    const r = check("ask_documents", await askDocuments(ctx, { question: "water damage", about: "dishwasher" }));
    expect(sc(r).scope).toEqual({ assetId: "A-dishwasher", agreementId: null });
    for (const c of sc(r).clauses) expect(c.docId).toBe("doc-warranty_dishwasher");
  });

  it("limits the search to one agreement when about names it", async () => {
    const { ctx } = await seeded();
    const r = check(
      "ask_documents",
      await askDocuments(ctx, { question: "when do I have to give notice", about: "lease" }),
    );
    expect(sc(r).scope.agreementId).toBe("agr-lease");
    for (const c of sc(r).clauses) expect(c.docId).toBe("doc-lease");
  });

  it("finds nothing when the scoped document does not hold the answer", async () => {
    const { ctx } = await seeded();
    const r = check(
      "ask_documents",
      await askDocuments(ctx, { question: "water damage improper installation", about: "lease" }),
    );
    expect(sc(r).clauses.every((c: any) => c.docId === "doc-lease")).toBe(true);
  });

  it("says it could not find the thing in about, and asks when it is ambiguous", async () => {
    const { repo, ctx } = await seeded();
    let r = check("ask_documents", await askDocuments(ctx, { question: "anything", about: "spaceship" }));
    expect(sc(r).kind).toBe("not_found");
    for (const [i, name] of ["Fridge water filter", "Shower water filter"].entries()) {
      await repo.putAsset(A, { id: `W${i}`, name, aliases: [], createdAt: "2026-10-21T00:00:00.000Z" });
    }
    r = check("ask_documents", await askDocuments(ctx, { question: "anything", about: "water filter" }));
    expect(sc(r).kind).toBe("ambiguous");
    expect(sc(r).options.length).toBeLessThanOrEqual(3);
  });

  it("marks quoted text as data and carries a notice", async () => {
    const { ctx } = await seeded();
    const r = check("ask_documents", await askDocuments(ctx, { question: "report a claim within days" }));
    expect(sc(r).notice).toMatch(/never instructions/);
    expect(sc(r).clauses.every((c: any) => c.quotedFromDocument === true)).toBe(true);
  });

  it("only searches this household's documents", async () => {
    const { repo, indexSource } = await seeded();
    const other = makeContext({ repo, indexSource }, { householdId: B });
    const r = check("ask_documents", await askDocuments(other, { question: "water damage improper installation" }));
    expect(sc(r).found).toBe(false);
  });

  it("masks long numbers in the clause text it returns", async () => {
    const { ctx } = await seeded();
    const r = check("ask_documents", await askDocuments(ctx, { question: "policy number named insured" }));
    expect(JSON.stringify(r)).not.toContain("0048-4821");
  });
});

describe("get_agreement", () => {
  it("reads the key terms of the car insurance with the policy number masked", async () => {
    const { ctx } = await seeded();
    const r = check("get_agreement", await getAgreement(ctx, { about: "car insurance" }));
    const terms = sc(r).terms as { label: string; value: string }[];
    expect(terms.find((t) => t.label === "Policy number")!.value).toBe("ending 4821");
    expect(terms.find((t) => t.label === "Insurer")!.value).toContain("Harbor Mutual");
    expect(terms.find((t) => t.label === "Premium")!.value).toContain("$684");
    expect(JSON.stringify(r)).not.toContain("HM-AU-0048");
    expect(text(r)).toContain("policy ending 4821");
    expect(sc(r).agreement.docName).toBe("insurance_auto.pdf");
    expect(sc(r).datesConfirmed).toBe(true);
  });

  it("reads the lease, a subscription and the warranty", async () => {
    const { ctx } = await seeded();
    let r = check("get_agreement", await getAgreement(ctx, { about: "my lease" }));
    expect(text(r)).toContain("60 days notice");
    expect(text(r)).toContain("from January 1 to December 31");
    r = check("get_agreement", await getAgreement(ctx, { about: "Kestrel" }));
    expect(text(r)).toContain("$9.99");
    expect(sc(r).terms.find((t: any) => t.label === "Cancel notice").value).toBe("2 days");
    r = check("get_agreement", await getAgreement(ctx, { about: "dishwasher warranty" }));
    expect(text(r)).toContain("from November 12, 2025 to November 12, 2026");
    expect(sc(r).terms.find((t: any) => t.label === "Claim window").value).toBe("30 days");
  });

  it("asks which one when the phrase fits two agreements", async () => {
    const { ctx } = await seeded();
    const r = check("get_agreement", await getAgreement(ctx, { about: "subscription" }));
    expect(sc(r).kind).toBe("ambiguous");
    expect(sc(r).options).toHaveLength(2);
  });

  it("says so when there is no such agreement", async () => {
    const { ctx } = await seeded();
    const r = check("get_agreement", await getAgreement(ctx, { about: "pet insurance" }));
    expect(sc(r).kind).toBe("not_found");
  });

  it("only reads this household's agreements", async () => {
    const { repo, indexSource } = await seeded();
    const other = makeContext({ repo, indexSource }, { householdId: B });
    const r = check("get_agreement", await getAgreement(other, { about: "lease" }));
    expect(sc(r).kind).toBe("not_found");
  });

  it("marks terms that come from a voice add as not from a document", async () => {
    const { ctx } = await seeded();
    await addRecord(ctx, { kind: "subscription", vendor: "Gym", amount: 40, cycle: "monthly", day_of_month: 5 });
    const r = check("get_agreement", await getAgreement(ctx, { about: "gym" }));
    expect(sc(r).quotedFromDocument).toBe(false);
    expect(sc(r).agreement.docId).toBeNull();
  });
});

describe("add_record", () => {
  it("adds a subscription by voice, confirmed, with its next charge and cancel obligations", async () => {
    const { ctx, repo } = await seeded();
    const r = check(
      "add_record",
      await addRecord(ctx, { kind: "subscription", vendor: "Gym", amount: 40, cycle: "monthly", day_of_month: 5 }),
    );
    expect(sc(r)).toMatchObject({ created: true, recordKind: "subscription", name: "Gym", undoAvailable: true });
    expect(text(r)).toBe("Added Gym, $40 monthly. The next charge is November 5.");
    const agreement = (await repo.getAgreement(A, sc(r).id))!;
    expect(agreement.fieldStatus.nextChargeDate).toBe("confirmed");
    expect(agreement.fields.nextChargeDate).toBe("2026-11-05");
    const obligations = await repo.listObligations(A, { from: "2026-10-21", to: "2026-12-31" });
    expect(obligations.find((o) => o.agreementId === agreement.id && o.type === "charge")).toMatchObject({
      dueDate: "2026-11-05",
      confirmed: true,
    });
  });

  it("raises an alert when the charge is close, because the date was confirmed by voice", async () => {
    const { ctx, repo } = await seeded();
    await addRecord(ctx, {
      kind: "subscription",
      vendor: "Gym",
      amount: 40,
      cycle: "monthly",
      next_charge_date: "2026-10-24",
    });
    const alerts = await repo.listAlerts(A, { open: true });
    expect(alerts.some((a) => a.label.startsWith("Gym") && a.severity === "high")).toBe(true);
  });

  it("uses the given charge date, and says so when there is none", async () => {
    const { ctx } = await seeded();
    let r = check(
      "add_record",
      await addRecord(ctx, {
        kind: "subscription",
        vendor: "Paper",
        amount: 8,
        cycle: "annual",
        next_charge_date: "2027-03-01",
      }),
    );
    expect(text(r)).toContain("March 1, 2027");
    r = check(
      "add_record",
      await addRecord(ctx, { kind: "subscription", vendor: "Mystery", amount: 3, cycle: "monthly" }),
    );
    expect(text(r)).toContain("Tell me the charge date");
    expect(sc(r).obligations).toEqual([]);
  });

  it("adds an asset", async () => {
    const { ctx, repo } = await seeded();
    const r = check(
      "add_record",
      await addRecord(ctx, {
        kind: "asset",
        name: "Bosch washer",
        brand: "Bosch",
        category: "appliance",
        location: "basement",
      }),
    );
    expect(sc(r)).toMatchObject({ created: true, recordKind: "asset", name: "Bosch washer" });
    const asset = (await repo.getAsset(A, sc(r).id))!;
    expect(asset).toMatchObject({ brand: "Bosch", category: "appliance", location: "basement" });
  });

  it("does not add the same thing twice", async () => {
    const { ctx, repo } = await seeded();
    let r = check("add_record", await addRecord(ctx, { kind: "asset", name: "Dishwasher" }));
    expect(sc(r).created).toBe(false);
    expect((await repo.listAssets(A)).filter((a) => a.name === "Dishwasher")).toHaveLength(1);
    r = check(
      "add_record",
      await addRecord(ctx, { kind: "subscription", vendor: "kestrel learning", amount: 1, cycle: "monthly" }),
    );
    expect(sc(r).created).toBe(false);
  });

  it("writes an undo record that undo_last applies", async () => {
    const { ctx, repo } = await seeded();
    const r = await addRecord(ctx, {
      kind: "subscription",
      vendor: "Gym",
      amount: 40,
      cycle: "monthly",
      next_charge_date: "2026-10-24",
    });
    const id = sc(r).id as string;
    const u = check("undo_last", await undoLast(ctx, {}));
    expect(text(u)).toBe("Okay, I removed the Gym subscription you just added.");
    expect(sc(u)).toMatchObject({ undone: true });
    expect(await repo.getAgreement(A, id)).toBeNull();
    expect(
      (await repo.listObligations(A, { from: "2026-10-21", to: "2027-12-31" })).some((o) => o.agreementId === id),
    ).toBe(false);
    const alerts = await repo.listAlerts(A, { open: true });
    expect(alerts.some((a) => a.refId.startsWith(`${id}:`))).toBe(false);
    const again = check("undo_last", await undoLast(ctx, {}));
    expect(sc(again).undone).toBe(false);
    expect(text(again)).toBe("There is nothing to undo.");
  });

  it("undoes an asset add, and only the last write", async () => {
    const { ctx, repo } = await seeded();
    const first = await addRecord(ctx, { kind: "asset", name: "Bosch washer" });
    const second = await addRecord(ctx, { kind: "asset", name: "Garden hose" });
    await undoLast(ctx, {});
    expect(await repo.getAsset(A, sc(second).id)).toBeNull();
    expect(await repo.getAsset(A, sc(first).id)).not.toBeNull();
  });

  it("will not undo a write that is more than 24 hours old", async () => {
    const { ctx } = await seeded();
    await addRecord(ctx, { kind: "asset", name: "Bosch washer" });
    const later = { ...ctx, nowMs: ctx.nowMs + 25 * 3600 * 1000 };
    const u = check("undo_last", await undoLast(later, {}));
    expect(sc(u).undone).toBe(false);
  });

  it("clamps a day of month to short months", () => {
    expect(nextOnDay(31, "2026-02-10")).toBe("2026-02-28");
    expect(nextOnDay(5, "2026-10-21")).toBe("2026-11-05");
    expect(nextOnDay(21, "2026-10-21")).toBe("2026-10-21");
    expect(nextOnDay(30, "2026-12-31")).toBe("2027-01-30");
  });

  it("keeps a household's undo records apart", async () => {
    const { ctx, repo, indexSource } = await seeded();
    await addRecord(ctx, { kind: "asset", name: "Bosch washer" });
    const other = makeContext({ repo, indexSource }, { householdId: B });
    expect(sc(await undoLast(other, {})).undone).toBe(false);
    expect(sc(await undoLast(ctx, {})).undone).toBe(true);
  });
});

describe("log_service, get_history", () => {
  it("logs a service for today and reads it back", async () => {
    const { ctx, repo } = await seeded();
    const r = check("log_service", await logService(ctx, { asset: "car", action: "oil change" }));
    expect(sc(r)).toMatchObject({ assetId: "A-car", action: "oil change", date: "2026-10-21", undoAvailable: true });
    expect(text(r)).toContain("Logged: oil change");
    const events = await repo.listEvents(A, "A-car", 10);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ source: "voice", action: "oil change" });
    const h = check("get_history", await getHistory(ctx, { asset: "car" }));
    expect(sc(h).events).toHaveLength(1);
    expect(text(h)).toContain("oil change, October 21");
  });

  it("uses the date the person gave and rejects the future", async () => {
    const { ctx } = await seeded();
    const r = check(
      "log_service",
      await logService(ctx, { asset: "car", action: "tire rotation", date: "2026-09-01" }),
    );
    expect(sc(r).date).toBe("2026-09-01");
    expect(text(r)).toContain("September 1");
    const bad = check(
      "log_service",
      await logService(ctx, { asset: "car", action: "tire rotation", date: "2026-12-01" }),
    );
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain("has not happened yet");
  });

  it("returns the newest events first and at most 5", async () => {
    const { ctx } = await seeded();
    for (let i = 1; i <= 7; i++) await logService(ctx, { asset: "car", action: `job ${i}`, date: `2026-09-0${i}` });
    const h = check("get_history", await getHistory(ctx, { asset: "car" }));
    expect(sc(h).events).toHaveLength(5);
    expect(sc(h).events[0].action).toBe("job 7");
    expect(sc(h).events[4].action).toBe("job 3");
  });

  it("says there is no history when there is none", async () => {
    const { ctx } = await seeded();
    const h = check("get_history", await getHistory(ctx, { asset: "dishwasher" }));
    expect(text(h)).toContain("no service history");
    expect(sc(h).nextServiceDue).toBeNull();
  });

  it("computes the next service due from the last event and the plan interval", async () => {
    const { ctx, repo } = await seeded();
    await repo.putAgreement(A, {
      id: "agr-plan",
      kind: "service_plan",
      party: "CarCare",
      assetIds: ["A-car"],
      fields: { provider: "CarCare", intervalDays: 180 },
      fieldStatus: { provider: "confirmed", intervalDays: "confirmed" },
      sourceRefs: {},
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    const r = check("log_service", await logService(ctx, { asset: "car", action: "oil change", date: "2026-10-01" }));
    expect(sc(r).nextServiceDue).toBe("2027-03-30");
    expect(text(r)).toContain("The next service is due March 30, 2027");
    const h = check("get_history", await getHistory(ctx, { asset: "car" }));
    expect(sc(h).nextServiceDue).toMatchObject({ date: "2027-03-30" });
    expect(text(h)).toContain("The next service is due March 30, 2027");
  });

  it("recomputes the next service due when the log is undone", async () => {
    const { ctx, repo } = await seeded();
    await repo.putAgreement(A, {
      id: "agr-plan",
      kind: "service_plan",
      assetIds: ["A-car"],
      fields: { provider: "CarCare", intervalDays: 180 },
      fieldStatus: { provider: "confirmed", intervalDays: "confirmed" },
      sourceRefs: {},
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    await logService(ctx, { asset: "car", action: "oil change" });
    expect(
      (await repo.listObligations(A, { from: "2027-01-01", to: "2027-12-31" })).some((o) => o.type === "service_due"),
    ).toBe(true);
    await undoLast(ctx, {});
    expect(
      (await repo.listObligations(A, { from: "2027-01-01", to: "2027-12-31" })).some((o) => o.type === "service_due"),
    ).toBe(false);
  });

  it("asks which one when two things match, and says when none does", async () => {
    const { ctx, repo } = await seeded();
    for (const [i, name] of ["Work laptop", "Personal laptop"].entries()) {
      await repo.putAsset(A, { id: `L${i}`, name, aliases: [], createdAt: "2026-10-21T00:00:00.000Z" } as Asset);
    }
    const r = check("log_service", await logService(ctx, { asset: "laptop", action: "cleaned" }));
    expect(sc(r).kind).toBe("ambiguous");
    expect(await repo.listEvents(A, "L0", 5)).toEqual([]);
    const none = check("get_history", await getHistory(ctx, { asset: "spaceship" }));
    expect(sc(none).kind).toBe("not_found");
  });

  it("never writes to another household", async () => {
    const { repo, indexSource } = await seeded();
    const other = makeContext({ repo, indexSource }, { householdId: B });
    const r = check("log_service", await logService(other, { asset: "car", action: "oil change" }));
    expect(sc(r).kind).toBe("not_found");
    expect(await repo.listEvents(A, "A-car", 5)).toEqual([]);
    expect(await repo.listEvents(B, "A-car", 5)).toEqual([]);
  });
});

describe("resolve_alert and ui_resolve_alert", () => {
  const INSURANCE = "alert-agr-insurance_auto:renews:2026-10-30";

  it.each([
    ["done", "done"],
    ["dismiss", "dismissed"],
  ] as const)("%s closes the alert", async (action, status) => {
    const { ctx, repo } = await seeded();
    const r = check("resolve_alert", await resolveAlert(ctx, { alert_id: INSURANCE, action }));
    expect(sc(r)).toMatchObject({ alertId: INSURANCE, action, status, suppressed: false });
    expect((await repo.getAlert(A, INSURANCE))!.status).toBe(status);
    expect((await repo.listAlerts(A, { open: true })).some((a) => a.id === INSURANCE)).toBe(false);
  });

  it("not_mine on a recall writes a suppression and closes the alert", async () => {
    const { ctx, repo } = await seeded();
    const r = check("resolve_alert", await resolveAlert(ctx, { alert_id: "alert-recall-26530", action: "not_mine" }));
    expect(sc(r)).toMatchObject({ status: "dismissed", suppressed: true });
    expect(await repo.listSuppressions(A)).toEqual([
      expect.objectContaining({ source: "cpsc", recallId: "26530", assetId: "A-baby-bottles" }),
    ]);
    expect((await repo.getAlert(A, "alert-recall-26530"))!.status).toBe("dismissed");
  });

  it("uses nhtsa as the source for a campaign number", async () => {
    const { ctx, repo } = await seeded();
    await resolveAlert(ctx, { alert_id: "alert-recall-26V332000", action: "not_mine" });
    expect((await repo.listSuppressions(A))[0]).toMatchObject({ source: "nhtsa", recallId: "26V332000" });
  });

  it("not_mine on a deadline is refused with a spoken reason", async () => {
    const { ctx, repo } = await seeded();
    const r = check("resolve_alert", await resolveAlert(ctx, { alert_id: INSURANCE, action: "not_mine" }));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("only applies to recalls");
    expect(await repo.listSuppressions(A)).toEqual([]);
    expect((await repo.getAlert(A, INSURANCE))!.status).toBe("pending");
  });

  it("snoozes for 7 days from today", async () => {
    const { ctx, repo } = await seeded();
    const r = check("resolve_alert", await resolveAlert(ctx, { alert_id: INSURANCE, action: "snooze_7d" }));
    expect(sc(r)).toMatchObject({ status: "snoozed", snoozedUntil: "2026-10-28T00:00:00.000Z" });
    expect(text(r)).toContain("October 28");
    expect((await repo.getAlert(A, INSURANCE))!.snoozedUntil).toBe("2026-10-28T00:00:00.000Z");
  });

  it("says so when the alert does not exist, as an error", async () => {
    const { ctx } = await seeded();
    const r = check("resolve_alert", await resolveAlert(ctx, { alert_id: "alert-nope", action: "done" }));
    expect(r.isError).toBe(true);
    expect(sc(r)).toMatchObject({ kind: "not_found", what: "alert" });
  });

  it("cannot resolve another household's alert", async () => {
    const { repo, indexSource } = await seeded();
    const other = makeContext({ repo, indexSource }, { householdId: B });
    const r = await resolveAlert(other, { alert_id: INSURANCE, action: "dismiss" });
    expect(r.isError).toBe(true);
    expect((await repo.getAlert(A, INSURANCE))!.status).toBe("pending");
  });

  it("the card button tool does the same", async () => {
    const { ctx, repo } = await seeded();
    const r = check("ui_resolve_alert", await uiResolveAlert(ctx, { alert_id: INSURANCE, action: "dismiss" }));
    expect(sc(r).status).toBe("dismissed");
    expect((await repo.getAlert(A, INSURANCE))!.status).toBe("dismissed");
  });

  it("a dismissed alert stays dismissed when the obligations are recomputed", async () => {
    const { ctx, repo } = await seeded();
    await resolveAlert(ctx, { alert_id: INSURANCE, action: "dismiss" });
    const { syncObligations } = await import("../src/obligations");
    await syncObligations(
      repo,
      A,
      (await repo.getAgreement(A, "agr-insurance_auto"))!,
      await repo.listAssets(A),
      "2026-10-21",
    );
    expect((await repo.getAlert(A, INSURANCE))!.status).toBe("dismissed");
    const r = check("whats_coming_up", await whatsComingUp(ctx, { window_days: 30 }));
    expect(text(r)).not.toContain("car insurance");
  });
});

describe("ui_show_clause and ui_show_claim_steps", () => {
  it("shows the clauses of one page", async () => {
    const { ctx } = await seeded();
    const r = check("ui_show_clause", await uiShowClause(ctx, { doc_id: "doc-warranty_dishwasher", page: 3 }));
    expect(sc(r)).toMatchObject({ kind: "clause_view", docName: "warranty_dishwasher.pdf", page: 3 });
    expect(sc(r).clauses.some((c: any) => /water damage/.test(c.text))).toBe(true);
    expect(sc(r).clauses.every((c: any) => c.page === 3 && c.quotedFromDocument)).toBe(true);
  });

  it("says when the page does not exist, and never shows another household's document", async () => {
    const { ctx, repo, indexSource } = await seeded();
    expect((await uiShowClause(ctx, { doc_id: "doc-warranty_dishwasher", page: 9 })).isError).toBe(true);
    expect((await uiShowClause(ctx, { doc_id: "doc-nope", page: 1 })).isError).toBe(true);
    const other = makeContext({ repo, indexSource }, { householdId: B });
    expect((await uiShowClause(other, { doc_id: "doc-warranty_dishwasher", page: 3 })).isError).toBe(true);
  });

  it("shows the claim steps and contact of an agreement", async () => {
    const { ctx } = await seeded();
    const r = check("ui_show_claim_steps", await uiShowClaimSteps(ctx, { agreement_id: "agr-warranty_dishwasher" }));
    expect(sc(r).steps).toHaveLength(4);
    expect(sc(r).claimWindowDays).toBe(30);
    expect(sc(r).contact).toMatchObject({ phone: "1-800-555-0142", email: "warranty@northwind-appliances.example" });
    expect(sc(r).quotedFromDocument).toBe(true);
    expect(text(r)).toBe("Here are the 4 claim steps.");
  });

  it("handles an agreement without claim steps and one that does not exist", async () => {
    const { ctx, repo, indexSource } = await seeded();
    const lease = check("ui_show_claim_steps", await uiShowClaimSteps(ctx, { agreement_id: "agr-lease" }));
    expect(sc(lease).steps).toEqual([]);
    expect((await uiShowClaimSteps(ctx, { agreement_id: "agr-nope" })).isError).toBe(true);
    const other = makeContext({ repo, indexSource }, { householdId: B });
    expect((await uiShowClaimSteps(other, { agreement_id: "agr-warranty_dishwasher" })).isError).toBe(true);
  });
});
