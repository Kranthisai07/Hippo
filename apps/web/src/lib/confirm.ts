import type { FieldView } from "./types";

export interface ConfirmPlan {
  /** Exactly the date fields that are still unconfirmed AND have been shown. The only names ever sent. */
  names: string[];
  /** True when there is something to confirm and every such date field has been shown. */
  ready: boolean;
  /** True when no date field is waiting for the person. */
  nothingLeft: boolean;
}

/** What "Confirm all dates" may send. Never a wildcard, never a field that was not on screen. */
export function confirmPlan(fields: readonly FieldView[], shown: ReadonlySet<string>): ConfirmPlan {
  const waiting = fields.filter((f) => f.isDate && f.status === "extracted");
  const names = waiting.filter((f) => shown.has(f.name)).map((f) => f.name);
  return { names, ready: waiting.length > 0 && names.length === waiting.length, nothingLeft: waiting.length === 0 };
}
