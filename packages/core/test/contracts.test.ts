import { describe, expect, it } from "vitest";
import {
  APP_TOOLS,
  APP_TOOL_NAMES,
  MODEL_TOOLS,
  MODEL_TOOL_NAMES,
  ToolResultSchema,
  buildDigest,
  linkAssetHint,
  resolveAgreement,
  resolveAsset,
  type Agreement,
  type AgreementKind,
  type Alert,
  type Asset,
  type Repository,
} from "../src";

// Valid arguments for every tool: one call a person could really make out loud.
const GOOD: Record<string, unknown> = {
  whats_coming_up: { window_days: 14 },
  check_coverage: { asset: "dishwasher", issue: "leaking" },
  ask_documents: { question: "what happens if I break the lease early", about: "lease" },
  get_agreement: { about: "car insurance" },
  add_record: { kind: "subscription", vendor: "Gym", amount: 40, cycle: "monthly", day_of_month: 5 },
  log_service: { asset: "furnace", action: "annual service", date: "2026-10-18" },
  get_history: { asset: "furnace" },
  resolve_alert: { alert_id: "al-1", action: "dismiss" },
  undo_last: {},
  ui_resolve_alert: { alert_id: "al-1", action: "done" },
  ui_show_clause: { doc_id: "doc-1", page: 3 },
  ui_show_claim_steps: { agreement_id: "ag-1" },
};
const ALL = { ...MODEL_TOOLS, ...APP_TOOLS } as Record<string, { safeParse(v: unknown): { success: boolean } }>;

describe("the nine model-facing tools and three app-only tools", () => {
  it("are exactly the SPEC section 6 list", () => {
    expect([...MODEL_TOOL_NAMES].sort()).toEqual(
      [
        "add_record",
        "ask_documents",
        "check_coverage",
        "get_agreement",
        "get_history",
        "log_service",
        "resolve_alert",
        "undo_last",
        "whats_coming_up",
      ].sort(),
    );
    expect([...APP_TOOL_NAMES].sort()).toEqual(["ui_resolve_alert", "ui_show_claim_steps", "ui_show_clause"]);
  });

  it.each(Object.keys(GOOD))("%s accepts a normal call", (name) => {
    expect(ALL[name]!.safeParse(GOOD[name]).success).toBe(true);
  });

  // The rule that matters most: scope comes from the auth token, so there is nowhere to pass a household in.
  it.each(Object.keys(GOOD))("%s rejects householdId, however it is spelled", (name) => {
    for (const key of ["householdId", "household_id", "HH"]) {
      const args = { ...(GOOD[name] as object), [key]: "HH#other" };
      expect(ALL[name]!.safeParse(args).success, `${name} + ${key}`).toBe(false);
    }
  });

  it.each(Object.keys(GOOD))("%s rejects any unknown key", (name) => {
    expect(ALL[name]!.safeParse({ ...(GOOD[name] as object), extra: 1 }).success).toBe(false);
  });

  it.each(["not an object", 5, null, undefined, []])("undo_last rejects %j", (bad) => {
    expect(MODEL_TOOLS.undo_last.safeParse(bad).success).toBe(false);
  });
});

describe("argument limits", () => {
  it("window_days defaults to 30 and stays between 1 and 365", () => {
    expect(MODEL_TOOLS.whats_coming_up.parse({})).toEqual({ window_days: 30 });
    for (const bad of [0, -1, 366, 1.5, "30"]) {
      expect(MODEL_TOOLS.whats_coming_up.safeParse({ window_days: bad }).success, String(bad)).toBe(false);
    }
  });

  it("the asset phrase is trimmed, not empty and not a paragraph", () => {
    expect(MODEL_TOOLS.get_history.parse({ asset: "  dishwasher  " })).toEqual({ asset: "dishwasher" });
    expect(MODEL_TOOLS.get_history.safeParse({ asset: "   " }).success).toBe(false);
    expect(MODEL_TOOLS.get_history.safeParse({ asset: "x".repeat(81) }).success).toBe(false);
  });

  it("the issue and question have caps", () => {
    expect(MODEL_TOOLS.check_coverage.safeParse({ asset: "a", issue: "x".repeat(201) }).success).toBe(false);
    expect(MODEL_TOOLS.ask_documents.safeParse({ question: "x".repeat(301) }).success).toBe(false);
  });

  it("resolve_alert only knows the four actions", () => {
    for (const action of ["done", "dismiss", "not_mine", "snooze_7d"]) {
      expect(MODEL_TOOLS.resolve_alert.safeParse({ alert_id: "a", action }).success, action).toBe(true);
    }
    expect(MODEL_TOOLS.resolve_alert.safeParse({ alert_id: "a", action: "delete" }).success).toBe(false);
  });

  it("log_service takes a real date or none", () => {
    expect(MODEL_TOOLS.log_service.safeParse({ asset: "a", action: "b", date: "2026-02-30" }).success).toBe(false);
    expect(MODEL_TOOLS.log_service.safeParse({ asset: "a", action: "b" }).success).toBe(true);
  });
});

describe("add_record is a union of an asset and a subscription", () => {
  it("accepts an asset with only a name", () => {
    expect(MODEL_TOOLS.add_record.safeParse({ kind: "asset", name: "Fridge" }).success).toBe(true);
  });

  it("normalises the cycle a voice assistant might say", () => {
    const r = MODEL_TOOLS.add_record.parse({ kind: "subscription", vendor: "Gym", amount: 40, cycle: "per month" });
    expect(r).toMatchObject({ cycle: "monthly" });
  });

  it("refuses a subscription with an unknown cycle, a negative amount or a bad day", () => {
    const base = { kind: "subscription", vendor: "Gym", amount: 40, cycle: "monthly" };
    expect(MODEL_TOOLS.add_record.safeParse({ ...base, cycle: "sometimes" }).success).toBe(false);
    expect(MODEL_TOOLS.add_record.safeParse({ ...base, amount: -1 }).success).toBe(false);
    expect(MODEL_TOOLS.add_record.safeParse({ ...base, day_of_month: 32 }).success).toBe(false);
  });

  it("refuses an asset field on a subscription and the other way round", () => {
    expect(
      MODEL_TOOLS.add_record.safeParse({ kind: "subscription", vendor: "G", amount: 1, cycle: "monthly", brand: "x" })
        .success,
    ).toBe(false);
    expect(MODEL_TOOLS.add_record.safeParse({ kind: "asset", name: "A", vendor: "x" }).success).toBe(false);
    expect(MODEL_TOOLS.add_record.safeParse({ kind: "pet", name: "A" }).success).toBe(false);
  });
});

describe("ToolResultSchema is the response contract shape", () => {
  it("needs at least one text block and allows structuredContent and isError", () => {
    expect(ToolResultSchema.safeParse({ content: [{ type: "text", text: "Done." }] }).success).toBe(true);
    expect(
      ToolResultSchema.safeParse({
        content: [{ type: "text", text: "Nothing found." }],
        structuredContent: { ids: ["a"] },
        isError: true,
      }).success,
    ).toBe(true);
    expect(ToolResultSchema.safeParse({ content: [] }).success).toBe(false);
    expect(ToolResultSchema.safeParse({ content: [{ type: "image", data: "x" }] }).success).toBe(false);
  });
});

describe("entities fit the modules already built", () => {
  const asset: Asset = {
    id: "A-1",
    name: "Dishwasher",
    aliases: ["dish washer"],
    category: "appliance",
    brand: "Northwind",
    modelNumber: "NW-DW500",
    serialLast4: "7731",
    createdAt: "2026-10-18T00:00:00Z",
  };
  const agreement: Agreement = {
    id: "AG-1",
    kind: "warranty" satisfies AgreementKind,
    party: "Northwind",
    assetIds: ["A-1"],
    docId: "D-1",
    fields: { startDate: "2025-11-12" },
    fieldStatus: { startDate: "extracted" },
    sourceRefs: { startDate: { page: 1, quote: "Date of purchase: November 12, 2025" } },
    createdAt: "2026-10-18T00:00:00Z",
  };

  it("an Asset goes straight into the resolver and the linker", () => {
    expect(resolveAsset("dishwasher", [asset]).status).toBe("match");
    expect(linkAssetHint({ brand: "Northwind", model: "NW-DW500" }, [asset]).status).toBe("match");
  });

  it("an Agreement goes straight into the agreement resolver", () => {
    expect(resolveAgreement("dishwasher warranty", [agreement], [asset]).status).toBe("match");
  });

  it("an Alert goes straight into the digest builder", () => {
    const alert: Alert = {
      id: "al-1",
      refId: "ob-1",
      source: "deadline",
      severity: "high",
      status: "pending",
      label: "Car insurance renews",
      dueDate: "2026-10-30",
    };
    const digest = buildDigest({ alerts: [alert], appUrl: "https://app.hippo.example/", today: "2026-10-21" });
    expect(digest?.alertIds).toEqual(["al-1"]);
  });

  it("every Repository method takes the household first (compile time)", () => {
    type First<F> = F extends (first: infer A, ...rest: never[]) => unknown ? A : never;
    const ok: { [K in keyof Repository]: First<Repository[K]> extends string ? true : false } = {} as never;
    // If a method took something other than a string first, the mapped type above would hold `false` and this line fails to compile.
    const allTrue: Record<keyof Repository, true> = ok;
    expect(allTrue).toBeDefined();
  });
});
