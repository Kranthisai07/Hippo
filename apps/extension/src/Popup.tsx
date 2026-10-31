import { useCallback, useEffect, useState } from "react";
import { listSubscriptions, savePage, SignedOut, type SaveResult, type Subscription } from "./api";
import { WEB_ORIGIN } from "./config";
import { ask } from "./messages";
import { readActivePage, type PageRead } from "./page";

const open = (path: string) => void chrome.tabs.create({ url: `${WEB_ORIGIN}${path}` });

const price = (s: Subscription): string =>
  s.amount === null ? "price not found" : `$${s.amount.toFixed(2)}${s.cycle ? ` ${s.cycle}` : ""}`;

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
      <div role="status">
        <p>{result.message}</p>
        {result.reviewUrl && <ReviewButton path={result.reviewUrl} />}
      </div>
    );
  }
  return (
    <div role="status">
      <p>Saved. No reminder starts until you confirm the dates.</p>
      <ReviewButton path={result.reviewUrl} />
    </div>
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

  const refreshList = useCallback(async () => setList(await listSubscriptions()), []);

  useEffect(() => {
    void run(async () => {
      const { signedIn: yes } = await ask({ type: "status" });
      setSignedIn(yes);
      setPage(await readActivePage());
      if (yes) await refreshList();
    });
  }, [run, refreshList]);

  if (signedIn === null) return <main aria-busy="true">Loading</main>;

  if (!signedIn) {
    return (
      <main>
        <h1>Hippo</h1>
        <p>Sign in to save subscription pages.</p>
        {error && <p role="alert">{error}</p>}
        <button
          type="button"
          disabled={busy}
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
      </main>
    );
  }

  return (
    <main>
      <h1>Hippo</h1>
      {error && <p role="alert">{error}</p>}
      {page ? (
        <section aria-label="This page">
          <p className="strong">{page.host}</p>
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
        <p className="muted">This page cannot be read. Open a billing page or a receipt and try again.</p>
      )}
      {list && (
        <section aria-label="Your subscriptions">
          <h2>${list.monthlyTotal.toFixed(2)} a month confirmed</h2>
          <ul>
            {list.subscriptions.map((s) => (
              <li key={s.agreementId}>
                <span className="strong">{s.vendor}</span> <span className="muted">{price(s)}</span>
                {!s.confirmed && <span className="tag">to review</span>}
                {s.source && (
                  <span className="source muted">
                    From {s.source.docName}
                    {s.source.page !== null && `, page ${s.source.page}`}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <button
        type="button"
        className="link"
        onClick={() =>
          void run(async () => {
            await ask({ type: "signOut" });
            setSignedIn(false);
            setList(null);
          })
        }
      >
        Sign out
      </button>
    </main>
  );
}
