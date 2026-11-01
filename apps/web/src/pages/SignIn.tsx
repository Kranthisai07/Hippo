import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router";
import { Brand, Footer } from "../components/Layout";
import { ApiError, api } from "../lib/api";
import { useAuth } from "../lib/auth";

export function SignIn() {
  const { status, refresh } = useAuth();
  const nav = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? "/";
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [waitUntil, setWaitUntil] = useState(0);
  const [, setNow] = useState(0);
  const [google, setGoogle] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);
  // A failure here only means no Google button, never a broken page.
  useEffect(() => {
    api.providers().then(
      (p) => setGoogle(p.google),
      () => undefined,
    );
  }, []);
  if (status === "in") return <Navigate to={from} replace />;

  const waiting = Date.now() < waitUntil;

  // A 429 is shown once. The buttons stay off until the wait is over; nothing retries on its own.
  function fail(e: unknown, demo = false) {
    if (e instanceof ApiError && e.status === 429 && e.retryAfter) {
      setWaitUntil(Date.now() + e.retryAfter * 1000);
      timer.current = window.setTimeout(() => setNow(Date.now()), e.retryAfter * 1000 + 50);
    }
    if (demo && e instanceof ApiError && e.status === 401) {
      return setError("The demo account only works when the server runs on this computer. Use your email instead.");
    }
    setError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
  }

  async function run(fn: () => Promise<void>, demo = false) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      fail(e, demo);
    } finally {
      setBusy(false);
    }
  }

  const finish = async () => {
    await refresh();
    nav(from, { replace: true });
  };

  return (
    <div className="page">
      <div className="signin">
        <aside className="signin-panel stack">
          <Brand />
          <p className="signin-lede">Your paperwork, turned into dates you can trust.</p>
          <ul className="signin-points">
            <li>Every date shows the exact words it came from.</li>
            <li>Nothing alerts you until you confirm it.</li>
            <li>Delete everything with one button, any time.</li>
          </ul>
          <Link to="/welcome" className="signin-about">
            What is Hippo?
          </Link>
        </aside>
        <div className="card stack signin-form">
          <h1>Sign in</h1>
          <p className="muted">Pick up where your documents left off.</p>

          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || waiting}
            onClick={() => void run(async () => (await api.demoSession(), await finish()), true)}
          >
            Use the demo account
          </button>

          {google && (
            <a className="btn" href={`/oauth/google/start?return=${encodeURIComponent(window.location.origin + from)}`}>
              Continue with Google
            </a>
          )}

          <p className="muted small">Or sign in with your email.</p>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                if (!sent) {
                  await api.magicCode(email.trim());
                  setSent(true);
                } else {
                  await api.session(email.trim(), code.trim());
                  await finish();
                }
              });
            }}
          >
            <div>
              <label className="field-label" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                className="input"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => (setEmail(e.target.value), setSent(false))}
              />
            </div>
            {sent && (
              <div>
                <label className="field-label" htmlFor="code">
                  Code from your email
                </label>
                <input
                  id="code"
                  className="input num"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
                <p className="muted small">In this demo build the code is printed in the server log.</p>
              </div>
            )}
            <button type="submit" className="btn" disabled={busy || waiting}>
              {sent ? "Sign in" : "Send me a code"}
            </button>
          </form>
          <div aria-live="assertive">
            {error && (
              <p role="alert" className="banner banner-error">
                {error}
              </p>
            )}
          </div>
        </div>
      </div>
      <Footer />
    </div>
  );
}
