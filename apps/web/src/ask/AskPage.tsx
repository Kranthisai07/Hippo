// The Hippo demo MCP client page. Mounted at /ask and /callback by the main app. No router: it reads window.location.
import { useCallback, useEffect, useRef, useState } from "react";
import "./ask.css";
import { completeExchange, signInDemo, signOut } from "./auth";
import { Boundary } from "./cards";
import { Console } from "./Console";
import { Icon } from "./Icon";
import { connectMcp, type McpSession } from "./mcp";
import { ProtocolLog } from "./ProtocolLog";
import type { LogEntry } from "./types";

type Phase = "signed_out" | "working" | "ready";

const DOWN = "The Hippo server is not running. Start it with pnpm dev, then try again.";

function friendly(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  // A refused connection through the Vite proxy shows up as a 5xx or a failed fetch.
  if (/failed to fetch|networkerror|load failed|\b50[0-4]\b|ECONNREFUSED/i.test(m)) return DOWN;
  return m;
}

export default function AskPage() {
  const [phase, setPhase] = useState<Phase>("signed_out");
  const [message, setMessage] = useState<string | null>(null);
  const [session, setSession] = useState<McpSession | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const started = useRef(false);

  const connect = useCallback(async () => {
    const s = await connectMcp({ onLog: (e) => setLog((l) => [...l, e].slice(-200)) });
    setSession(s);
    setPhase("ready");
  }, []);

  const fail = useCallback((e: unknown) => {
    signOut();
    setSession(null);
    setPhase("signed_out");
    setMessage(friendly(e));
  }, []);

  // Returning from the sign-in page (/callback?code=...&state=...): finish the exchange, then connect.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const search = window.location.search;
    if (!new URLSearchParams(search).has("code") && !new URLSearchParams(search).has("error")) return;
    setPhase("working");
    window.history.replaceState(null, "", "/ask");
    completeExchange(search).then(connect).catch(fail);
  }, [connect, fail]);

  const signIn = () => {
    setMessage(null);
    setPhase("working");
    signInDemo().then(connect).catch(fail);
  };

  const out = () => {
    void session?.close().catch(() => undefined);
    signOut();
    setSession(null);
    setLog([]);
    setPhase("signed_out");
  };

  return (
    <div className="hippo-ask">
      <a className="ha-skip" href="#ha-main">
        Skip to the page
      </a>
      <header className="ha-top">
        <div className="ha-brand">
          <span className="ha-logo" aria-hidden="true">
            H
          </span>
          <div>
            <h1>Hippo</h1>
            <p className="ha-muted">Demo client for the voice assistant add-on</p>
          </div>
        </div>
        {session ? (
          <div className="ha-conn">
            <span className="ha-chip">
              <Icon name="check" size={16} />
              <span>
                Connected: {session.server.name} {session.server.version}
              </span>
            </span>
            <button type="button" className="ha-btn ha-btn--small" onClick={out}>
              <Icon name="logout" size={16} /> <span>Sign out</span>
            </button>
          </div>
        ) : null}
      </header>

      <main id="ha-main" className="ha-main">
        {phase !== "ready" || !session ? (
          <section className="ha-hero" aria-live="polite" aria-busy={phase === "working"}>
            <h2>Ask Hippo about your paperwork</h2>
            <p>
              This page is a real MCP client. It signs in with OAuth (PKCE), then calls the Hippo server over Streamable
              HTTP, the same way a voice assistant would.
            </p>
            {message ? (
              <p className="ha-error" role="alert">
                <Icon name="alert" size={20} /> <span>{message}</span>
              </p>
            ) : null}
            <button type="button" className="ha-btn ha-btn--primary" onClick={signIn} disabled={phase === "working"}>
              {phase === "working" ? "Signing in..." : "Sign in as the demo account"}
            </button>
          </section>
        ) : (
          <Boundary text="Something went wrong drawing this page. Reload it and sign in again.">
            <div className="ha-layout">
              <Console
                call={session.call}
                tools={session.tools}
                onSessionEnded={() => {
                  signOut();
                  setSession(null);
                  setPhase("signed_out");
                  setMessage("Your sign-in ended. Sign in again to keep going.");
                }}
              />
              <aside className="ha-side" aria-label="Protocol log">
                <ProtocolLog entries={log} />
              </aside>
            </div>
          </Boundary>
        )}
      </main>

      <footer className="ha-foot">
        Cards are plain React drawn from the tool's structured result. They are not the MCP Apps host bridge.
      </footer>
    </div>
  );
}
