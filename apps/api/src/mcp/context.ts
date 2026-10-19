import type { ClauseIndex } from "core/src/retrieval";
import type { Repository, ToolResult } from "core/src/contracts";
import type { IndexCache } from "./indexCache";

/**
 * Everything a tool handler may touch. Handlers are pure functions of this and their arguments: the household id comes
 * from the verified bearer token (never from arguments), the clock and id source are injected, and the only storage
 * is the repository. No network, no model (CLAUDE.md hard rules).
 */
export interface ToolContext {
  householdId: string;
  repo: Repository;
  /** ISO date, YYYY-MM-DD, derived from the injected clock. */
  today: string;
  /** Injected clock, milliseconds. */
  nowMs: number;
  newId: () => string;
  indexes: IndexCache;
}

export type ToolHandler<A> = (ctx: ToolContext, args: A) => Promise<ToolResult>;

export type { ClauseIndex };
