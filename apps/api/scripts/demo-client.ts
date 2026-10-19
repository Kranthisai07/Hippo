// `pnpm --filter @hippo/api demo`: walks the three demo moments through a real MCP client against our own server.
// With HIPPO_URL set it targets that server (the demo login must match its config); otherwise it starts one locally.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getTokens } from "../src/oauthFlow";
import { startServer } from "../src/server";

const line = (s = "") => console.log(s);
const heading = (s: string) => line(`\n=== ${s} ===`);

interface Reply {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, any>;
  isError?: boolean;
}

async function main(): Promise<void> {
  const quiet = (l: string) => void l;
  const remote = process.env.HIPPO_URL;
  const local = remote ? null : await startServer({ port: Number(process.env.PORT ?? 8787), log: quiet });
  const base = remote ?? local!.url;
  const clientId = process.env.HIPPO_CLIENT_ID ?? local?.clientId ?? "hippo-demo";
  const redirectUri = process.env.HIPPO_REDIRECT_URI ?? local?.redirectUri ?? "http://localhost:5173/callback";
  const mcpUrl = `${base}/mcp`;

  try {
    heading("1. Sign in (OAuth 2.1, authorization code with PKCE S256)");
    const tokens = await getTokens({ base, clientId, redirectUri, resource: mcpUrl });
    line(
      `Signed in as the demo user. Access token received (${tokens.expiresIn} s), refresh token ${tokens.refreshToken ? "received" : "none"}.`,
    );

    const client = new Client({ name: "hippo-demo-client", version: "0.1.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(mcpUrl), {
        requestInit: { headers: { Authorization: `Bearer ${tokens.accessToken}` } },
      }),
    );
    const server = client.getServerVersion();
    line(`MCP initialize ok: ${server?.name} ${server?.version}.`);

    const { tools } = await client.listTools();
    heading("2. tools/list");
    for (const t of tools) {
      const app = (t._meta as any)?.ui?.visibility?.includes("app");
      line(`${t.name.padEnd(20)} ${app ? "[card button only]" : "[model]"}`);
    }

    const say = async (who: string, args: Record<string, unknown>, name: string): Promise<Reply> => {
      line(`\nYou say: ${who}`);
      line(`tools/call ${name} ${JSON.stringify(args)}`);
      const r = (await client.callTool({ name, arguments: args })) as unknown as Reply;
      line(`Alexa says: ${r.content[0]?.text}`);
      return r;
    };

    heading("3. Moment 2: voice coverage check");
    const cov = await say(
      '"My dishwasher is leaking, am I covered?"',
      { asset: "dishwasher", issue: "leaking" },
      "check_coverage",
    );
    const s = cov.structuredContent!;
    line(`\nCoverage card data: badge ${s.badge}, term ${s.term.startDate} to ${s.term.endDate}`);
    line(
      `  top clause (${s.topClause?.docName}, page ${s.topClause?.page}) and exclusion (${s.exclusionClause?.docName}, page ${s.exclusionClause?.page}):`,
    );
    line(`  "${String(s.exclusionClause?.text).split("\n").slice(1).join(" ").slice(0, 160)}..."`);
    line(
      `  claim steps: ${s.claimSteps.length}, claim by ${s.claimByDate}, missing proof: ${s.missingProof.join("; ") || "none"}`,
    );
    line(
      s.proactive
        ? `  (the first answer carried the proactive sentence: "${s.proactive.sentence}")`
        : "  (no proactive sentence)",
    );

    heading("4. Moment 3: the next question, and what is coming up");
    const up = await say('"What is coming up?"', {}, "whats_coming_up");
    line(
      up.content[0]!.text.startsWith("Before that")
        ? "  (a second proactive sentence: unexpected)"
        : "  (no second proactive sentence, as designed: at most one a day)",
    );
    for (const i of up.structuredContent!.items as any[])
      line(`  ${String(i.dueDate ?? "no date").padEnd(11)} ${i.severity ?? "-"}  ${i.label}`);
    for (const r of up.structuredContent!.recalls as any[]) line(`  recall card: ${r.label} - ${r.detail}`);

    heading("5. A few more tools");
    await say(
      '"What does my lease say about breaking it early?"',
      { question: "what does my lease say about breaking it early", about: "lease" },
      "ask_documents",
    );
    await say('"I just had the car serviced"', { asset: "car", action: "service" }, "log_service");
    await say('"Undo that"', {}, "undo_last");
    await say('"That recall is not mine"', { alert_id: "alert-recall-26530", action: "not_mine" }, "resolve_alert");

    await client.close();
    line("\nDone.");
  } finally {
    await local?.close();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
