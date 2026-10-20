import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ErrorCode, McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
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

/**
 * A fresh server per request (stateless). The household id lives in `context`, set from the bearer token only, and
 * the handlers never read an id from the request.
 *
 * Tools are registered with their zod schemas so `tools/list` carries the JSON schemas. `tools/call` is then answered
 * by our own handler (set below) instead of the SDK's, for one reason: the SDK turns a bad argument into a message such
 * as "MCP error -32602: Input validation error", which is not something to say out loud. Ours returns a spoken
 * sentence with isError set.
 */
export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer(SERVER_INFO);
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.schema,
        // A tool that may announce an alert writes its status, so it is not read only.
        annotations: { readOnlyHint: tool.readOnly && !tool.proactive, openWorldHint: false },
        ...(tool.app ? { _meta: { ui: { visibility: ["app"] } } } : {}),
      },
      async () => fail("This tool is called through tools/call.") as CallToolResult,
    );
  }

  server.server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const tool = TOOLS.find((t) => t.name === request.params.name);
    if (!tool) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name.slice(0, 80)}`);
    const ctx = deps.context;
    if (!ctx) return fail("Sign in to use this.", "not_allowed") as CallToolResult;

    const parsed = tool.schema.safeParse(request.params.arguments ?? {});
    if (!parsed.success) {
      return fail("I did not understand that. Please say it again with a little more detail.") as CallToolResult;
    }
    try {
      let result: ToolResult = await tool.handler(ctx, parsed.data as never);
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
  });
  return server;
}
