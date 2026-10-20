import type { ToolResult } from "core/src/contracts";
import { MAX_SPOKEN_WORDS, countWords, speak } from "./speak";

/** A normal answer. `text` goes through speak(), so it is plain, short and has no links or long numbers. */
export function ok(text: string | readonly string[], structured: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: speak(text) || "Done." }], structuredContent: structured };
}

/**
 * A first sentence plus a second one that must not be lost (the coverage disclaimer, SPEC section 6). `seconds` runs
 * from richest to minimal: the richest that still fits under the word cap is used, the last one always stays, and the
 * first sentence is clipped only when even the minimal second does not fit. speak() alone would drop the whole second
 * sentence when the first one is long.
 */
export function okFit(first: string, seconds: readonly string[], structured: Record<string, unknown>): ToolResult {
  const minimal = speak(seconds[seconds.length - 1]!);
  const one = speak(first, Math.max(1, MAX_SPOKEN_WORDS - countWords(minimal)));
  const second =
    seconds.map((s) => speak(s)).find((s) => countWords(one) + countWords(s) <= MAX_SPOKEN_WORDS) ?? minimal;
  return { content: [{ type: "text", text: `${one} ${second}`.trim() }], structuredContent: structured };
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
