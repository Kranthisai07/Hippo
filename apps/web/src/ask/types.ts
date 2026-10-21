// Shapes the page reads from a tool result. The zod schemas in packages/core/src/contracts/results.ts are the source
// of truth; the page treats every field as untrusted text and checks `kind` before it reads anything else.

export interface Structured {
  kind: string;
  [key: string]: any;
}

export interface ToolReply {
  /** content[0].text: what the assistant would speak. */
  text: string;
  structured: Structured | null;
  isError: boolean;
}

export type CallTool = (name: string, args: Record<string, unknown>) => Promise<ToolReply>;

export interface ToolInfo {
  name: string;
  description: string;
  /** True for the card button tools (`_meta.ui.visibility` is ["app"]): the model never sees them. */
  appOnly: boolean;
}

export interface LogEntry {
  n: number;
  /** Local time of day, for display. */
  at: string;
  method: string;
  params: string;
  result: string;
  ms: number;
  ok: boolean;
  request: string;
  response: string;
}

export interface QuotedClause {
  docId: string;
  docName: string;
  page: number;
  heading?: string;
  text: string;
  quotedFromDocument: true;
}

export interface ComingUpItem {
  id: string;
  source: "deadline" | "recall";
  type: string | null;
  label: string;
  dueDate: string | null;
  daysAway: number | null;
  severity: "high" | "possible" | null;
  alertId: string | null;
  detail: string | null;
}

export class SessionEndedError extends Error {
  readonly code = "session_ended";
  constructor() {
    super("Your sign-in ended. Sign in again.");
  }
}
