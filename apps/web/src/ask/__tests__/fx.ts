// Loads a REAL captured tool result (see ../scripts/capture.ts) as the ToolReply the page works with.
import type { ToolReply } from "../types";

const files = import.meta.glob("../__fixtures__/*.json", { eager: true, import: "default" }) as Record<string, any>;

export function fx(name: string): { tool: string; args: Record<string, unknown>; reply: ToolReply } {
  const f = files[`../__fixtures__/${name}.json`];
  if (!f) throw new Error(`no fixture ${name}`);
  return { tool: f.tool, args: f.args, reply: { text: f.text, structured: f.structuredContent, isError: f.isError } };
}

export const toolsFixture = files["../__fixtures__/tools-list.json"] as {
  name: string;
  description: string;
  _meta?: { ui?: { visibility?: string[] } };
}[];

/** Replies a fake MCP client returns, keyed by tool name. */
export function fakeCall(map: Record<string, ToolReply> = {}) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const call = async (name: string, args: Record<string, unknown>): Promise<ToolReply> => {
    calls.push({ name, args });
    return map[name] ?? { text: "ok", structured: { kind: "undone", undone: false, summary: null }, isError: false };
  };
  return { call, calls };
}
