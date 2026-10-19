import type { ToolResult } from "core/src/contracts";
import { speak } from "./speak";

/** A normal answer. `text` goes through speak(), so it is plain, short and has no links or long numbers. */
export function ok(text: string | readonly string[], structured: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: speak(text) || "Done." }], structuredContent: structured };
}

/** A failure the person can hear: isError with a spoken sentence and a machine readable code. */
export function fail(text: string, code: "bad_input" | "not_allowed" | "internal" = "bad_input"): ToolResult {
  return {
    content: [{ type: "text", text: speak(text) || "Something went wrong." }],
    structuredContent: { kind: "error", code },
    isError: true,
  };
}

/** "A, B or C". */
export function orList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}
