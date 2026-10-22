import { AlertTriangle, CalendarCheck, CircleHelp, FileText, ShieldAlert, Upload } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { EmptyState, ErrorState, Skeleton, useToast } from "../components/ui";
import { api } from "../lib/api";
import { KIND_LABEL, addDays, chipParts, daysAwayText, plainAction } from "../lib/format";
import { buildTimeline, groupByWeek, type Entry } from "../lib/timeline";
import { inferToday } from "../lib/today";
import { useAuth } from "../lib/auth";
import { useLoad } from "../lib/useLoad";
import type { AlertAction, Doc, ObligationType } from "../lib/types";

const WINDOWS = [30, 90, 365] as const;

function Severity({ s }: { s: "high" | "possible" | null }) {
  if (s === "high")
    return (
      <span className="chip chip-urgent">
        <AlertTriangle size={14} aria-hidden="true" />
        High
      </span>
    );
  if (s === "possible")
    return (
      <span className="chip chip-warn">
        <CircleHelp size={14} aria-hidden="true" />
        Possible
      </span>
    );
  return null;
}

function EntryCard({
  e,
  today,
  docs,
  assetNames,
  onResolve,
}: {
  e: Entry;
  today: string;
  docs: Map<string, Doc>;
  assetNames: Map<string, string>;
  onResolve: (id: string, a: AlertAction) => void;
}) {
  const recall = e.type === "recall";
  const asset = e.assetId ? assetNames.get(e.assetId) : undefined;
  const doc = e.docId ? docs.get(e.docId) : undefined;
  const parts = e.date ? chipParts(e.date) : null;
  // A recall never claims certainty. The label from the server is shown as text underneath.
  const title = recall
    ? `Recall that may affect ${asset ?? "something you own"}`
    : e.date
      ? plainAction(e.type as ObligationType, e.date, e.label)
      : e.label;
  return (
    <li
      className={`item ${e.confirmed ? "" : "item-unconfirmed"}`}
      data-testid={e.confirmed ? "confirmed-item" : "unconfirmed-item"}
      data-severity={e.confirmed ? (e.severity ?? "none") : "unconfirmed"}
    >
      <div className="date-block" aria-hidden="true">
        {parts ? (
          <>
            <span className="d num">{parts.day}</span>
            <span className="m">{parts.month}</span>
          </>
        ) : (
          <span className="m">No date</span>
        )}
      </div>
      <div className="stack">
        <div className="row">
          <h3 className="item-title">{title}</h3>
        </div>
        <p className="muted">{e.label}</p>
        {e.detail && <p className="muted small">{e.detail}</p>}
        <div className="row">
          {e.confirmed ? (
            <Severity s={e.severity} />
          ) : (
            <span className="chip chip-warn">
              <CircleHelp size={14} aria-hidden="true" />
              Not confirmed
            </span>
          )}
          {e.date && <span className="chip num">{daysAwayText(today, e.date)}</span>}
          <span className="chip">{KIND_LABEL[e.type]}</span>
          {doc && e.docId && (
            <Link to={`/review/${encodeURIComponent(e.docId)}`} className="small">
              <FileText size={14} aria-hidden="true" /> Source: {doc.filename}
            </Link>
          )}
          {!e.confirmed && e.docId && (
            <Link to={`/review/${encodeURIComponent(e.docId)}`} className="btn btn-sm btn-primary">
              Review and confirm
            </Link>
          )}
        </div>
        {e.alert && (
          <div className="row" role="group" aria-label="What to do with this reminder">
            <button type="button" className="btn btn-sm" onClick={() => onResolve(e.alert!.id, "done")}>
              Done
            </button>
            <button type="button" className="btn btn-sm" onClick={() => onResolve(e.alert!.id, "snooze_7d")}>
              Remind me in 7 days
            </button>
            <button type="button" className="btn btn-sm" onClick={() => onResolve(e.alert!.id, "dismiss")}>
              Dismiss
            </button>
            {recall && (
              <button type="button" className="btn btn-sm" onClick={() => onResolve(e.alert!.id, "not_mine")}>
                Not mine
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

export function ComingUp() {
  const [days, setDays] = useState<(typeof WINDOWS)[number]>(90);
  const [kind, setKind] = useState<string | null>(null);
  const toast = useToast();
  const { me } = useAuth();

  const { data, error, loading, reload } = useLoad(async () => {
    const [docs, alerts, assets] = await Promise.all([api.listDocs(), api.listAlerts(true), api.listAssets()]);
    const today = inferToday(me, docs.docs);
    const items = await api.listObligations(today, addDays(today, days));
    return { docs: docs.docs, alerts: alerts.alerts, assets: assets.assets, items: items.items, today };
  }, [days]);

  async function resolve(id: string, action: AlertAction) {
    try {
      await api.resolveAlert(id, action);
      toast(
        action === "done"
          ? "Marked done."
          : action === "dismiss"
            ? "Dismissed."
            : action === "snooze_7d"
              ? "Snoozed for 7 days."
              : "Got it. It will not come back for this item.",
      );
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "That did not work.", "error");
    }
  }

  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) {
    return (
      <>
        <h1>Coming up</h1>
        <Skeleton variant="tickets" lines={4} label="Loading what is coming up" />
      </>
    );
  }

  const { today } = data;
  const docMap = new Map(data.docs.map((d) => [d.id, d]));
  const assetNames = new Map(data.assets.map((a) => [a.id, a.name]));
  const all = buildTimeline(data.items, data.alerts);
  const kinds = [...new Set([...all.confirmed, ...all.unconfirmed].map((e) => e.type))];
  const keep = (e: Entry) => kind === null || e.type === kind;
  const confirmed = all.confirmed.filter(keep);
  const unconfirmed = all.unconfirmed.filter(keep).sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  const soon = all.confirmed.filter((e) => e.date && e.date <= addDays(today, 30)).length;

  const sentence =
    all.confirmed.length === 0 && all.unconfirmed.length === 0
      ? "Nothing is coming up yet."
      : soon > 0
        ? `${soon} ${soon === 1 ? "thing needs" : "things need"} you in the next 30 days.`
        : "Nothing needs you in the next 30 days.";

  return (
    <>
      <div className="hero">
        <h1>Coming up</h1>
        <p aria-live="polite" data-testid="hero-sentence">
          {sentence}
          {all.unconfirmed.length > 0 &&
            ` ${all.unconfirmed.length} ${all.unconfirmed.length === 1 ? "date is" : "dates are"} waiting for you to confirm.`}
        </p>
        <p className="muted small num">Today is {today}.</p>
      </div>

      <div className="toolbar">
        <div className="filters" role="group" aria-label="Filter by kind">
          <button type="button" className="pill" aria-pressed={kind === null} onClick={() => setKind(null)}>
            All
          </button>
          {kinds.map((k) => (
            <button
              key={k}
              type="button"
              className="pill"
              aria-pressed={kind === k}
              onClick={() => setKind(kind === k ? null : k)}
            >
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
        <div className="filters" role="group" aria-label="How far ahead">
          {WINDOWS.map((w) => (
            <button key={w} type="button" className="pill" aria-pressed={days === w} onClick={() => setDays(w)}>
              {w} days
            </button>
          ))}
        </div>
      </div>

      {loading && <Skeleton variant="tickets" lines={1} label="Updating" />}

      {confirmed.length === 0 && unconfirmed.length === 0 && !loading && (
        <EmptyState
          icon={CalendarCheck}
          title={`Nothing coming up in the next ${days} days`}
          action={
            <Link to="/upload" className="btn btn-primary">
              <Upload size={18} aria-hidden="true" /> Upload a document
            </Link>
          }
        >
          Upload your lease, a warranty, an insurance policy or a subscription to see when to act.
        </EmptyState>
      )}

      {groupByWeek(confirmed, today).map((g) => (
        <section key={g.title} className="week" aria-label={g.title}>
          <h2>{g.title}</h2>
          <ul className="list">
            {g.entries.map((e) => (
              <EntryCard
                key={e.key}
                e={e}
                today={today}
                docs={docMap}
                assetNames={assetNames}
                onResolve={(id, a) => void resolve(id, a)}
              />
            ))}
          </ul>
        </section>
      ))}

      {unconfirmed.length > 0 && (
        <section className="week" aria-labelledby="needs-you">
          <h2 id="needs-you">Needs your confirmation</h2>
          <p className="banner">
            <ShieldAlert size={20} aria-hidden="true" />
            Nothing alerts you until you confirm a date.
          </p>
          <ul className="list">
            {unconfirmed.map((e) => (
              <EntryCard
                key={e.key}
                e={e}
                today={today}
                docs={docMap}
                assetNames={assetNames}
                onResolve={() => undefined}
              />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
