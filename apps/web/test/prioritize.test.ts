import { describe, expect, it } from "vitest";
import { prioritize } from "../src/lib/prioritize";
import type { ObligationItem, ObligationType, Subscription } from "../src/lib/types";

const TODAY = "2026-11-02";
const sub = (vendor: string, over: Partial<Subscription> = {}): Subscription => ({
  agreementId: `agr-${vendor}`,
  docId: `doc-${vendor}`,
  vendor,
  plan: null,
  amount: null,
  cycle: null,
  nextChargeDate: null,
  confirmed: false,
  source: null,
  ...over,
});
const ob = (vendor: string, type: ObligationType, dueDate: string): ObligationItem => ({
  obligation: { id: `${vendor}-${type}`, type, dueDate, label: type, confirmed: false, severity: null },
  needsConfirmation: true,
  docId: `doc-${vendor}`,
});
const names = (rows: { sub: Subscription }[]) => rows.map((r) => r.sub.vendor);

describe("prioritize", () => {
  it("groups by days away: soon (14), within a month (31), later, and no date", () => {
    const g = prioritize(
      [sub("A"), sub("B"), sub("C"), sub("D"), sub("E")],
      [
        ob("A", "charge", "2026-11-16"),
        ob("B", "charge", "2026-11-17"),
        ob("C", "charge", "2026-12-03"),
        ob("D", "charge", "2026-12-04"),
      ],
      TODAY,
    );
    expect(names(g.soon)).toEqual(["A"]);
    expect(names(g.month)).toEqual(["B", "C"]);
    expect(names(g.later)).toEqual(["D"]);
    expect(names(g.none)).toEqual(["E"]);
  });

  it("puts a cancel by or trial end ahead of a nearer charge", () => {
    const g = prioritize(
      [sub("Charge"), sub("Trial"), sub("Cancel")],
      [
        ob("Charge", "charge", "2026-11-03"),
        ob("Trial", "trial_end", "2026-11-08"),
        ob("Cancel", "cancel_by", "2026-11-05"),
      ],
      TODAY,
    );
    expect(names(g.soon)).toEqual(["Cancel", "Trial", "Charge"]);
  });

  it("uses the soonest upcoming date of a subscription and ignores dates that have passed", () => {
    const g = prioritize(
      [sub("A")],
      [ob("A", "charge", "2026-10-01"), ob("A", "renews", "2026-12-20"), ob("A", "charge", "2026-11-30")],
      TODAY,
    );
    expect(g.month[0]?.key).toMatchObject({ type: "charge", date: "2026-11-30", days: 28 });
  });

  it("falls back to the next charge date the subscription carries when it has no obligation", () => {
    const g = prioritize([sub("A", { nextChargeDate: "2026-11-10" })], [], TODAY);
    expect(g.soon[0]?.key).toMatchObject({ type: "charge", days: 8 });
  });

  it("puts a subscription whose only dates have passed under no date found, and ignores other kinds of date", () => {
    const g = prioritize(
      [sub("A"), sub("B")],
      [ob("A", "charge", "2026-09-01"), ob("B", "service_due", "2026-11-03")],
      TODAY,
    );
    expect(names(g.none)).toEqual(["A", "B"]);
  });

  it("keeps every subscription exactly once, and breaks ties by vendor name", () => {
    const subs = ["Zed", "alpha", "Mid"].map((v) => sub(v));
    const g = prioritize(
      subs,
      subs.map((s) => ob(s.vendor, "charge", "2026-11-05")),
      TODAY,
    );
    expect(names(g.soon)).toEqual(["alpha", "Mid", "Zed"]);
    expect(Object.values(g).flat()).toHaveLength(3);
  });

  it("does not take a date from another subscription's document", () => {
    const g = prioritize([sub("A", { docId: null })], [ob("B", "charge", "2026-11-03")], TODAY);
    expect(names(g.none)).toEqual(["A"]);
  });
});
