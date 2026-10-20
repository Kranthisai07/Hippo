import { MODEL_TOOL_NAMES } from "core/src/contracts";
import { describe, expect, it } from "vitest";
import { TOOLS } from "../src/mcp/registry";

const model = TOOLS.filter((t) => !t.app);
const needsThing = new Set(["check_coverage", "ask_documents", "get_agreement", "log_service", "get_history"]);

describe("tool descriptions are prompts", () => {
  it("covers the nine model tools and the three app tools", () => {
    expect(model.map((t) => t.name).sort()).toEqual([...MODEL_TOOL_NAMES].sort());
    expect(TOOLS.filter((t) => t.app)).toHaveLength(3);
  });

  it.each(model.map((t) => [t.name, t.description]))("%s is under about 600 characters", (_n, d) => {
    expect((d as string).length).toBeLessThanOrEqual(640);
  });

  it.each(model.map((t) => [t.name, t.description]))("%s gives two or three example utterances", (_n, d) => {
    const examples = (d as string).match(/"[^"]{6,}"/g) ?? [];
    expect(examples.length).toBeGreaterThanOrEqual(2);
    expect(examples.length).toBeLessThanOrEqual(3);
  });

  it.each(model.map((t) => [t.name, t.description]))("%s says when not to use it and names a sibling tool", (_n, d) => {
    expect(d as string).toMatch(/Do not use/);
    const sibling = (d as string).match(/\(use ([a-z_]+)\)/g) ?? [];
    expect(sibling.length).toBeGreaterThan(0);
    for (const s of sibling) expect(TOOLS.map((t) => t.name)).toContain(s.slice(5, -1));
  });

  it.each([...needsThing])("%s tells the model to pass only the thing, not the sentence", (name) => {
    expect(TOOLS.find((t) => t.name === name)!.description).toMatch(/Pass only/);
  });

  it("no description has markdown, urls or dashes", () => {
    for (const t of TOOLS) expect(t.description, t.name).not.toMatch(/[*`#]|https?:|—|–/);
  });

  it("app tool descriptions say the card calls them", () => {
    for (const t of TOOLS.filter((x) => x.app)) expect(t.description).toMatch(/Called by the card/);
  });
});
