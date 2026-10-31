import { CreditCard, Upload } from "lucide-react";
import { Link } from "react-router";
import { EmptyState, ErrorState, Skeleton } from "../components/ui";
import { api } from "../lib/api";
import { humanize } from "../lib/format";
import { useLoad } from "../lib/useLoad";
import type { Subscription } from "../lib/types";

const price = (s: Subscription): string =>
  s.amount === null
    ? "Price not found"
    : `$${s.amount.toFixed(2)}${s.cycle ? ` ${humanize(s.cycle).toLowerCase()}` : ""}`;

export function Subscriptions() {
  const { data, error, loading, reload } = useLoad(() => api.listSubscriptions(), []);
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !data) {
    return (
      <>
        <h1>Subscriptions</h1>
        <Skeleton variant="tiles" lines={3} label="Loading your subscriptions" />
      </>
    );
  }
  const waiting = data.subscriptions.filter((s) => !s.confirmed).length;
  return (
    <>
      <h1>Subscriptions</h1>
      <p className="muted">
        <span className="num">${data.monthlyTotal.toFixed(2)}</span> a month from what you have confirmed.
        {waiting > 0 && ` ${waiting} more to review, not counted yet.`}
      </p>
      {data.subscriptions.length === 0 ? (
        <EmptyState
          icon={CreditCard}
          title="No subscriptions yet"
          action={
            <Link to="/upload" className="btn btn-primary">
              <Upload size={18} aria-hidden="true" /> Upload a document
            </Link>
          }
        >
          Upload a subscription confirmation, or tell Alexa about one, and it shows up here.
        </EmptyState>
      ) : (
        <ul className="list">
          {data.subscriptions.map((s) => (
            <li key={s.agreementId} className="card stack">
              <div className="row">
                <div className="grow">
                  <h2>{s.vendor}</h2>
                  <p className="muted small">
                    {[s.plan, price(s), s.nextChargeDate && `next charge ${s.nextChargeDate}`]
                      .filter(Boolean)
                      .join(", ")}
                  </p>
                  {s.source && s.docId && (
                    <p className="muted small">
                      From <Link to={`/review/${encodeURIComponent(s.docId)}`}>{s.source.docName}</Link>
                      {s.source.page !== null && `, page ${s.source.page}`}
                    </p>
                  )}
                </div>
                {s.confirmed ? (
                  <span className="chip chip-ok">Confirmed</span>
                ) : s.docId ? (
                  <Link to={`/review/${encodeURIComponent(s.docId)}`} className="chip chip-warn">
                    Review
                  </Link>
                ) : (
                  <span className="chip chip-warn">Not confirmed</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
