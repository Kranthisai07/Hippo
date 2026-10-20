import { describe, expect, it } from "vitest";
import { injectProactive } from "../src/mcp/proactive";
import { TOOLS } from "../src/mcp/registry";
import { fail, ok } from "../src/mcp/result";
import { countWords } from "../src/mcp/speak";
import { A, B, makeContext, seeded, text } from "./helpers";

const answer = () => ok("Here is the answer.", { kind: "history" });
const INSURANCE = "alert-agr-insurance_auto:renews:2026-10-30";
const LEASE = "alert-agr-lease:notice_by:2026-11-01";

describe("proactive injection", () => {
  it("puts one sentence about the car insurance in front of the first answer", async () => {
    const { ctx } = await seeded();
    const r = await injectProactive(ctx, answer());
    expect(text(r)).toBe("Before that, your car insurance renews in 9 days. Here is the answer.");
    expect(r.structuredContent).toMatchObject({
      kind: "history",
      proactive: { alertId: INSURANCE, sentence: "Before that, your car insurance renews in 9 days." },
    });
  });

  it("marks that alert announced, with the time", async () => {
    const { ctx, repo } = await seeded();
    await injectProactive(ctx, answer());
    const alert = (await repo.getAlert(A, INSURANCE))!;
    expect(alert.status).toBe("announced");
    expect(alert.announcedAt).toBe("2026-10-21T12:00:00.000Z");
  });

  it("does not say it again, and says nothing more that day", async () => {
    const { ctx, repo } = await seeded();
    await injectProactive(ctx, answer());
    for (let i = 0; i < 3; i++) {
      const r = await injectProactive(ctx, answer());
      expect(text(r)).toBe("Here is the answer.");
      expect(r.structuredContent?.proactive).toBeUndefined();
    }
    const announced = (await repo.listAlerts(A)).filter((a) => a.status === "announced");
    expect(announced).toHaveLength(1);
  });

  it("is one sentence of at most 15 words", async () => {
    const { ctx } = await seeded();
    const r = await injectProactive(ctx, answer());
    const sentence = (r.structuredContent!.proactive as { sentence: string }).sentence;
    expect(sentence.match(/[.!?]/g)).toHaveLength(1);
    expect(countWords(sentence)).toBeLessThanOrEqual(15);
  });

  it("speaks the next alert on the next day", async () => {
    const { ctx, repo, indexSource } = await seeded();
    await injectProactive(ctx, answer());
    const next = makeContext({ repo, indexSource }, { today: "2026-10-22", nowMs: ctx.nowMs + 24 * 3600 * 1000 });
    const r = await injectProactive(next, answer());
    expect(text(r)).toBe("Before that, your lease notice deadline is in 10 days. Here is the answer.");
    expect((await repo.getAlert(A, LEASE))!.status).toBe("announced");
  });

  it("puts renewals, expiries and notice dates ahead of a nearer cancel-by date", async () => {
    const { ctx } = await seeded();
    const r = await injectProactive(ctx, answer());
    expect(text(r)).not.toContain("Kestrel");
  });

  it("speaks a recall when only recalls are left", async () => {
    const { ctx, repo } = await seeded();
    for (const a of await repo.listAlerts(A, { open: true }))
      if (a.source === "deadline") await repo.putAlert(A, { ...a, status: "dismissed" });
    const r = await injectProactive(ctx, answer());
    expect(text(r)).toMatch(/^Before that, a recall may affect your (car|boon NURSH baby bottles)\./);
  });

  it("does not speak snoozed, done or dismissed alerts", async () => {
    const { ctx, repo } = await seeded();
    for (const a of await repo.listAlerts(A, { open: true })) {
      if (a.id === INSURANCE) await repo.putAlert(A, { ...a, snoozedUntil: "2026-10-28T00:00:00.000Z" });
      else if (a.id === LEASE) await repo.putAlert(A, { ...a, status: "done" });
      else if (a.severity === "high") await repo.putAlert(A, { ...a, status: "dismissed" });
    }
    const r = await injectProactive(ctx, answer());
    expect(text(r)).toBe("Here is the answer.");
  });

  it("does not speak a deadline that has already passed", async () => {
    const { ctx, repo, indexSource } = await seeded();
    for (const a of await repo.listAlerts(A, { open: true }))
      if (a.source === "recall") await repo.putAlert(A, { ...a, status: "dismissed" });
    const late = makeContext({ repo, indexSource }, { today: "2026-12-01", nowMs: ctx.nowMs + 40 * 86400 * 1000 });
    const r = await injectProactive(late, answer());
    expect(text(r)).toBe("Here is the answer.");
  });

  it("does not speak possible alerts", async () => {
    const { ctx, repo } = await seeded();
    for (const a of await repo.listAlerts(A, { open: true }))
      if (a.severity === "high") await repo.putAlert(A, { ...a, status: "dismissed" });
    const r = await injectProactive(ctx, answer());
    expect(text(r)).toBe("Here is the answer.");
  });

  it("stays out of errors and of a question back to the person", async () => {
    const { ctx, repo } = await seeded();
    const e = await injectProactive(ctx, fail("Something went wrong."));
    expect(text(e)).toBe("Something went wrong.");
    const q = await injectProactive(
      ctx,
      ok("Which one do you mean?", { kind: "ambiguous", what: "asset", question: "Which?", options: [] }),
    );
    expect(text(q)).toBe("Which one do you mean?");
    expect((await repo.listAlerts(A)).filter((a) => a.status === "announced")).toEqual([]);
  });

  it("does not repeat what the answer already says", async () => {
    const { ctx } = await seeded();
    const r = await injectProactive(ctx, answer(), { skip: new Set([INSURANCE]) });
    expect(text(r)).toBe("Before that, your lease notice deadline is in 11 days. Here is the answer.");
  });

  it("only looks at the household in the context", async () => {
    const { ctx, repo, indexSource } = await seeded();
    const other = makeContext({ repo, indexSource }, { householdId: B });
    expect(text(await injectProactive(other, answer()))).toBe("Here is the answer.");
    expect((await repo.getAlert(A, INSURANCE))!.status).toBe("pending");
    expect(ctx.householdId).toBe(A);
  });

  it("is on for the model facing tools and off for resolve_alert, undo_last and the card tools", () => {
    const flags = Object.fromEntries(TOOLS.map((t) => [t.name, t.proactive]));
    expect(flags).toEqual({
      whats_coming_up: true,
      check_coverage: true,
      ask_documents: true,
      get_agreement: true,
      add_record: true,
      log_service: true,
      get_history: true,
      resolve_alert: false,
      undo_last: false,
      ui_resolve_alert: false,
      ui_show_clause: false,
      ui_show_claim_steps: false,
    });
  });
});
