import type { LogEntry } from "./types";

export function ProtocolLog({ entries }: { entries: LogEntry[] }) {
  return (
    <details className="ha-log" open>
      <summary>Protocol log ({entries.length} messages)</summary>
      <p className="ha-muted">Every JSON-RPC request this page sends to /mcp. The sign-in token is never shown.</p>
      {entries.length === 0 ? <p className="ha-empty">Nothing yet.</p> : null}
      <ol className="ha-log__list" aria-label="JSON-RPC messages">
        {entries.map((e) => (
          <li key={e.n} className={e.ok ? "" : "ha-log__bad"}>
            <details>
              <summary>
                <span className="ha-log__n">{e.n}</span>
                <span className="ha-log__method">{e.method}</span>
                <span className="ha-log__ms">{e.ms} ms</span>
                <span className="ha-log__params">{e.params}</span>
                <span className="ha-log__result">
                  {e.ok ? "ok" : "failed"}: {e.result}
                </span>
              </summary>
              <pre tabIndex={0}>{e.request}</pre>
              <pre tabIndex={0}>{e.response}</pre>
            </details>
          </li>
        ))}
      </ol>
    </details>
  );
}
