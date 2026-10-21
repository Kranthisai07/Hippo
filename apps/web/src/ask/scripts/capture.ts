// Dumps real tool results from the in-process app into ../__fixtures__ (run: pnpm --filter @hippo/web capture).
// It starts the api the way apps/api/scripts/demo-client.ts does. Never edit the JSON by hand: run this again.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getTokens } from "../../../../api/src/oauthFlow";
import { startServer } from "../../../../api/src/server";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "__fixtures__");
mkdirSync(out, { recursive: true });

const server = await startServer({ port: 8799, log: () => undefined });
try {
  const tokens = await getTokens({
    base: server.url,
    clientId: server.clientId,
    redirectUri: server.redirectUri,
    resource: server.mcpUrl,
  });
  const client = new Client({ name: "hippo-capture", version: "0.1.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${tokens.accessToken}` } },
    }),
  );

  const save = (file: string, value: unknown) =>
    writeFileSync(join(out, `${file}.json`), `${JSON.stringify(value, null, 2)}\n`);
  const call = async (file: string, tool: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name: tool, arguments: args })) as {
      content: { text: string }[];
      structuredContent?: any;
      isError?: boolean;
    };
    save(file, {
      tool,
      args,
      isError: r.isError ?? false,
      text: r.content[0]?.text,
      structuredContent: r.structuredContent,
    });
    return r.structuredContent as any;
  };

  const { tools } = await client.listTools();
  save(
    "tools-list",
    tools.map((t) => ({ name: t.name, description: t.description, _meta: t._meta, inputSchema: t.inputSchema })),
  );

  const cov = await call("check-coverage", "check_coverage", { asset: "dishwasher", issue: "leaking" });
  const up = await call("whats-coming-up", "whats_coming_up", {});
  await call("ask-documents", "ask_documents", {
    question: "what does my lease say about breaking it early",
    about: "lease",
  });
  await call("get-agreement", "get_agreement", { about: "car insurance" });
  await call("get-agreement-ambiguous", "get_agreement", { about: "subscription" });
  await call("ask-documents-not-found", "ask_documents", { question: "anything", about: "spaceship" });
  await call("bad-input-error", "log_service", { asset: "car", action: "service", date: "2999-01-01" });
  await call("show-clause", "ui_show_clause", { doc_id: cov.exclusionClause.docId, page: cov.exclusionClause.page });
  await call("claim-steps", "ui_show_claim_steps", { agreement_id: cov.agreement.id });
  await call("log-service", "log_service", { asset: "car", action: "service" });
  await call("get-history", "get_history", { asset: "car" });
  await call("undo", "undo_last", {});
  const item = up.items.find((i: any) => i.alertId && i.source === "deadline");
  await call("resolve-alert", "ui_resolve_alert", { alert_id: item.alertId, action: "dismiss" });
  await call("resolve-recall-not-mine", "ui_resolve_alert", { alert_id: up.recalls[0].alertId, action: "not_mine" });
  await call("add-record", "add_record", {
    kind: "subscription",
    vendor: "Gym",
    amount: 40,
    cycle: "monthly",
    next_charge_date: "2026-11-05",
  });
  await client.close();
  console.log("fixtures written to", out);
} finally {
  await server.close();
}
