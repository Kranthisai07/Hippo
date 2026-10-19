import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BillingCycle,
  ExtractionSchemas,
  SourceRefSchema,
  computeObligations,
  leavesToAgreementFields,
  type AgreementKind,
} from "../src";

const DIR = fileURLToPath(new URL("../../../fixtures/expected/", import.meta.url));
const load = (stem: string) => JSON.parse(readFileSync(`${DIR}${stem}.json`, "utf8"));
const STEMS = [
  "warranty_dishwasher",
  "warranty_dishwasher_photo",
  "insurance_auto",
  "lease",
  "subscription_fernwood",
  "subscription_kestrel",
];
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe("every hand-written fixture extraction passes its schema", () => {
  it.each(STEMS)("%s", (stem) => {
    const doc = load(stem);
    const schema = ExtractionSchemas[doc.docType as AgreementKind];
    const parsed = schema.safeParse(doc.fields);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
  });
});

describe("schemas are strict", () => {
  const lease = () => clone(load("lease").fields);

  it("rejects a key the schema does not name, at the top and nested", () => {
    expect(ExtractionSchemas.lease.safeParse({ ...lease(), extra: 1 }).success).toBe(false);
    const nested = lease();
    nested.landlord.sourceRef.note = "x";
    expect(ExtractionSchemas.lease.safeParse(nested).success).toBe(false);
  });

  it("rejects a quote over 200 characters and accepts exactly 200", () => {
    const f = lease();
    f.landlord.sourceRef.quote = "a".repeat(201);
    expect(ExtractionSchemas.lease.safeParse(f).success).toBe(false);
    f.landlord.sourceRef.quote = "a".repeat(200);
    expect(ExtractionSchemas.lease.safeParse(f).success).toBe(true);
  });

  it("rejects an empty quote and a page that is not a positive whole number", () => {
    for (const bad of [{ page: 0, quote: "x" }, { page: 1.5, quote: "x" }, { page: -2, quote: "x" }, { page: 1, quote: "" }]) {
      expect(SourceRefSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("rejects a value with no sourceRef", () => {
    const f = lease();
    delete f.landlord.sourceRef;
    expect(ExtractionSchemas.lease.safeParse(f).success).toBe(false);
  });

  it("accepts null or missing fields: missing beats guessed", () => {
    expect(ExtractionSchemas.lease.safeParse({}).success).toBe(true);
    expect(ExtractionSchemas.lease.safeParse({ landlord: null, endDate: null }).success).toBe(true);
  });

  it("rejects an impossible calendar date and a date in the wrong format", () => {
    for (const bad of ["2026-02-30", "2026-13-01", "11/12/2025", "2026-1-5", "tomorrow"]) {
      const f = lease();
      f.endDate.value = bad;
      expect(ExtractionSchemas.lease.safeParse(f).success, bad).toBe(false);
    }
  });

  it("rejects a string value over 500 characters", () => {
    const f = lease();
    f.lateFeeRule.value = "x".repeat(501);
    expect(ExtractionSchemas.lease.safeParse(f).success).toBe(false);
  });

  it("rejects a day count that is negative, fractional or not a number", () => {
    for (const bad of [-1, 2.5, "60", Number.NaN]) {
      const f = lease();
      f.noticeDaysToVacate.value = bad;
      expect(ExtractionSchemas.lease.safeParse(f).success, String(bad)).toBe(false);
    }
  });

  it("rejects a rent due day outside 1 to 31", () => {
    for (const bad of [0, 32]) {
      const f = lease();
      f.rentDueDay.value = bad;
      expect(ExtractionSchemas.lease.safeParse(f).success, String(bad)).toBe(false);
    }
  });
});

describe("lease says whether the notice period counts business or calendar days (Q-007)", () => {
  const leaf = (value: unknown) => ({ value, sourceRef: { page: 4, quote: "at least sixty (60) business days" } });
  it("accepts calendar and business and nothing else", () => {
    expect(ExtractionSchemas.lease.safeParse({ noticeDaysType: leaf("business") }).success).toBe(true);
    expect(ExtractionSchemas.lease.safeParse({ noticeDaysType: leaf("calendar") }).success).toBe(true);
    expect(ExtractionSchemas.lease.safeParse({ noticeDaysType: leaf("working") }).success).toBe(false);
  });

  it("the engine reads the same field name", () => {
    const fields = { endDate: "2026-12-31", noticeDaysToVacate: 60, noticeDaysType: "business" };
    const status = { endDate: "confirmed", noticeDaysToVacate: "confirmed", noticeDaysType: "confirmed" } as const;
    const business = computeObligations({ kind: "lease", fields, fieldStatus: status }, "2026-10-01");
    const calendar = computeObligations(
      { kind: "lease", fields: { ...fields, noticeDaysType: "calendar" }, fieldStatus: status },
      "2026-10-01",
    );
    const dueB = business.find((o) => o.type === "notice_by")!.dueDate;
    const dueC = calendar.find((o) => o.type === "notice_by")!.dueDate;
    expect(dueB < dueC).toBe(true);
  });
});

describe("billing cycle is an enum", () => {
  it.each([
    ["monthly", "monthly"],
    ["Monthly", "monthly"],
    [" per month ", "monthly"],
    ["every month", "monthly"],
    ["quarterly", "quarterly"],
    ["six-month", "semiannual"],
    ["semi-annual", "semiannual"],
    ["yearly", "annual"],
    ["per year", "annual"],
    ["weekly", "weekly"],
    ["bi-weekly", "biweekly"],
    ["every two weeks", "biweekly"],
  ])("%s normalises to %s", (input, out) => {
    expect(BillingCycle.parse(input)).toBe(out);
  });

  it.each(["", "fortnightish", "sometimes", "12", 12, null, undefined, {}])("rejects %j", (bad) => {
    expect(BillingCycle.safeParse(bad).success).toBe(false);
  });

  it("every cycle value the schema can output is one the engine rolls forward", () => {
    const today = "2026-10-21";
    for (const cycle of ["weekly", "biweekly", "monthly", "quarterly", "semiannual", "annual"]) {
      const obs = computeObligations(
        { kind: "subscription", fields: { nextChargeDate: "2026-09-01", cycle }, fieldStatus: { nextChargeDate: "confirmed", cycle: "confirmed" } },
        today,
      );
      const charge = obs.find((o) => o.type === "charge");
      expect(charge, cycle).toBeDefined();
      expect(charge!.dueDate >= today, `${cycle} rolled to ${charge!.dueDate}`).toBe(true);
    }
  });
});

describe("other field rules", () => {
  it("policy number is exactly the last four characters, never more", () => {
    const f = clone(load("insurance_auto").fields);
    f.policyNumberLast4.value = "HM-AU-0048-4821";
    expect(ExtractionSchemas.insurance.safeParse(f).success).toBe(false);
    f.policyNumberLast4.value = "4821";
    expect(ExtractionSchemas.insurance.safeParse(f).success).toBe(true);
  });

  it("policy type and renewal are closed sets", () => {
    const f = clone(load("insurance_auto").fields);
    f.policyType.value = "boat";
    expect(ExtractionSchemas.insurance.safeParse(f).success).toBe(false);
    const g = clone(load("insurance_auto").fields);
    g.renewal.value = "sometimes";
    expect(ExtractionSchemas.insurance.safeParse(g).success).toBe(false);
  });

  it("a vehicle hint needs a whole year in a sane range", () => {
    for (const year of [1700, 2.5, 3000]) {
      const f = clone(load("insurance_auto").fields);
      f.coveredAssetHints[0].value.year = year;
      expect(ExtractionSchemas.insurance.safeParse(f).success, String(year)).toBe(false);
    }
  });

  it("the service plan schema takes an interval or a next date", () => {
    const ok = ExtractionSchemas.service_plan.safeParse({
      provider: { value: "Acme HVAC", sourceRef: { page: 1, quote: "Acme HVAC" } },
      intervalDays: { value: 180, sourceRef: { page: 1, quote: "every 180 days" } },
    });
    expect(ok.success).toBe(true);
  });
});

describe("leavesToAgreementFields flattens leaves for the engine and the review screen", () => {
  it("keeps values, records every cited page, and marks everything extracted", () => {
    const doc = load("warranty_dishwasher");
    const flat = leavesToAgreementFields("warranty", ExtractionSchemas.warranty.parse(doc.fields));
    expect(flat.fields.startDate).toBe("2025-11-12");
    expect(flat.fields.termMonths).toBe(12);
    expect(flat.sourceRefs.startDate).toEqual({
      page: 1,
      quote: "Date of purchase: November 12, 2025",
    });
    expect(Array.isArray(flat.fields.exclusions)).toBe(true);
    expect(Array.isArray(flat.sourceRefs.exclusions)).toBe(true);
    expect((flat.sourceRefs.exclusions as { page: number }[])[0]!.page).toBe(3);
    for (const status of Object.values(flat.fieldStatus)) expect(status).toBe("extracted");
    expect(Object.keys(flat.fieldStatus).sort()).toEqual(Object.keys(flat.fields).sort());
  });

  it("drops null fields instead of carrying them", () => {
    const flat = leavesToAgreementFields("warranty", ExtractionSchemas.warranty.parse({ provider: null, endDate: null }));
    expect(flat.fields).toEqual({});
    expect(flat.sourceRefs).toEqual({});
  });

  it("reproduces the expected obligations through the engine, for every fixture", () => {
    const spec = load("obligations") as {
      anchorDate: string;
      obligations: { from: string; type: string; dueDate: string; daysFromAnchor: number }[];
    };
    for (const exp of spec.obligations) {
      const doc = load(exp.from);
      const flat = leavesToAgreementFields(doc.docType, ExtractionSchemas[doc.docType as AgreementKind].parse(doc.fields));
      const confirmed = Object.fromEntries(Object.keys(flat.fields).map((k) => [k, "confirmed" as const]));
      const got = computeObligations({ kind: doc.docType, fields: flat.fields, fieldStatus: confirmed }, spec.anchorDate);
      const hit = got.find((o) => o.type === exp.type && o.dueDate === exp.dueDate);
      expect(hit, `${exp.from} ${exp.type}`).toBeDefined();
      expect(hit!.daysUntil).toBe(exp.daysFromAnchor);
    }
  });

  it("with fieldStatus left as extracted the engine never alerts", () => {
    const doc = load("lease");
    const flat = leavesToAgreementFields("lease", ExtractionSchemas.lease.parse(doc.fields));
    const got = computeObligations({ kind: "lease", fields: flat.fields, fieldStatus: flat.fieldStatus }, "2026-10-21");
    expect(got.length).toBeGreaterThan(0);
    for (const o of got) expect(o.severity).toBeNull();
  });
});
