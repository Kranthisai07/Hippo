// The presenter console. This page plays the part of the voice assistant's model: a button picks the tool from the
// phrase and sends only "the thing". The server never calls an LLM.
import { useEffect, useRef, useState } from "react";
import { ResultView } from "./cards";
import { THING_KEY } from "./format";
import { Icon } from "./Icon";
import type { CallTool, ToolInfo, ToolReply } from "./types";

interface Phrase {
  say: string;
  tool: string;
  args: Record<string, unknown>;
}

const PHRASES: Phrase[] = [
  {
    say: "My dishwasher is leaking, am I covered?",
    tool: "check_coverage",
    args: { asset: "dishwasher", issue: "leaking" },
  },
  { say: "What is coming up?", tool: "whats_coming_up", args: {} },
  {
    say: "What does my lease say about breaking it early?",
    tool: "ask_documents",
    args: { question: "What does my lease say about breaking it early?", about: "lease" },
  },
  { say: "When does my car insurance renew?", tool: "get_agreement", args: { about: "car insurance" } },
  { say: "I just had the car serviced", tool: "log_service", args: { asset: "car", action: "service" } },
  { say: "Undo that", tool: "undo_last", args: {} },
];

const SAMPLES: Record<string, string> = {
  whats_coming_up: '{ "window_days": 30 }',
  check_coverage: '{ "asset": "dishwasher", "issue": "leaking" }',
  ask_documents: '{ "question": "Can I end the lease early?", "about": "lease" }',
  get_agreement: '{ "about": "car insurance" }',
  add_record:
    '{ "kind": "subscription", "vendor": "Gym", "amount": 40, "cycle": "monthly", "next_charge_date": "2026-11-05" }',
  log_service: '{ "asset": "car", "action": "oil change" }',
  get_history: '{ "asset": "car" }',
  resolve_alert: '{ "alert_id": "", "action": "dismiss" }',
  undo_last: "{}",
};

interface Turn {
  phrase: string;
  tool: string;
  args: Record<string, unknown>;
  status: "loading" | "done" | "error";
  reply?: ToolReply;
  error?: string;
}

function Speech({ reply }: { reply: ToolReply }) {
  const sentence = reply.structured?.proactive?.sentence as string | undefined;
  const lead = sentence && reply.text.startsWith(sentence) ? sentence : null;
  return (
    <div className="ha-bubble ha-bubble--assistant" data-testid="speech">
      <span className="ha-bubble__icon">
        <Icon name="speaker" size={20} />
        <span className="ha-sr">Hippo says</span>
      </span>
      <p>
        {lead ? (
          <>
            <mark className="ha-proactive" data-proactive="">
              {lead}
            </mark>
            {reply.text.slice(lead.length)}
          </>
        ) : (
          reply.text
        )}
      </p>
    </div>
  );
}

export function Console({
  call,
  tools,
  onSessionEnded,
}: {
  call: CallTool;
  tools: ToolInfo[];
  onSessionEnded?: () => void;
}) {
  const [turn, setTurn] = useState<Turn | null>(null);
  const seq = useRef(0);
  const stage = useRef<HTMLElement>(null);
  // Bring the new answer to the top of the view so the spoken text and the card show together.
  useEffect(() => {
    if (turn?.status === "done") stage.current?.scrollIntoView?.({ block: "start" });
  }, [turn?.status, turn?.phrase]);
  const model = tools.filter((t) => !t.appOnly);
  const appTools = tools.filter((t) => t.appOnly);
  const [pick, setPick] = useState(model[0]?.name ?? "whats_coming_up");
  const [json, setJson] = useState(SAMPLES[pick] ?? "{}");
  const [jsonError, setJsonError] = useState<string | null>(null);

  const run = async (phrase: string, tool: string, args: Record<string, unknown>) => {
    const id = ++seq.current;
    setTurn({ phrase, tool, args, status: "loading" });
    try {
      const reply = await call(tool, args);
      if (id === seq.current) setTurn({ phrase, tool, args, status: "done", reply });
    } catch (e) {
      if ((e as { code?: string })?.code === "session_ended") onSessionEnded?.();
      if (id === seq.current)
        setTurn({ phrase, tool, args, status: "error", error: e instanceof Error ? e.message : "Unknown error" });
    }
  };

  const runAdvanced = () => {
    let args: unknown;
    try {
      args = JSON.parse(json);
    } catch {
      setJsonError("That is not valid JSON. Check the quotes and commas.");
      return;
    }
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      setJsonError("Arguments must be a JSON object, like { }.");
      return;
    }
    setJsonError(null);
    void run(`Run ${pick}`, pick, args as Record<string, unknown>);
  };

  return (
    <div className="ha-console">
      <section aria-labelledby="ha-say">
        <h2 id="ha-say" className="ha-h2">
          Say something
        </h2>
        <p className="ha-muted ha-honest">
          This page plays the part of the voice assistant's model: it picks the tool from your phrase and sends only the
          thing you named. The server never calls an LLM.
        </p>
        <div className="ha-phrases">
          {PHRASES.map((p) => (
            <button
              key={p.say}
              type="button"
              className="ha-btn ha-btn--phrase"
              disabled={turn?.status === "loading"}
              onClick={() => void run(p.say, p.tool, p.args)}
            >
              <Icon name="send" size={16} />
              <span>{p.say}</span>
            </button>
          ))}
        </div>
      </section>

      <section
        ref={stage}
        className="ha-stage"
        aria-label="Conversation"
        aria-live="polite"
        aria-busy={turn?.status === "loading"}
      >
        {!turn ? (
          <p className="ha-empty">Pick a phrase above. The reply and its card appear here.</p>
        ) : (
          <>
            <div className="ha-bubble ha-bubble--user">
              <span className="ha-bubble__icon">
                <Icon name="user" size={20} />
                <span className="ha-sr">You say</span>
              </span>
              <p>{turn.phrase}</p>
            </div>
            {turn.status === "loading" ? (
              <div className="ha-listening" data-testid="listening">
                <span className="ha-skel ha-skel--line" />
                <span className="ha-skel ha-skel--line ha-skel--short" />
                <span className="ha-sr">Listening for the answer</span>
              </div>
            ) : null}
            {turn.status === "error" ? (
              <p className="ha-error" role="alert">
                <Icon name="alert" size={20} />{" "}
                <span>Hippo could not complete that. {turn.error} Check that the server is running (pnpm dev).</span>
              </p>
            ) : null}
            {turn.status === "done" && turn.reply ? (
              <>
                <Speech reply={turn.reply} />
                <ResultView
                  tool={turn.tool}
                  args={turn.args}
                  reply={turn.reply}
                  call={call}
                  rerun={(tool, args) => {
                    void run(String(args[THING_KEY[tool] ?? ""] ?? tool), tool, args);
                  }}
                />
              </>
            ) : null}
          </>
        )}
      </section>

      <details className="ha-details">
        <summary>
          <Icon name="terminal" size={16} /> <span>Advanced: run any tool</span>
        </summary>
        <div className="ha-advanced">
          <label htmlFor="ha-tool">Tool</label>
          <select
            id="ha-tool"
            value={pick}
            onChange={(e) => {
              setPick(e.target.value);
              setJson(SAMPLES[e.target.value] ?? "{}");
              setJsonError(null);
            }}
          >
            {model.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
          <label htmlFor="ha-args">Arguments (JSON)</label>
          <textarea id="ha-args" rows={4} spellCheck={false} value={json} onChange={(e) => setJson(e.target.value)} />
          {jsonError ? (
            <p className="ha-error-text" role="alert">
              {jsonError}
            </p>
          ) : null}
          <button type="button" className="ha-btn" disabled={turn?.status === "loading"} onClick={runAdvanced}>
            Call tool
          </button>
        </div>
      </details>

      <details className="ha-details">
        <summary>
          <Icon name="list" size={16} /> <span>The model sees {model.length} tools</span>
        </summary>
        <ul className="ha-tools">
          {model.map((t) => (
            <li key={t.name}>
              <code>{t.name}</code>
              <span className="ha-muted">{t.description}</span>
            </li>
          ))}
        </ul>
        <p className="ha-muted">
          {appTools.length} more are card buttons only and hidden from the model (visibility: app):
        </p>
        <ul className="ha-tools">
          {appTools.map((t) => (
            <li key={t.name}>
              <code>{t.name}</code>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
