import { describe, expect, it } from "vitest";
import {
  claimByDate,
  computeObligations,
  severityFor,
  type AgreementInput,
  type AgreementKind,
  type FieldStatus,
  type Obligation,
  type ObligationType,
} from "../src";

const TODAY = "2026-10-21";

/** Builds an agreement where every provided field is confirmed unless overridden. */
function mk(kind: AgreementKind, fields: Record<string, unknown>, override: Record<string, FieldStatus> = {}): AgreementInput {
  const fieldStatus: Record<string, FieldStatus> = {};
  for (const k of Object.keys(fields)) fieldStatus[k] = "confirmed";
  return { kind, fields, fieldStatus: { ...fieldStatus, ...override } };
}

const run = (a: AgreementInput, today = TODAY) => computeObligations(a, today);
const one = (obs: Obligation[], type: ObligationType): Obligation => {
  const hit = obs.find((o) => o.type === type);
  if (!hit) throw new Error(`no ${type} obligation in ${JSON.stringify(obs.map((o) => o.type))}`);
  return hit;
};

describe("warranty", () => {
  it("expires at start plus term", () => {
    const o = one(run(mk("warranty", { startDate: "2025-11-12", termMonths: 12 })), "expires");
    expect(o.dueDate).toBe("2026-11-12");
    expect(o.daysUntil).toBe(22);
    expect(o.severity).toBe("possible");
  });
  it("prefers an explicit end date over start plus term", () => {
    const o = one(run(mk("warranty", { startDate: "2025-11-12", termMonths: 12, endDate: "2027-01-01" })), "expires");
    expect(o.dueDate).toBe("2027-01-01");
    expect(o.sourceFields).toEqual(["endDate"]);
  });
  it("clamps a month-end start", () => {
    expect(one(run(mk("warranty", { startDate: "2026-01-31", termMonths: 1 })), "expires").dueDate).toBe("2026-02-28");
  });
  it("rolls a leap-day start to Feb 28 after 12 months", () => {
    expect(one(run(mk("warranty", { startDate: "2024-02-29", termMonths: 12 })), "expires").dueDate).toBe("2025-02-28");
  });
  it("makes no obligation without a term or end date", () => {
    expect(run(mk("warranty", { startDate: "2025-11-12" }))).toEqual([]);
  });
  it("lists an already expired warranty but never alerts on it", () => {
    const o = one(run(mk("warranty", { endDate: "2026-09-01" })), "expires");
    expect(o.daysUntil).toBe(-50);
    expect(o.severity).toBeNull();
  });
  it("is high at exactly 14 days and possible at 15", () => {
    expect(one(run(mk("warranty", { endDate: "2026-11-04" })), "expires").severity).toBe("high");
    expect(one(run(mk("warranty", { endDate: "2026-11-05" })), "expires").severity).toBe("possible");
  });
  it("computes a claim-by date from the incident", () => {
    expect(claimByDate("2026-10-21", 30)).toBe("2026-11-20");
    expect(claimByDate("2026-01-31", 30)).toBe("2026-03-02");
  });
  it("ignores a negative or fractional term", () => {
    expect(run(mk("warranty", { startDate: "2025-11-12", termMonths: -1 }))).toEqual([]);
    expect(run(mk("warranty", { startDate: "2025-11-12", termMonths: 1.5 }))).toEqual([]);
  });
});

describe("insurance", () => {
  const base = { expirationDate: "2026-10-30" };
  it("renews when auto, and is high 9 days out (D-015)", () => {
    const o = one(run(mk("insurance", { ...base, renewal: "auto" })), "renews");
    expect(o.dueDate).toBe("2026-10-30");
    expect(o.daysUntil).toBe(9);
    expect(o.severity).toBe("high");
  });
  it("expires when renewal is manual", () => {
    expect(run(mk("insurance", { ...base, renewal: "manual" })).map((o) => o.type)).toEqual(["expires"]);
  });
  it("expires when renewal is unknown, depending only on the date", () => {
    const o = one(run(mk("insurance", { ...base, renewal: null })), "expires");
    expect(o.sourceFields).toEqual(["expirationDate"]);
  });
  it("treats an unconfirmed renewal flag as unconfirmed", () => {
    const o = one(run(mk("insurance", { ...base, renewal: "auto" }, { renewal: "extracted" })), "renews");
    expect(o.confirmed).toBe(false);
    expect(o.severity).toBeNull();
  });
  it("makes nothing from an impossible date", () => {
    expect(run(mk("insurance", { expirationDate: "2026-02-30", renewal: "auto" }))).toEqual([]);
  });
  it("computes the claim report window from the loss date", () => {
    expect(claimByDate("2026-10-21", 14)).toBe("2026-11-04");
  });
});

describe("lease", () => {
  const lease = { endDate: "2026-12-31", noticeDaysToVacate: 60 };
  it("notice_by is end date minus calendar days, high within 14 days", () => {
    const o = one(run(mk("lease", lease)), "notice_by");
    expect(o.dueDate).toBe("2026-11-01");
    expect(o.daysUntil).toBe(11);
    expect(o.severity).toBe("high");
  });
  it("uses business days with federal holidays when the clause says so", () => {
    const o = one(run(mk("lease", { endDate: "2026-12-31", noticeDaysToVacate: 5, noticeDaysType: "business" })), "notice_by");
    expect(o.dueDate).toBe("2026-12-23");
    expect(o.sourceFields).toContain("noticeDaysType");
  });
  it("keeps a passed notice window but never alerts", () => {
    const o = one(run(mk("lease", { endDate: "2026-11-30", noticeDaysToVacate: 60 })), "notice_by");
    expect(o.dueDate).toBe("2026-10-01");
    expect(o.daysUntil).toBe(-20);
    expect(o.severity).toBeNull();
  });
  it("handles a leap year and a non-leap year", () => {
    expect(one(run(mk("lease", { endDate: "2028-03-01", noticeDaysToVacate: 1 })), "notice_by").dueDate).toBe("2028-02-29");
    expect(one(run(mk("lease", { endDate: "2027-03-01", noticeDaysToVacate: 1 })), "notice_by").dueDate).toBe("2027-02-28");
  });
  it("adds an expires obligation", () => {
    const o = one(run(mk("lease", lease)), "expires");
    expect(o.dueDate).toBe("2026-12-31");
    expect(o.severity).toBeNull(); // 71 days out
  });
  it("skips notice_by when the notice period is unknown", () => {
    expect(run(mk("lease", { endDate: "2026-12-31" })).map((o) => o.type)).toEqual(["expires"]);
  });
  it("schedules rent on the next due day", () => {
    expect(one(run(mk("lease", { ...lease, rentDueDay: 1 })), "charge").dueDate).toBe("2026-11-01");
  });
  it("clamps rent due on the 31st to a short month", () => {
    expect(one(run(mk("lease", { rentDueDay: 31 }), "2026-02-10"), "charge").dueDate).toBe("2026-02-28");
  });
  it("counts rent due today", () => {
    const o = one(run(mk("lease", { rentDueDay: 1 }), "2026-11-01"), "charge");
    expect(o.dueDate).toBe("2026-11-01");
    expect(o.daysUntil).toBe(0);
  });
  it("makes no rent charge after the lease ends", () => {
    expect(run(mk("lease", { ...lease, rentDueDay: 1 }), "2026-12-15").some((o) => o.type === "charge")).toBe(false);
  });
  it("ignores a rent day outside 1 to 31", () => {
    expect(run(mk("lease", { rentDueDay: 0 })).some((o) => o.type === "charge")).toBe(false);
    expect(run(mk("lease", { rentDueDay: 32 })).some((o) => o.type === "charge")).toBe(false);
  });
});

describe("subscription", () => {
  it("monthly with a cancel notice: charge possible, cancel_by high (Fernwood)", () => {
    const obs = run(mk("subscription", { nextChargeDate: "2026-11-03", cycle: "monthly", cancelNoticeDays: 1 }));
    expect(one(obs, "charge")).toMatchObject({ dueDate: "2026-11-03", severity: "possible" });
    expect(one(obs, "cancel_by")).toMatchObject({ dueDate: "2026-11-02", severity: "high" });
  });
  it("trial: cancel_by comes from the trial end (Kestrel)", () => {
    const obs = run(
      mk("subscription", { nextChargeDate: "2026-10-28", trialEndDate: "2026-10-28", cycle: "monthly", cancelNoticeDays: 2 }),
    );
    expect(one(obs, "cancel_by")).toMatchObject({ dueDate: "2026-10-26", daysUntil: 5, severity: "high" });
    expect(one(obs, "trial_end")).toMatchObject({ dueDate: "2026-10-28", daysUntil: 7, severity: "high" });
  });
  it("trial_end is possible at 8 days", () => {
    expect(one(run(mk("subscription", { trialEndDate: "2026-10-29" })), "trial_end").severity).toBe("possible");
  });
  it("after the trial ends, cancel_by follows the regular charge", () => {
    const obs = run(mk("subscription", { nextChargeDate: "2026-11-03", trialEndDate: "2026-10-01", cancelNoticeDays: 1 }));
    expect(one(obs, "cancel_by").dueDate).toBe("2026-11-02");
  });
  it("makes no cancel_by when the notice period is unknown", () => {
    expect(run(mk("subscription", { nextChargeDate: "2026-11-03" })).some((o) => o.type === "cancel_by")).toBe(false);
  });
  it("rolls a past monthly charge forward", () => {
    const o = one(run(mk("subscription", { nextChargeDate: "2026-08-03", cycle: "monthly" })), "charge");
    expect(o.dueDate).toBe("2026-11-03");
    expect(o.sourceFields).toEqual(["nextChargeDate", "cycle"]);
  });
  it("does not drift off the 31st when rolling monthly", () => {
    expect(one(run(mk("subscription", { nextChargeDate: "2026-01-31", cycle: "monthly" }), "2026-03-01"), "charge").dueDate).toBe(
      "2026-03-31",
    );
  });
  it("rolls an annual leap-day charge to Feb 28", () => {
    expect(one(run(mk("subscription", { nextChargeDate: "2024-02-29", cycle: "annual" })), "charge").dueDate).toBe("2027-02-28");
  });
  it("rolls quarterly and yearly cycles", () => {
    expect(one(run(mk("subscription", { nextChargeDate: "2026-06-15", cycle: "quarterly" })), "charge").dueDate).toBe("2026-12-15");
    expect(one(run(mk("subscription", { nextChargeDate: "2025-10-01", cycle: "yearly" })), "charge").dueDate).toBe("2027-10-01");
  });
  it("rolls weekly and keeps a charge that lands today", () => {
    expect(one(run(mk("subscription", { nextChargeDate: "2026-10-01", cycle: "weekly" })), "charge").dueDate).toBe("2026-10-22");
    expect(one(run(mk("subscription", { nextChargeDate: "2026-10-07", cycle: "weekly" })), "charge").dueDate).toBe("2026-10-21");
  });
  it("accepts cycle text in any case", () => {
    expect(one(run(mk("subscription", { nextChargeDate: "2026-08-03", cycle: " Monthly " })), "charge").dueDate).toBe("2026-11-03");
  });
  it("leaves a past charge alone when the cycle is unknown, and never alerts", () => {
    const o = one(run(mk("subscription", { nextChargeDate: "2026-08-03", cycle: "whenever" })), "charge");
    expect(o.dueDate).toBe("2026-08-03");
    expect(o.severity).toBeNull();
  });
  it("includes the cycle as a source for a rolled cancel_by", () => {
    const o = one(run(mk("subscription", { nextChargeDate: "2026-08-03", cycle: "monthly", cancelNoticeDays: 2 })), "cancel_by");
    expect(o.dueDate).toBe("2026-11-01");
    expect(o.sourceFields).toContain("cycle");
  });
});

describe("service plan", () => {
  it("is last service plus interval", () => {
    expect(one(run(mk("service_plan", { lastServiceDate: "2026-10-01", intervalDays: 30 })), "service_due").dueDate).toBe("2026-10-31");
  });
  it("falls back to an explicit next service date", () => {
    expect(one(run(mk("service_plan", { nextServiceDate: "2026-11-15" })), "service_due").dueDate).toBe("2026-11-15");
  });
  it("prefers last plus interval over a stale next date", () => {
    const o = one(run(mk("service_plan", { lastServiceDate: "2026-10-01", intervalDays: 30, nextServiceDate: "2026-01-01" })), "service_due");
    expect(o.dueDate).toBe("2026-10-31");
  });
  it("is high at 7 days and possible at 8", () => {
    expect(one(run(mk("service_plan", { nextServiceDate: "2026-10-28" })), "service_due").severity).toBe("high");
    expect(one(run(mk("service_plan", { nextServiceDate: "2026-10-29" })), "service_due").severity).toBe("possible");
  });
  it("makes nothing from an interval without a last service date", () => {
    expect(run(mk("service_plan", { intervalDays: 30 }))).toEqual([]);
  });
});

describe("confirmation gate (no alert from an unconfirmed date)", () => {
  const sub = { nextChargeDate: "2026-11-03", trialEndDate: "2026-10-28", cycle: "monthly", cancelNoticeDays: 2 };
  it("gives every obligation severity null when nothing is confirmed", () => {
    const obs = run({ kind: "subscription", fields: sub, fieldStatus: { nextChargeDate: "extracted", trialEndDate: "extracted", cycle: "extracted", cancelNoticeDays: "extracted" } });
    expect(obs.length).toBeGreaterThan(0);
    for (const o of obs) {
      expect(o.confirmed).toBe(false);
      expect(o.severity).toBeNull();
    }
  });
  it("treats a missing fieldStatus as unconfirmed", () => {
    for (const o of run({ kind: "subscription", fields: sub })) expect(o.severity).toBeNull();
  });
  it("counts an edited field as confirmed", () => {
    const o = one(run(mk("warranty", { endDate: "2026-11-04" }, { endDate: "edited" })), "expires");
    expect(o.confirmed).toBe(true);
    expect(o.severity).toBe("high");
  });
  it("confirms only what each date depends on", () => {
    const obs = run(mk("subscription", sub, { cancelNoticeDays: "extracted" }));
    expect(one(obs, "charge").confirmed).toBe(true);
    expect(one(obs, "cancel_by").confirmed).toBe(false);
    expect(one(obs, "cancel_by").severity).toBeNull();
  });
  it("needs every dependency confirmed, not just one", () => {
    const o = one(run(mk("lease", { endDate: "2026-12-31", noticeDaysToVacate: 60 }, { noticeDaysToVacate: "extracted" })), "notice_by");
    expect(o.confirmed).toBe(false);
  });
});

describe("input handling", () => {
  it("returns nothing for null or missing fields", () => {
    for (const kind of ["warranty", "insurance", "lease", "subscription", "service_plan"] as const) {
      expect(run(mk(kind, {}))).toEqual([]);
    }
    expect(run(mk("lease", { endDate: null, noticeDaysToVacate: null }))).toEqual([]);
  });
  it("sorts by due date, then type", () => {
    const obs = run(mk("subscription", { nextChargeDate: "2026-10-28", trialEndDate: "2026-10-28", cancelNoticeDays: 2 }));
    expect(obs.map((o) => `${o.dueDate} ${o.type}`)).toEqual(["2026-10-26 cancel_by", "2026-10-28 trial_end"]);
  });
  it("throws when today is not a date", () => {
    expect(() => computeObligations(mk("warranty", { endDate: "2026-11-04" }), "10/21/2026")).toThrow(RangeError);
  });
  it("does not mutate its input", () => {
    const a = mk("subscription", { nextChargeDate: "2026-08-03", cycle: "monthly" });
    const copy = JSON.parse(JSON.stringify(a));
    run(a);
    expect(a).toEqual(copy);
  });
  it("is deterministic for the same input", () => {
    const a = mk("lease", { endDate: "2026-12-31", noticeDaysToVacate: 60, rentDueDay: 1 });
    expect(run(a)).toEqual(run(a));
  });
  it("labels read naturally with no dashes", () => {
    const o = one(run(mk("lease", { endDate: "2026-12-31", noticeDaysToVacate: 60 })), "notice_by");
    expect(o.label).toBe("Lease give notice by");
    expect(o.label).not.toMatch(new RegExp("[\u2013\u2014]"));
  });
});

describe("trial that ends on its first charge day (one event, not two alerts)", () => {
  const trial = { nextChargeDate: "2026-10-28", trialEndDate: "2026-10-28", cycle: "monthly", cancelNoticeDays: 2 };
  it("makes no separate charge on the trial end day", () => {
    expect(run(mk("subscription", trial)).map((o) => o.type)).toEqual(["cancel_by", "trial_end"]);
  });
  it("keeps the charge when it falls on a different day than the trial end", () => {
    const obs = run(mk("subscription", { ...trial, nextChargeDate: "2026-10-30" }));
    expect(obs.map((o) => o.type)).toEqual(["cancel_by", "trial_end", "charge"]);
  });
  it("keeps the charge once the trial is over", () => {
    const obs = run(mk("subscription", { nextChargeDate: "2026-11-03", trialEndDate: "2026-10-01", cycle: "monthly" }));
    expect(obs.some((o) => o.type === "charge")).toBe(true);
  });
});

describe("billing cycle spellings from a model", () => {
  const next = (cycle: string, first = "2026-10-01") => one(run(mk("subscription", { nextChargeDate: first, cycle })), "charge").dueDate;
  it.each([
    ["biweekly", "2026-10-29"],
    ["bi-weekly", "2026-10-29"],
    ["fortnightly", "2026-10-29"],
    ["every two weeks", "2026-10-29"],
    ["Every  2 Weeks", "2026-10-29"],
    ["weekly", "2026-10-22"],
    ["per week", "2026-10-22"],
  ])("rolls %s forward by whole periods", (cycle, due) => {
    expect(next(cycle)).toBe(due);
  });
  it.each(["month", "per month", "Every Month", "MONTHLY"])("treats %s as monthly", (cycle) => {
    expect(next(cycle, "2026-08-03")).toBe("2026-11-03");
  });
  it.each(["annually", "year", "per year", "every year", "yearly"])("treats %s as yearly", (cycle) => {
    expect(next(cycle, "2025-10-01")).toBe("2027-10-01");
  });
  it("keeps a charge that lands exactly today", () => {
    expect(next("biweekly", "2026-10-07")).toBe("2026-10-21");
  });
  it("still leaves a really unknown cycle alone", () => {
    expect(next("whenever")).toBe("2026-10-01");
  });
});

describe("rent never alerts (D-020)", () => {
  const rent = { endDate: "2026-12-31", noticeDaysToVacate: 60, rentDueDay: 1 };
  it("stays on the timeline but has no severity, even confirmed and due in 3 days", () => {
    const o = one(run(mk("lease", rent), "2026-10-29"), "charge");
    expect(o.dueDate).toBe("2026-11-01");
    expect(o.confirmed).toBe(true);
    expect(o.severity).toBeNull();
  });
  it("does not stop the notice deadline from alerting", () => {
    expect(one(run(mk("lease", rent), "2026-10-29"), "notice_by").severity).toBe("high");
  });
  it("does not change subscription charges, which still alert", () => {
    expect(one(run(mk("subscription", { nextChargeDate: "2026-10-23", cycle: "monthly" })), "charge").severity).toBe("high");
  });
});

describe("severityFor", () => {
  it.each<[ObligationType, number, "high" | "possible" | null]>([
    ["notice_by", 14, "high"],
    ["notice_by", 15, "possible"],
    ["cancel_by", 14, "high"],
    ["cancel_by", 15, "possible"],
    ["expires", 14, "high"],
    ["expires", 15, "possible"],
    ["renews", 14, "high"],
    ["renews", 15, "possible"],
    ["charge", 7, "high"],
    ["charge", 8, "possible"],
    ["service_due", 7, "high"],
    ["service_due", 8, "possible"],
    ["trial_end", 7, "high"],
    ["trial_end", 8, "possible"],
    ["claim_by", 7, "high"],
    ["claim_by", 8, "possible"],
    ["expires", 0, "high"],
    ["expires", 30, "possible"],
    ["expires", 31, null],
    ["expires", -1, null],
  ])("%s at %i days is %s", (type, days, expected) => {
    expect(severityFor(type, days, true)).toBe(expected);
  });
  it("is null for any unconfirmed obligation", () => {
    expect(severityFor("notice_by", 1, false)).toBeNull();
  });
});
