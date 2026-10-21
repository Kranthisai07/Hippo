// Cards are plain React rendered from a tool's structuredContent, branching on `kind`.
// Every string that came from a document is rendered as a React text child: no HTML, no markdown, no auto links.
import { Component, useState, type ReactNode } from "react";
import { daysAwayText, fmtDate, parts, splitRecall, THING_KEY } from "./format";
import { Icon, kindIcon } from "./Icon";
import type { CallTool, ComingUpItem, QuotedClause, Structured, ToolReply } from "./types";

interface Common {
  call: CallTool;
}

export interface ResultViewProps extends Common {
  tool: string;
  args: Record<string, unknown>;
  reply: ToolReply;
  /** Runs a tool again as a new turn (used to answer a question back). */
  rerun: (tool: string, args: Record<string, unknown>) => void;
}

const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const isClause = (c: unknown): c is QuotedClause =>
  typeof c === "object" && c !== null && typeof (c as QuotedClause).text === "string";
const pageNote = (p: number | null | undefined): string => (p ? `page ${p}` : "page not recorded");

/** A result this page cannot draw (malformed structuredContent) must never take the page down. */
export class Boundary extends Component<{ children: ReactNode; text?: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="ha-card ha-card--compact" role="note">
        <h3 className="ha-title">
          <Icon name="help" size={24} /> <span>This result could not be drawn</span>
        </h3>
        <p className="ha-body">{this.props.text || "The server sent something this page does not understand."}</p>
      </section>
    );
  }
}

/** The card for one tool result. */
export function ResultView(p: ResultViewProps) {
  return (
    <div className="ha-card-wrap" data-testid="result-card">
      <Boundary text={p.reply.text}>
        <Body {...p} />
      </Boundary>
    </div>
  );
}

function Body({ tool, args, reply, call, rerun }: ResultViewProps) {
  const s = reply.structured;
  if (reply.isError || !s) return <ErrorCard text={reply.text} />;
  switch (s.kind) {
    case "coverage":
      return <CoverageCard s={s} call={call} />;
    case "coming_up":
      return <ComingUpCard s={s} call={call} />;
    case "clauses":
      return <ClausesCard s={s} />;
    case "agreement":
      return <AgreementCard s={s} />;
    case "history":
      return <HistoryCard s={s} />;
    case "record_added":
      return <RecordAddedCard s={s} />;
    case "service_logged":
      return <ServiceLoggedCard s={s} />;
    case "undone":
      return <Simple icon="refresh" title={s.undone ? "Removed" : "Nothing to undo"} text={s.summary ?? reply.text} />;
    case "alert_resolved":
      return <Simple icon="check" title={statusWord(s.action)} text={reply.text} />;
    case "clause_view":
      return <ClauseView s={s} />;
    case "claim_steps":
      return <ClaimStepsView s={s} />;
    case "ambiguous":
      return <AmbiguousCard s={s} tool={tool} args={args} rerun={rerun} />;
    case "not_found":
      return (
        <Simple
          icon="help"
          title={`I could not find that ${String(s.what)}`}
          text={s.query ? `Nothing matched "${String(s.query)}". Try just the name, like dishwasher.` : reply.text}
        />
      );
    case "error":
      return <ErrorCard text={reply.text} />;
    default:
      return <Simple icon="help" title="A result this page does not draw yet" text={reply.text} />;
  }
}

// ---- small parts ----

const statusWord = (action: string): string =>
  action === "done"
    ? "Marked done"
    : action === "dismiss"
      ? "Dismissed"
      : action === "not_mine"
        ? "Marked not mine"
        : "Snoozed for 7 days";

function Simple({ icon, title, text }: { icon: string; title: string; text: string }) {
  return (
    <section className="ha-card ha-card--compact">
      <h3 className="ha-title">
        <Icon name={icon} size={24} /> <span>{title}</span>
      </h3>
      <p className="ha-body">{text}</p>
    </section>
  );
}

function ErrorCard({ text }: { text: string }) {
  return (
    <section className="ha-card ha-card--compact ha-card--error" role="alert">
      <h3 className="ha-title">
        <Icon name="alert" size={24} /> <span>That did not work</span>
      </h3>
      <p className="ha-body">{text || "Something went wrong. Please try again."}</p>
    </section>
  );
}

function Chip({ children, icon }: { children: ReactNode; icon?: string }) {
  return (
    <span className="ha-chip">
      {icon ? <Icon name={icon} size={16} /> : null}
      <span>{children}</span>
    </span>
  );
}

/** A clause copied from a document. Shown as a quotation with its source, never as an instruction. */
function Quote({ c, clamp }: { c: QuotedClause; clamp?: boolean }) {
  const text = c.heading && c.text.startsWith(`${c.heading}\n`) ? c.text.slice(c.heading.length + 1) : c.text;
  return (
    <figure className="ha-quote">
      <figcaption className="ha-quote__source">
        <span className="ha-quote__label">Quoted from</span>
        <Chip icon="file">{`${c.docName}, ${pageNote(c.page)}`}</Chip>
      </figcaption>
      {c.heading ? <p className="ha-quote__heading">{c.heading}</p> : null}
      <blockquote className={clamp ? "ha-quote__text ha-clamp" : "ha-quote__text"}>{text}</blockquote>
    </figure>
  );
}

/** Runs one tool call and keeps its state, so buttons can show loading and a result below them. */
function useRun(call: CallTool) {
  const [state, setState] = useState<{ busy: boolean; reply: ToolReply | null; error: string | null }>({
    busy: false,
    reply: null,
    error: null,
  });
  const run = async (name: string, args: Record<string, unknown>) => {
    setState({ busy: true, reply: null, error: null });
    try {
      const reply = await call(name, args);
      setState({ busy: false, reply, error: null });
      return reply;
    } catch (e) {
      setState({ busy: false, reply: null, error: e instanceof Error ? e.message : "The call failed." });
      return null;
    }
  };
  return { ...state, run };
}

function Inline({
  busy,
  reply,
  error,
  call,
}: { busy: boolean; reply: ToolReply | null; error: string | null } & Common) {
  return (
    <div className="ha-inline" aria-live="polite" aria-busy={busy}>
      {busy ? <p className="ha-muted">Loading...</p> : null}
      {error ? <p className="ha-error-text">Could not complete that: {error}</p> : null}
      {reply ? (
        <Boundary text={reply.text}>
          <Body tool="" args={{}} reply={reply} call={call} rerun={() => undefined} />
        </Boundary>
      ) : null}
    </div>
  );
}

// ---- coverage ----

const BADGES = {
  covered: { icon: "check", word: "Covered" },
  not_covered: { icon: "x", word: "Not covered" },
  unclear: { icon: "help", word: "Unclear" },
} as const;

function CoverageCard({ s, call }: { s: Structured } & Common) {
  const quotes = [s.topClause, s.exclusionClause].filter(isClause);
  // A verdict needs a clause to cite (document and page). Without one the badge is Unclear.
  const key = (quotes.length && s.badge in BADGES ? s.badge : "unclear") as keyof typeof BADGES;
  const badge = BADGES[key];
  const t = s.term ?? {};
  const clause = useRun(call);
  const steps = useRun(call);
  return (
    <section className="ha-card" aria-label={`Coverage for ${s.asset?.name}`}>
      <header className="ha-cov-head">
        <div>
          <h3 className="ha-asset">{s.asset?.name}</h3>
          {s.agreement?.provider ? (
            <p className="ha-muted">
              {s.agreement.kind === "insurance" ? "Policy" : "Warranty"} from {s.agreement.provider}
            </p>
          ) : null}
        </div>
        <span className={`ha-badge ha-badge--${key}`} data-testid="badge">
          <Icon name={badge.icon} size={28} />
          <span>{badge.word}</span>
        </span>
      </header>

      <p className="ha-term">
        <span>
          {fmtDate(t.startDate, true)} to {fmtDate(t.endDate, true)}
        </span>
        <span className="ha-dot" aria-hidden="true" />
        <span>{t.inTerm === true ? "In term" : t.inTerm === false ? "Out of term" : "Term not known"}</span>
        <span className="ha-dot" aria-hidden="true" />
        <span>{t.datesConfirmed ? "Dates confirmed" : "Dates not confirmed yet"}</span>
      </p>

      {!quotes.length ? <p className="ha-muted">No clause was found to cite, so there is no verdict.</p> : null}
      <div className="ha-two">
        <div className="ha-col">
          {isClause(s.topClause) ? (
            <div className="ha-block">
              <h4 className="ha-h4">What your document covers</h4>
              <Quote c={s.topClause} clamp />
            </div>
          ) : null}
          {isClause(s.exclusionClause) ? (
            <div className="ha-block">
              <h4 className="ha-h4">What it leaves out</h4>
              <Quote c={s.exclusionClause} />
            </div>
          ) : null}
        </div>
        <div className="ha-col">
          {s.claimByDate ? (
            <p className="ha-fact">
              <span className="ha-fact__label">Claim by</span>
              <strong className="ha-fact__value">{fmtDate(s.claimByDate, true)}</strong>
              {s.claimWindowDays !== null && s.claimWindowDays !== undefined ? (
                <span className="ha-muted">Report within {s.claimWindowDays} days</span>
              ) : null}
            </p>
          ) : null}

          {arr(s.claimSteps).length ? (
            <div className="ha-block">
              <h4 className="ha-h4">Claim steps</h4>
              <ol className="ha-steps">
                {arr<{ text: string; page: number | null }>(s.claimSteps).map((st, i) => (
                  <li key={i}>
                    <span>{st.text}</span>
                    <span className="ha-muted"> ({pageNote(st.page)})</span>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}

          {arr(s.missingProof).length ? (
            <div className="ha-notice" role="note">
              <Icon name="alert" size={24} />
              <div>
                <p className="ha-notice__title">Missing proof</p>
                {arr<string>(s.missingProof).map((m, i) => (
                  <p key={i}>{m}</p>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="ha-actions">
        {quotes.length
          ? [s.exclusionClause, s.topClause]
              .filter((c): c is QuotedClause => Boolean(c))
              .filter((c, i, all) => all.findIndex((o) => o.docId === c.docId && o.page === c.page) === i)
              .map((c) => (
                <button
                  key={`${c.docId}:${c.page}`}
                  type="button"
                  className="ha-btn"
                  aria-label={`Show clause, page ${c.page} of ${c.docName}`}
                  disabled={clause.busy}
                  onClick={() => {
                    void clause.run("ui_show_clause", { doc_id: c.docId, page: c.page });
                  }}
                >
                  Show clause, page {c.page}
                </button>
              ))
          : null}
        {s.agreement?.id ? (
          <button
            type="button"
            className="ha-btn"
            disabled={steps.busy}
            onClick={() => {
              void steps.run("ui_show_claim_steps", { agreement_id: s.agreement.id });
            }}
          >
            Claim steps
          </button>
        ) : null}
      </div>
      <Inline {...clause} call={call} />
      <Inline {...steps} call={call} />
      <p className="ha-disclaimer">{s.disclaimer}</p>
    </section>
  );
}

function ClauseView({ s }: { s: Structured }) {
  return (
    <section className="ha-card ha-card--compact" data-testid="clause-view">
      <h3 className="ha-title">
        <Icon name="file" size={24} /> <span>{`${s.docName}, page ${s.page}`}</span>
      </h3>
      {arr(s.clauses)
        .filter(isClause)
        .map((c, i) => (
          <Quote key={i} c={c} />
        ))}
    </section>
  );
}

function ClaimStepsView({ s }: { s: Structured }) {
  const c = s.contact ?? {};
  const rows = [
    ["Phone", c.phone],
    ["Email", c.email],
    ["Web", c.url],
  ].filter(([, v]) => v);
  return (
    <section className="ha-card ha-card--compact" data-testid="claim-steps">
      <h3 className="ha-title">
        <Icon name="list" size={24} /> <span>How to file{s.docName ? ` (${s.docName})` : ""}</span>
      </h3>
      <ol className="ha-steps">
        {arr<{ text: string; page: number | null }>(s.steps).map((st, i) => (
          <li key={i}>
            <span>{st.text}</span>
            <span className="ha-muted"> ({pageNote(st.page)})</span>
          </li>
        ))}
      </ol>
      {s.claimWindowDays !== null && s.claimWindowDays !== undefined ? (
        <p className="ha-body">Report within {s.claimWindowDays} days.</p>
      ) : null}
      {rows.length ? (
        <dl className="ha-dl">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <p className="ha-disclaimer">Quoted from your document. This is what it says, not a claim decision.</p>
    </section>
  );
}

// ---- coming up and recalls ----

function Resolve({
  alertId,
  actions,
  call,
}: { alertId: string; actions: { action: string; label: string; aria?: string }[] } & Common) {
  const r = useRun(call);
  const [done, setDone] = useState<string | null>(null);
  return (
    <div className="ha-resolve">
      <div className="ha-actions">
        {actions.map((a) => (
          <button
            key={a.action}
            type="button"
            className="ha-btn ha-btn--small"
            aria-label={a.aria}
            disabled={r.busy || done !== null}
            onClick={async () => {
              const rep = await r.run("ui_resolve_alert", { alert_id: alertId, action: a.action });
              if (rep && !rep.isError) setDone(a.action);
            }}
          >
            {a.label}
          </button>
        ))}
      </div>
      <p className="ha-status" data-testid="status" aria-live="polite">
        {r.busy
          ? "Saving..."
          : r.error
            ? "Could not save. Try again."
            : done && r.reply && !r.reply.isError
              ? statusWord(done)
              : ""}
      </p>
    </div>
  );
}

function DateBlock({ iso }: { iso: string | null }) {
  const p = parts(iso);
  return (
    <div className="ha-date" aria-label={p ? fmtDate(iso, true) : "No date"}>
      {p ? (
        <>
          <span className="ha-date__mon">{p.mon}</span> <span className="ha-date__day">{p.day}</span>
        </>
      ) : (
        <span className="ha-date__mon">No date</span>
      )}
    </div>
  );
}

function RecallCard({ item, call }: { item: ComingUpItem } & Common) {
  const { hazard, remedy } = splitRecall(item.detail);
  return (
    <article className="ha-recall" data-testid="recall-card">
      <h4 className="ha-recall__title">
        <Icon name="alert" size={24} /> <span>{item.label}</span>
      </h4>
      {hazard ? (
        <p className="ha-oneline" title={hazard}>
          <span className="ha-k">Hazard</span> <span>{hazard}</span>
        </p>
      ) : null}
      {remedy ? (
        <p className="ha-oneline" title={remedy}>
          <span className="ha-k">Remedy</span> <span>{remedy}</span>
        </p>
      ) : null}
      <p className="ha-confidence">
        This recall may affect something your household owns. Check the product before you act.
      </p>
      {item.alertId ? (
        <Resolve
          alertId={item.alertId}
          call={call}
          actions={[
            { action: "done", label: "Mark done" },
            { action: "not_mine", label: "Not mine" },
          ]}
        />
      ) : null}
    </article>
  );
}

function ComingUpCard({ s, call }: { s: Structured } & Common) {
  const items = arr<ComingUpItem>(s.items);
  const recalls = arr<ComingUpItem>(s.recalls);
  const more = Math.max(0, Number(s.totalCount ?? 0) - items.length);
  return (
    <section className="ha-card" aria-label="Coming up">
      <header className="ha-cov-head">
        <h3 className="ha-asset">Coming up</h3>
        <p className="ha-muted">Next {s.windowDays} days</p>
      </header>
      <div className="ha-two ha-two--wide">
        <div className="ha-col">
          {items.length === 0 ? <p className="ha-body">Nothing is due in this window.</p> : null}
          <ul className="ha-rows">
            {items.map((it) =>
              it.source === "recall" ? (
                <li key={it.id}>
                  <RecallCard item={it} call={call} />
                </li>
              ) : (
                <li key={it.id} className="ha-row" data-testid="coming-item">
                  <DateBlock iso={it.dueDate} />
                  <div className="ha-row__main">
                    <p className="ha-row__title">
                      <Icon name={kindIcon(it.type)} size={20} /> <span>{it.label}</span>
                    </p>
                    <p className="ha-row__meta">
                      <span>{daysAwayText(it.daysAway)}</span>
                      {it.severity ? (
                        <span className={`ha-sev ha-sev--${it.severity}`}>
                          <Icon name={it.severity === "high" ? "alert" : "help"} size={16} />
                          <span>{it.severity === "high" ? "High" : "Possible"}</span>
                        </span>
                      ) : null}
                    </p>
                  </div>
                  {it.alertId ? (
                    <Resolve
                      alertId={it.alertId}
                      call={call}
                      actions={[
                        { action: "done", label: "Done", aria: `Done: ${it.label}` },
                        { action: "dismiss", label: "Dismiss", aria: `Dismiss: ${it.label}` },
                      ]}
                    />
                  ) : null}
                </li>
              ),
            )}
          </ul>
          {more > 0 ? <p className="ha-muted">{more} more are in the app.</p> : null}
        </div>
        <div className="ha-col">
          {recalls.length ? (
            <div className="ha-block">
              <h4 className="ha-h4">Recalls that may affect you</h4>
              <div className="ha-recalls">
                {recalls.map((r) => (
                  <RecallCard key={r.id} item={r} call={call} />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

// ---- the other kinds ----

function ClausesCard({ s }: { s: Structured }) {
  const clauses = arr(s.clauses).filter(isClause);
  return (
    <section className="ha-card">
      <h3 className="ha-title">
        <Icon name="file" size={24} /> <span>{s.found ? "What your documents say" : "Nothing relevant found"}</span>
      </h3>
      {!s.found || clauses.length === 0 ? (
        <p className="ha-body">I found nothing relevant in your documents.</p>
      ) : (
        clauses.map((c, i) => <Quote key={i} c={c} />)
      )}
      <p className="ha-disclaimer">{s.notice}</p>
    </section>
  );
}

function AgreementCard({ s }: { s: Structured }) {
  const a = s.agreement ?? {};
  const terms = arr<{ label: string; value: string; page: number | null }>(s.terms);
  return (
    <section className="ha-card">
      <h3 className="ha-asset">{a.title ?? a.party ?? "Agreement"}</h3>
      <p className="ha-muted">
        {a.party ? `${a.party}. ` : ""}
        {a.docName ? <Chip icon="file">{a.docName}</Chip> : null}
      </p>
      <dl className="ha-dl">
        {terms.map((t, i) => (
          <div key={i}>
            <dt>{t.label}</dt>
            <dd>
              {t.value}
              <span className="ha-muted"> ({pageNote(t.page)})</span>
            </dd>
          </div>
        ))}
      </dl>
      <p className="ha-muted">{s.datesConfirmed ? "Dates confirmed" : "Dates not confirmed yet"}</p>
    </section>
  );
}

function HistoryCard({ s }: { s: Structured }) {
  const ev = arr<{ id: string; ts: string; action: string; source: string }>(s.events);
  return (
    <section className="ha-card ha-card--compact">
      <h3 className="ha-title">
        <Icon name="wrench" size={24} /> <span>{`Service history: ${s.asset?.name}`}</span>
      </h3>
      {ev.length === 0 ? <p className="ha-body">No service logged yet.</p> : null}
      <ul className="ha-plain">
        {ev.map((e) => (
          <li key={e.id}>
            {fmtDate(e.ts.slice(0, 10), true)}: {e.action} <span className="ha-muted">({e.source})</span>
          </li>
        ))}
      </ul>
      {s.nextServiceDue ? (
        <p className="ha-body">
          Next: {s.nextServiceDue.label}, {fmtDate(s.nextServiceDue.date, true)}
        </p>
      ) : null}
    </section>
  );
}

function RecordAddedCard({ s }: { s: Structured }) {
  const obs = arr<{ id: string; dueDate: string; label: string }>(s.obligations);
  return (
    <section className="ha-card ha-card--compact">
      <h3 className="ha-title">
        <Icon name="check" size={24} /> <span>{s.created ? `Added ${s.name}` : `You already had ${s.name}`}</span>
      </h3>
      <ul className="ha-plain">
        {obs.map((o) => (
          <li key={o.id}>
            {fmtDate(o.dueDate, true)}: {o.label}
          </li>
        ))}
      </ul>
      {s.undoAvailable ? <p className="ha-muted">You can say "undo that" within 24 hours.</p> : null}
    </section>
  );
}

function ServiceLoggedCard({ s }: { s: Structured }) {
  return (
    <section className="ha-card ha-card--compact">
      <h3 className="ha-title">
        <Icon name="wrench" size={24} /> <span>{`Logged ${s.action} on ${s.assetName}`}</span>
      </h3>
      <p className="ha-body">Done on {fmtDate(s.date, true)}.</p>
      {s.nextServiceDue ? <p className="ha-body">Next service due {fmtDate(s.nextServiceDue, true)}.</p> : null}
      {s.undoAvailable ? <p className="ha-muted">You can say "undo that" within 24 hours.</p> : null}
    </section>
  );
}

function AmbiguousCard({ s, tool, args, rerun }: { s: Structured } & Pick<ResultViewProps, "tool" | "args" | "rerun">) {
  const key = THING_KEY[tool];
  return (
    <section className="ha-card ha-card--compact">
      <h3 className="ha-title">
        <Icon name="help" size={24} /> <span>{s.question}</span>
      </h3>
      <div className="ha-actions">
        {arr<{ id: string; label: string }>(s.options).map((o) => (
          <button
            key={o.id}
            type="button"
            className="ha-btn"
            disabled={!key}
            onClick={() => {
              if (key) rerun(tool, { ...args, [key]: o.label });
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
    </section>
  );
}
