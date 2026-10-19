import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolResult } from "core/src/contracts";
import type { ToolContext } from "./context";
import { injectProactive } from "./proactive";
import { TOOLS } from "./registry";
import { fail } from "./result";

export const SERVER_INFO = { name: "hippo", version: "0.1.0" } as const;

export interface McpDeps {
  /** Null for a service caller (client_credentials): it may list tools but never call one. */
  context: ToolContext | null;
  log?: (line: string) => void;
}

/** A fresh server per request (stateless). The household id lives in `context`, set from the bearer token only. */
export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer(SERVER_INFO);
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.schema,
        annotations: { readOnlyHint: tool.readOnly, openWorldHint: false },
        ...(tool.app ? { _meta: { ui: { visibility: ["app"] } } } : {}),
      },
      async (args: unknown): Promise<CallToolResult> => {
        const ctx = deps.context;
        if (!ctx) return fail("Sign in to use this.", "not_allowed") as CallToolResult;
        try {
          let result: ToolResult = await tool.handler(ctx, args as never);
          if (tool.proactive) {
            const items = (result.structuredContent?.items ?? []) as { alertId?: string | null }[];
            const skip = new Set(items.flatMap((i) => (i.alertId ? [i.alertId] : [])));
            result = await injectProactive(ctx, result, { skip });
          }
          return result as CallToolResult;
        } catch (e) {
          // Never log arguments or document text, only the tool and the error class.
          deps.log?.(`[hippo-api] tool ${tool.name} failed: ${e instanceof Error ? e.name : "error"}`);
          return fail("Something went wrong on my side. Please try again in a moment.", "internal") as CallToolResult;
        }
      },
    );
  }
  return server;
}
