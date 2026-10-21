import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResultView } from "../cards";
import { Console } from "../Console";
import type { ToolInfo, ToolReply } from "../types";
import { fakeCall, fx, toolsFixture } from "./fx";

afterEach(cleanup);

const cov = () => fx("check-coverage");
const withS = (patch: Record<string, unknown>): ToolReply => ({
  ...cov().reply,
  structured: { ...cov().reply.structured!, ...patch },
});
const view = (reply: ToolReply, call = fakeCall().call) =>
  render(<ResultView tool="check_coverage" args={{}} reply={reply} call={call} rerun={vi.fn()} />);

describe("reviewer fixes", () => {
  it("shows Unclear and no verdict when there is no clause to cite", () => {
    view(withS({ badge: "covered", topClause: null, exclusionClause: null }));
    const text = screen.getByTestId("badge").textContent ?? "";
    expect(text).toMatch(/unclear/i);
    expect(text).not.toMatch(/covered/i);
  });

  it("says page not recorded when a page is null", () => {
    view(withS({ claimSteps: [{ text: "Call us", page: null }] }));
    expect(screen.getByText(/page not recorded/i)).toBeTruthy();
  });

  it("disables every resolve button once one action succeeded", async () => {
    const { call } = fakeCall({ ui_resolve_alert: fx("resolve-alert").reply });
    const f = fx("whats-coming-up");
    render(<ResultView tool={f.tool} args={f.args} reply={f.reply} call={call} rerun={vi.fn()} />);
    const card = screen.getAllByTestId("recall-card")[0]!;
    await userEvent.click(within(card).getByRole("button", { name: /mark done/i }));
    await waitFor(() =>
      expect((within(card).getByRole("button", { name: /not mine/i }) as HTMLButtonElement).disabled).toBe(true),
    );
    expect((within(card).getByRole("button", { name: /mark done/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each([
    ["coming_up", { kind: "coming_up", items: "x", recalls: null }],
    [
      "coverage",
      { kind: "coverage", badge: "covered", asset: { name: "A" }, claimSteps: "x", missingProof: 5, topClause: 7 },
    ],
    ["clauses", { kind: "clauses", found: true, clauses: "x" }],
    ["agreement", { kind: "agreement", agreement: {}, terms: {} }],
    ["history", { kind: "history", asset: {}, events: 3 }],
    ["record_added", { kind: "record_added", obligations: null }],
    ["ambiguous", { kind: "ambiguous", question: "?", options: null }],
    ["claim_steps", { kind: "claim_steps", steps: null, contact: null }],
    ["clause_view", { kind: "clause_view", clauses: null }],
    ["agreement without object", { kind: "agreement" }],
  ])("malformed %s shows a card and does not crash", (_n, structured) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    view({ text: "spoken", isError: false, structured: structured as any });
    expect(screen.getByTestId("result-card")).toBeTruthy();
  });
});

describe("double fire", () => {
  it("disables the phrase buttons while a call is running", async () => {
    const tools: ToolInfo[] = toolsFixture.map((t) => ({
      name: t.name,
      description: t.description,
      appOnly: t._meta?.ui?.visibility?.includes("app") ?? false,
    }));
    let release: (() => void) | undefined;
    const calls: string[] = [];
    const call = (name: string) =>
      new Promise<ToolReply>((res) => {
        calls.push(name);
        release = () =>
          res({ text: "ok", structured: { kind: "undone", undone: false, summary: null }, isError: false });
      });
    render(<Console call={call} tools={tools} />);
    const btn = screen.getByRole("button", { name: /undo that/i }) as HTMLButtonElement;
    await userEvent.click(btn);
    expect(btn.disabled).toBe(true);
    await userEvent.click(btn);
    expect(calls).toHaveLength(1);
    release!();
    await waitFor(() => expect(btn.disabled).toBe(false));
  });
});
