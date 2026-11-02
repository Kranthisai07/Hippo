import { useCallback, useEffect, useState } from "react";
import { listSubscriptions, savePage, SignedOut, type SaveResult, type Subscription } from "./api";
import { WEB_ORIGIN } from "./config";
import { ask } from "./messages";
import { readActivePage, type PageRead } from "./page";

const open = (path: string) => void chrome.tabs.create({ url: `${WEB_ORIGIN}${path}` });

const price = (s: Subscription): string =>
  s.amount === null ? "price not found" : `$${s.amount.toFixed(2)}${s.cycle ? ` ${s.cycle}` : ""}`;

const chargeDate = (iso: string): string =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  });

/** Soonest charge first. A subscription with no date yet goes last. */
const byNextCharge = (a: Subscription, b: Subscription): number =>
  (a.nextChargeDate ?? "9999").localeCompare(b.nextChargeDate ?? "9999");

/** The toolbar badge counts what waits for review. It is set only while the popup is open, never in the background. */
const showBadge = (subs: Subscription[]): void => {
  const waiting = subs.filter((s) => !s.confirmed).length;
  void chrome.action?.setBadgeText({ text: waiting ? String(waiting) : "" });
  if (waiting) void chrome.action?.setBadgeBackgroundColor({ color: "#a1261c" });
};

function Logo({ className = "logo" }: { className?: string }) {
  return <img className={className} src="icons/logo.svg" alt="" />;
}

function ReviewButton({ path }: { path: string }) {
  return (
    <button type="button" onClick={() => open(path)}>
      Review and confirm
    </button>
  );
}

function Outcome({ result }: { result: SaveResult }) {
  if (result.kind === "none") return <p role="status">Hippo found no subscription here. Nothing was saved.</p>;
  if (result.kind === "duplicate") {
    return (
      <div role="status" className="card">
        <p>{result.message}</p>
        {result.reviewUrl && <ReviewButton path={result.reviewUrl} />}
      </div>
    );
  }
  return (
    <div role="status" className="card">
      <p>Saved. No reminder starts until you confirm the dates.</p>
      <ReviewButton path={result.reviewUrl} />
    </div>
  );
}

function Row({ s }: { s: Subscription }) {
  return (
    <li className="row">
      <div className="row-head">
        <span className="strong">{s.vendor}</span>
        <span className={s.confirmed ? "tag ok" : "tag review"}>{s.confirmed ? "confirmed" : "to review"}</span>
      </div>
      <div className="row-foot">
        <span className="muted">
          {price(s)}
          {s.nextChargeDate && ` · next ${chargeDate(s.nextChargeDate)}`}
        </span>
        {!s.confirmed && s.docId && (
          <button
            type="button"
            className="ghost"
            aria-label={`Review ${s.vendor}`}
            onClick={() => open(`/review/${s.docId}`)}
          >
            Review
          </button>
        )}
      </div>
      {s.source && (
        <span className="source muted">
          From {s.source.docName}
          {s.source.page !== null && `, page ${s.source.page}`}
        </span>
      )}
    </li>
  );
}

export function Popup() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [page, setPage] = useState<PageRead | null>(null);
  const [list, setList] = useState<{ subscriptions: Subscription[]; monthlyTotal: number } | null>(null);
  const [result, setResult] = useState<SaveResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      if (e instanceof SignedOut) setSignedIn(false);
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }, []);

  const refreshList = useCallback(async () => {
    const next = await listSubscriptions();
    setList({ ...next, subscriptions: [...next.subscriptions].sort(byNextCharge) });
    showBadge(next.subscriptions);
  }, []);

  useEffect(() => {
    void run(async () => {
      const { signedIn: yes } = await ask({ type: "status" });
      setSignedIn(yes);
      setPage(await readActivePage());
      if (yes) await refreshList();
    });
  }, [run, refreshList]);

  if (signedIn === null) {
    return (
      <main aria-busy="true">
        <header className="top">
          <Logo />
          <h1>Hippo</h1>
        </header>
        <span className="sr">Loading</span>
        <div className="skeleton" />
        <div className="skeleton" />
      </main>
    );
  }

  if (!signedIn) {
    return (
      <main>
        <div className="hello">
          <Logo />
          <h1>Hippo</h1>
          <p className="muted">Sign in to save subscription pages. Nothing leaves your browser until you press Save.</p>
          {error && <p role="alert">{error}</p>}
          <button
            type="button"
            disabled={busy}
            aria-busy={busy}
            onClick={() =>
              void run(async () => {
                await ask({ type: "signIn" });
                setSignedIn(true);
                await refreshList();
              })
            }
          >
            Sign in
          </button>
        </div>
      </main>
    );
  }

  return (
    <main>
      <header className="top">
        <Logo />
        <h1>Hippo</h1>
        <span className="status">
          <span className="dot" aria-hidden="true" />
          Signed in
        </span>
        <button type="button" className="ghost open" onClick={() => open("/")}>
          Open Hippo
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M7 17 17 7M8 7h9v9" />
          </svg>
        </button>
      </header>
      {error && <p role="alert">{error}</p>}
      {page ? (
        <section className="card" aria-label="This page">
          <div className="page-head">
            <span className="tile" aria-hidden="true">
              {page.host.charAt(0)}
            </span>
            <div>
              <p className="host">{page.host}</p>
              <p className="muted">This page</p>
            </div>
          </div>
          {!result && (
            <p className="muted">
              Press Save to send the {page.text.length.toLocaleString()} characters of visible text on this page. Long
              numbers are masked first.
            </p>
          )}
          {result ? (
            <Outcome result={result} />
          ) : (
            <button
              type="button"
              disabled={busy}
              aria-busy={busy}
              onClick={() =>
                void run(async () => {
                  setResult(await savePage(page));
                  await refreshList();
                })
              }
            >
              Save
            </button>
          )}
        </section>
      ) : (
        <section className="card empty" aria-label="This page">
          <svg
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            aria-hidden="true"
          >
            <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z M14 3v5h5 M9 14h6 M9 17h4" />
          </svg>
          <p>This page cannot be read. Open a billing page or a receipt and try again.</p>
        </section>
      )}
      {list ? (
        <section aria-label="Your subscriptions">
          <p className="label">Subscriptions</p>
          <h2 className="total">${list.monthlyTotal.toFixed(2)} a month confirmed</h2>
          {list.subscriptions.length === 0 ? (
            <p className="empty">Nothing tracked yet. Save a billing page to start.</p>
          ) : (
            <ul>
              {list.subscriptions.map((s) => (
                <Row key={s.agreementId} s={s} />
              ))}
            </ul>
          )}
        </section>
      ) : (
        busy && <div className="skeleton" aria-hidden="true" />
      )}
      <button
        type="button"
        className="quiet"
        onClick={() =>
          void run(async () => {
            await ask({ type: "signOut" });
            setSignedIn(false);
            setList(null);
            void chrome.action?.setBadgeText({ text: "" });
          })
        }
      >
        Sign out
      </button>
    </main>
  );
}
