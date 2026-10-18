import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeObligations, type AgreementInput, type AgreementKind } from "../src";

// The hand-written expectations from T0.3 (fixtures/expected). The engine must reproduce them.
const DIR = fileURLToPath(new URL("../../../fixtures/expected/", import.meta.url));
const load = (stem: string) => JSON.parse(readFileSync(`${DIR}${stem}.json`, "utf8"));
const unwrap = (v: unknown): unknown =>
  v && typeof v === "object" && !Array.isArray(v) && "sourceRef" in v ? (v as Record<string, unknown>).value : v;

function toInput(stem: string, confirmed = true): AgreementInput {
  const doc = load(stem);
  const fields: Record<string, unknown> = {};
  const fieldStatus: Record<string, "confirmed" | "extracted"> = {};
  for (const [k, v] of Object.entries(doc.fields)) {
    fields[k] = unwrap(v);
    fieldStatus[k] = confirmed ? "confirmed" : "extracted";
  }
  return { kind: doc.docType as AgreementKind, fields, fieldStatus };
}

const spec = load("obligations") as {
  anchorDate: string;
  obligations: { from: string; type: string; dueDate: string; daysFromAnchor: number }[];
  severity: { high: string[]; possible: string[] };
};
const tagged = (list: string[], from: string, type: string) => list.some((s) => s.startsWith(`${from} ${type} (`));

describe("fixtures reproduce the expected obligations at the anchor date", () => {
  it.each(spec.obligations.map((o) => [`${o.from} ${o.type}`, o] as const))("%s", (_name, exp) => {
    const got = computeObligations(toInput(exp.from), spec.anchorDate).find((o) => o.type === exp.type && o.dueDate === exp.dueDate);
    expect(got, `engine produced no ${exp.type} on ${exp.dueDate}`).toBeDefined();
    expect(got!.daysUntil).toBe(exp.daysFromAnchor);
    const want = tagged(spec.severity.high, exp.from, exp.type) ? "high" : tagged(spec.severity.possible, exp.from, exp.type) ? "possible" : null;
    expect(got!.severity).toBe(want);
  });

  it("never alerts when the same documents are unconfirmed", () => {
    for (const stem of ["warranty_dishwasher", "insurance_auto", "lease", "subscription_fernwood", "subscription_kestrel"]) {
      const obs = computeObligations(toInput(stem, false), spec.anchorDate);
      expect(obs.length).toBeGreaterThan(0);
      for (const o of obs) expect(o.severity, `${stem} ${o.type}`).toBeNull();
    }
  });

  it("invents no dates from the photo page, which states none", () => {
    expect(computeObligations(toInput("warranty_dishwasher_photo"), spec.anchorDate)).toEqual([]);
  });
});
