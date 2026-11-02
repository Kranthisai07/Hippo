import { CalendarClock, CheckCircle2, FileSearch } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { EmptyState, ErrorState, Skeleton } from "../components/ui";
import { ApiError, api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { daysAwayText, humanize, plainAction, readableDate } from "../lib/format";
import { GROUP_LABEL, GROUPS, prioritize, type Row } from "../lib/prioritize";
import { inferToday } from "../lib/today";
import type { ImportView } from "../lib/types";
import { useLoad } from "../lib/useLoad";

// The one time Gmail scan, steps two and three: a calm waiting page that drives the scan in small steps, then the list.

const FAILED: Record<string, string> = {
  auth_ended: "Google ended the access before the scan finished. Nothing more was read.",
  expired: "The scan took too long and Google's access ran out. Nothing more was read.",
  failed: "Something went wrong while reading your email. Nothing more was read.",
};

export function ImportPage() {
  const [params] = useSearchParams();
  const jobParam = params.get("job");
  const { refresh, expire } = useAuth();
  const [view, setView] = useState<ImportView | null>(null);
  const [none, setNone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setError(null);
    (async () => {
      let v = jobParam ? await api.importView(jobParam) : (await api.importLatest()).import;
      if (!live) return;
      if (!v) return setNone(true);
      setView(v);
      // The browser drives the scan: each call does a small step, so a reload or a closed tab simply resumes it.
      while (live && !v.finished) {
        v = await api.importStep(v.id);
        if (live) setView(v);
      }
      if (live) await refresh();
    })().catch((e: unknown) => {
      if (!live) return;
      if (e instanceof ApiError && e.status === 401) return expire();
      setError(
        e instanceof ApiError && e.status === 404
          ? "We could not find that scan."
          : "We lost the connection. The scan can carry on from where it stopped.",
      );
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobParam, attempt]);

  async function cancel() {
    if (!view) return;
    try {
      setView(await api.importCancel(view.id));
    } catch {
      setError("We could not cancel just now. Please try again.");
    }
  }

  if (none) {
    return (
      <>
        <h1>Your Gmail scan</h1>
        <EmptyState icon={FileSearch} title="No scan yet">
          Hippo has not looked through your email.
        </EmptyState>
        <Link className="btn" to="/connect">
          Find subscriptions in Gmail
        </Link>
      </>
    );
  }
  if (error) {
    return (
      <>
        <h1>Your Gmail scan</h1>
        <ErrorState message={error} onRetry={() => setAttempt((n) => n + 1)} />
      </>
    );
  }
  if (!view) {
    return (
      <>
        <h1>Your Gmail scan</h1>
        <Skeleton lines={3} label="Loading your scan" />
      </>
    );
  }
  if (!view.finished) return <Waiting view={view} onCancel={() => void cancel()} />;
  if (view.status === "done") return <AllSet view={view} />;
  return (
    <>
      <h1>{view.status === "cancelled" ? "Scan stopped" : "The scan did not finish"}</h1>
      <p className={view.status === "cancelled" ? "banner" : "banner banner-error"} role="status">
        {view.status === "cancelled"
          ? "You stopped the scan. Hippo has ended its access to your Gmail."
          : (FAILED[view.error ?? ""] ?? FAILED.failed)}
      </p>
      <Found view={view} />
      <div className="row">
        <Link className="btn btn-primary" to="/">
          Go to Coming up
        </Link>
        <Link className="btn" to="/connect">
          Try again
        </Link>
      </div>
    </>
  );
}

function Waiting({ view, onCancel }: { view: ImportView; onCancel: () => void }) {
  const c = view.counts;
  return (
    <>
      <h1>Looking through your email</h1>
      <section className="card stack" aria-busy="true">
        {/* One polite live region, so a screen reader hears progress without being interrupted. */}
        <p role="status" aria-live="polite">
          {c.candidates === 0
            ? "Searching your Gmail for subscription emails..."
            : `Checked ${c.scanned} of ${c.candidates} emails. Found ${c.found} ${c.found === 1 ? "subscription" : "subscriptions"} so far.`}
        </p>
        {c.candidates > 0 && <progress max={c.candidates} value={c.scanned} aria-label="Emails checked" />}
        <p className="muted small">
          This can take a minute. You can leave this page open; if you close it, Hippo carries on when you come back
          within the hour.
        </p>
        <div>
          <button type="button" className="btn btn-sm" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </section>
    </>
  );
}

function Found({ view }: { view: ImportView }) {
  const c = view.counts;
  return (
    <p className="muted">
      Checked {c.scanned} {c.scanned === 1 ? "email" : "emails"}, found {c.found} new{" "}
      {c.found === 1 ? "subscription" : "subscriptions"}
      {c.duplicates > 0 && `, and ${c.duplicates} you already had`}.
    </p>
  );
}

function AllSet({ view }: { view: ImportView }) {
  const { me } = useAuth();
  const data = useLoad(async () => {
    const docs = await api.listDocs();
    const today = inferToday(me, docs.docs);
    const to = new Date(Date.parse(`${today}T00:00:00Z`) + 400 * 86_400_000).toISOString().slice(0, 10);
    const [subs, items] = await Promise.all([api.listSubscriptions(), api.listObligations(today, to)]);
    return { today, subs: subs.subscriptions, items: items.items };
  }, []);

  return (
    <>
      <h1>You are all set</h1>
      <section className="card stack">
        <h2 className="card-h">
          <CheckCircle2 size={20} aria-hidden="true" /> Hippo has finished looking
        </h2>
        <Found view={view} />
        {view.error === "cap" && (
          <p className="muted small">
            Hippo reached the most it reads in one scan, newest emails first. Scan again tomorrow to look further back.
          </p>
        )}
        <p className="small">
          {view.revoked
            ? "Hippo's access to your Gmail has ended."
            : "Hippo asked Google to end its access. To be sure, you can remove it at myaccount.google.com/permissions."}{" "}
          <strong>Nothing reminds you until you confirm a date.</strong>
        </p>
      </section>

      {data.error ? (
        <ErrorState message={data.error} onRetry={data.reload} />
      ) : !data.data ? (
        <Skeleton variant="rows" lines={3} label="Loading your subscriptions" />
      ) : data.data.subs.length === 0 ? (
        <EmptyState icon={CalendarClock} title="No subscriptions found">
          Hippo did not find a subscription email it could read. It reads English emails with US dollar prices, so some
          are missed. You can save a billing page with the Chrome extension instead.
        </EmptyState>
      ) : (
        <Groups today={data.data.today} groups={prioritize(data.data.subs, data.data.items, data.data.today)} />
      )}

      {view.spotted.length > 0 && (
        <section className="card stack" aria-labelledby="spotted-h">
          <h2 id="spotted-h" className="card-h">
            <FileSearch size={20} aria-hidden="true" /> Documents Hippo spotted but cannot read yet
          </h2>
          <p className="muted small">
            These emails look like leases, warranties, manuals or policies. Hippo did not open them or their
            attachments. Reading them is planned.
          </p>
          <ul className="list">
            {view.spotted.map((s, i) => (
              <li key={i}>
                <strong>{humanize(s.kind)}</strong>: {s.subject || "No subject"}
                <span className="muted small">
                  {" "}
                  from {s.sender}
                  {s.date && `, ${readableDate(s.date)}`}
                  {s.filename && `, ${s.filename}`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div>
        <Link className="btn btn-primary" to="/">
          Go to Coming up
        </Link>
      </div>
    </>
  );
}

function Groups({ today, groups }: { today: string; groups: ReturnType<typeof prioritize> }) {
  return (
    <>
      {GROUPS.filter((g) => groups[g].length > 0).map((g) => (
        <section key={g} aria-labelledby={`grp-${g}`} className="stack">
          <h2 id={`grp-${g}`}>{GROUP_LABEL[g]}</h2>
          <ul className="list">
            {groups[g].map((r) => (
              <SubRow key={r.sub.agreementId} row={r} today={today} />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

function SubRow({ row, today }: { row: Row; today: string }) {
  const { sub, key } = row;
  const price =
    sub.amount === null ? null : `$${sub.amount.toFixed(2)}${sub.cycle ? ` ${humanize(sub.cycle).toLowerCase()}` : ""}`;
  return (
    <li className="card stack">
      <div className="row">
        <div className="grow">
          <h3>{sub.vendor}</h3>
          <p className="muted small">{[sub.plan, price].filter(Boolean).join(", ") || "Price not found"}</p>
          <p>
            {key ? (
              <>
                {plainAction(key.type, readableDate(key.date))}, <strong>{daysAwayText(today, key.date)}</strong>
              </>
            ) : (
              "No upcoming date found in the email."
            )}
          </p>
          {sub.source && (
            <p className="muted small">
              From email &ldquo;{sub.source.docName}&rdquo;
              {sub.source.page !== null && `, page ${sub.source.page}`}
            </p>
          )}
        </div>
        {sub.confirmed ? (
          <span className="chip chip-ok">Confirmed</span>
        ) : sub.docId ? (
          <Link to={`/review/${encodeURIComponent(sub.docId)}`} className="btn btn-sm">
            Review and confirm
          </Link>
        ) : (
          <span className="chip chip-warn">To review</span>
        )}
      </div>
    </li>
  );
}
