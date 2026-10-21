// Dev only: the console and log with REAL captured results behind a fake client, for screenshots and axe checks.
// Open /ask-preview.html with the Vite dev server (no API needed). Not part of the page the main app mounts.
import { createRoot } from "react-dom/client";
import "./ask.css";
import { Console } from "./Console";
import { ProtocolLog } from "./ProtocolLog";
import type { CallTool, LogEntry, ToolInfo } from "./types";

const files = import.meta.glob("./__fixtures__/*.json", { eager: true, import: "default" }) as Record<string, any>;
const byTool: Record<string, string> = {
  check_coverage: "check-coverage",
  whats_coming_up: "whats-coming-up",
  ask_documents: "ask-documents",
  get_agreement: "get-agreement",
  log_service: "log-service",
  undo_last: "undo",
  ui_show_clause: "show-clause",
  ui_show_claim_steps: "claim-steps",
  ui_resolve_alert: "resolve-alert",
  get_history: "get-history",
};

const call: CallTool = async (name) => {
  await new Promise((r) => setTimeout(r, 250));
  const f = files[`./__fixtures__/${byTool[name] ?? "undo"}.json`];
  return { text: f.text, structured: f.structuredContent, isError: f.isError };
};

const tools: ToolInfo[] = (files["./__fixtures__/tools-list.json"] as any[]).map((t) => ({
  name: t.name,
  description: t.description ?? "",
  appOnly: t._meta?.ui?.visibility?.includes("app") === true,
}));

const log: LogEntry[] = [
  ["initialize", "protocol 2025-11-25, client hippo-ask-page", "hippo-api 0.0.0", 12],
  ["tools/list", "", "12 tools", 6],
  ["tools/call", 'check_coverage({"asset":"dishwasher","issue":"leaking"})', "coverage", 9],
].map(([method, params, result, ms], i) => ({
  n: i + 1,
  at: "12:00:00",
  method: method as string,
  params: params as string,
  result: result as string,
  ms: ms as number,
  ok: true,
  request: "{}",
  response: "{}",
}));

createRoot(document.getElementById("root")!).render(
  <div className="hippo-ask">
    <main className="ha-main">
      <h1 className="ha-sr">Hippo</h1>
      <div className="ha-layout">
        <Console call={call} tools={tools} />
        <aside className="ha-side" aria-label="Protocol log">
          <ProtocolLog entries={log} />
        </aside>
      </div>
    </main>
  </div>,
);
