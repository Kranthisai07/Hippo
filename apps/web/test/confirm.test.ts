import { describe, expect, it } from "vitest";
import { confirmPlan } from "../src/lib/confirm";
import type { FieldView } from "../src/lib/types";

const f = (name: string, isDate: boolean, status: FieldView["status"] = "extracted"): FieldView => ({
  name,
  value: "x",
  status,
  sourceRef: null,
  isDate,
});

const lease = [
  f("landlord", false),
  f("startDate", true),
  f("endDate", true),
  f("noticeDaysToVacate", true),
  f("rentAmount", false),
];

describe("confirmPlan", () => {
  it("is not ready until every unconfirmed date field has been shown", () => {
    const plan = confirmPlan(lease, new Set(["startDate", "endDate"]));
    expect(plan.ready).toBe(false);
  });

  it("is ready when all date fields were shown, and names only date fields", () => {
    const plan = confirmPlan(lease, new Set(["startDate", "endDate", "noticeDaysToVacate", "landlord", "rentAmount"]));
    expect(plan.ready).toBe(true);
    expect(plan.names).toEqual(["startDate", "endDate", "noticeDaysToVacate"]);
  });

  it("never names a field that was not shown, even when ready is false", () => {
    const plan = confirmPlan(lease, new Set(["endDate"]));
    expect(plan.names).toEqual(["endDate"]);
  });

  it("skips date fields that are already confirmed or edited", () => {
    const fields = [f("startDate", true, "confirmed"), f("endDate", true, "edited"), f("noticeDaysToVacate", true)];
    const plan = confirmPlan(fields, new Set(["noticeDaysToVacate"]));
    expect(plan.names).toEqual(["noticeDaysToVacate"]);
    expect(plan.ready).toBe(true);
  });

  it("has nothing to confirm when no date is waiting, and is not ready", () => {
    const plan = confirmPlan([f("startDate", true, "confirmed"), f("landlord", false)], new Set(["startDate"]));
    expect(plan.names).toEqual([]);
    expect(plan.ready).toBe(false);
    expect(plan.nothingLeft).toBe(true);
  });
});
