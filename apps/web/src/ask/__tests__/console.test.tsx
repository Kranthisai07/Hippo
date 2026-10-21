import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { Console } from "../Console";
import type { ToolInfo } from "../types";
import { fakeCall, fx, toolsFixture } from "./fx";

afterEach(cleanup);

const tools: ToolInfo[] = toolsFixture.map((t) => ({
  name: t.name,
  description: t.description,
  appOnly: t._meta?.ui?.visibility?.includes("app") ?? false,
}));

function setup(map: Parameters<typeof fakeCall>[0] = {}) {
  const f = fakeCall(map);
  render(<Console call={f.call} tools={tools} />);
  return f;
}

describe("presenter console", () => {
  it("says it plays the model and that the server never calls an LLM", () => {
    setup();
    expect(screen.getByText(/plays the part of the voice assistant's model/i)).toBeTruthy();
    expect(screen.getByText(/server never calls an LLM/i)).toBeTruthy();
  });

  it.each([
    ["My dishwasher is leaking, am I covered?", "check_coverage", { asset: "dishwasher", issue: "leaking" }],
    ["What is coming up?", "whats_coming_up", {}],
    [
      "What does my lease say about breaking it early?",
      "ask_documents",
      { question: "What does my lease say about breaking it early?", about: "lease" },
    ],
    ["When does my car insurance renew?", "get_agreement", { about: "car insurance" }],
    ["I just had the car serviced", "log_service", { asset: "car", action: "service" }],
    ["Undo that", "undo_last", {}],
  ])("%s calls %s with only the thing", async (phrase, tool, args) => {
    const f = setup();
    await userEvent.click(screen.getByRole("button", { name: new RegExp(phrase.replace(/[?]/g, "\\?"), "i") }));
    await waitFor(() => expect(f.calls).toHaveLength(1));
    expect(f.calls[0]).toEqual({ name: tool, args });
  });

  it("shows the spoken text first with the proactive sentence highlighted, then the card", async () => {
    const cov = fx("check-coverage").reply;
    setup({ check_coverage: cov });
    await userEvent.click(screen.getByRole("button", { name: /dishwasher is leaking/i }));
    const bubble = await screen.findByTestId("speech");
    const mark = bubble.querySelector("[data-proactive]");
    expect(mark?.textContent).toBe("Before that, your car insurance renews in 9 days.");
    expect(bubble.textContent).toContain("page 3 excludes damage caused by improper installation");
    expect(await screen.findByTestId("badge")).toBeTruthy();
  });

  it("an ambiguous answer's option calls the same tool again with the label", async () => {
    const f = setup({ get_agreement: fx("get-agreement-ambiguous").reply });
    await userEvent.click(screen.getByRole("button", { name: /car insurance renew/i }));
    await userEvent.click(await screen.findByRole("button", { name: "Kestrel Learning subscription" }));
    await waitFor(() => expect(f.calls).toHaveLength(2));
    expect(f.calls[1]).toEqual({ name: "get_agreement", args: { about: "Kestrel Learning subscription" } });
  });

  it("advanced box calls a chosen model tool with edited JSON and refuses bad JSON", async () => {
    const f = setup();
    const area = screen.getByLabelText(/arguments/i);
    await userEvent.selectOptions(screen.getByLabelText(/^tool/i), "get_history");
    await userEvent.clear(area);
    await userEvent.click(area);
    await userEvent.paste('{"asset":"car"}');
    await userEvent.click(screen.getByRole("button", { name: /call tool/i }));
    await waitFor(() => expect(f.calls).toHaveLength(1));
    expect(f.calls[0]).toEqual({ name: "get_history", args: { asset: "car" } });
    await userEvent.clear(area);
    await userEvent.click(area);
    await userEvent.paste("{nope");
    await userEvent.click(screen.getByRole("button", { name: /call tool/i }));
    expect(await screen.findByText(/not valid JSON/i)).toBeTruthy();
    expect(f.calls).toHaveLength(1);
  });

  it("offers only the 9 model tools in the advanced box and lists the 3 card tools as hidden", () => {
    setup();
    const select = screen.getByLabelText(/^tool/i) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toHaveLength(9);
    expect(screen.getByText(/the model sees 9 tools/i)).toBeTruthy();
    expect(screen.getByText(/ui_show_clause/)).toBeTruthy();
  });

  it("shows a calm error when the call fails", async () => {
    const call = async () => {
      throw new Error("boom");
    };
    render(<Console call={call} tools={tools} />);
    await userEvent.click(screen.getByRole("button", { name: /what is coming up/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not complete/i);
  });
});
