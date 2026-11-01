import { Check, CheckCircle2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router";
import googleG from "../assets/google-g.svg";
import { Brand, Footer } from "../components/Layout";
import { ApiError, api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { HOSTED } from "../lib/hosted";

const POINTS = [
  "Every date shows the exact words it came from.",
  "Nothing alerts you until you confirm it.",
  "Delete everything with one button, any time.",
];

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
  const codeInput = useRef<HTMLInputElement>(null);

  useEffect(() => () => window.clearTimeout(timer.current), []);
  // A failure here only means no Google button, never a broken page.
  useEffect(() => {
    api.providers().then(
      (p) => setGoogle(p.google),
      () => undefined,
    );
  }, []);
  // On the code step the cursor goes straight to the code field.
  useEffect(() => {
    if (sent) codeInput.current?.focus();
  }, [sent]);
  if (status === "in") return <Navigate to={from} replace />;

  const waiting = Date.now() < waitUntil;
  const off = busy || waiting;

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

  const submit = (e: React.FormEvent) => {
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
  };

  return (
    <div className="page">
      <div className="signin">
        <aside className="signin-panel stack">
          <Brand />
          <p className="signin-lede">Your paperwork, turned into dates you can trust.</p>
          <ul className="signin-points">
            {POINTS.map((t) => (
              <li key={t}>
                <Check size={18} strokeWidth={2.25} aria-hidden="true" />
                <span>{t}</span>
              </li>
            ))}
          </ul>
          <Link to="/welcome" className="signin-about">
            What is Hippo?
          </Link>
        </aside>
        <div className="signin-col">
          <div className="signin-form stack">
            {sent ? (
              <>
                <div>
                  <h1>Enter your code</h1>
                  <p className="muted signin-sub">
                    We sent a code to <strong>{email.trim()}</strong>.
                  </p>
                </div>
                <p className="banner banner-ok" role="status">
                  <CheckCircle2 size={20} aria-hidden="true" />
                  <span>Code sent. It can take a minute to arrive.</span>
                </p>
              </>
            ) : (
              <div>
                <h1>Sign in</h1>
                <p className="muted signin-sub">Pick up where your documents left off.</p>
              </div>
            )}

            {!sent && google && (
              <>
                <a
                  className="btn btn-block"
                  href={`/oauth/google/start?return=${encodeURIComponent(window.location.origin + from)}`}
                >
                  <img src={googleG} alt="" width="20" height="20" />
                  Continue with Google
                </a>
                <p className="signin-or" aria-hidden="true">
                  or
                </p>
              </>
            )}

            <form className="stack" onSubmit={submit}>
              {sent ? (
                <div>
                  <label className="field-label" htmlFor="code">
                    Code from your email
                  </label>
                  <input
                    id="code"
                    ref={codeInput}
                    className="input num signin-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={12}
                    required
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                  {!HOSTED && (
                    <p className="muted small signin-hint">In this demo build the code is printed in the server log.</p>
                  )}
                </div>
              ) : (
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
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
              )}
              <button type="submit" className="btn btn-primary btn-block" disabled={off}>
                {sent ? "Sign in" : "Send me a code"}
              </button>
            </form>

            {sent && (
              <div className="signin-quiet">
                <button
                  type="button"
                  className="btn btn-quiet btn-block"
                  disabled={off}
                  onClick={() => void run(async () => (await api.magicCode(email.trim()), setCode("")))}
                >
                  Send a new code
                </button>
                <button
                  type="button"
                  className="btn btn-quiet btn-block"
                  onClick={() => (setSent(false), setCode(""), setError(null))}
                >
                  Use a different email
                </button>
              </div>
            )}

            <div aria-live="assertive">
              {error && (
                <p role="alert" className="banner banner-error">
                  {error}
                </p>
              )}
            </div>

            {!sent && !HOSTED && (
              <div className="signin-demo">
                <button
                  type="button"
                  className="btn btn-quiet"
                  disabled={off}
                  onClick={() => void run(async () => (await api.demoSession(), await finish()), true)}
                >
                  Use the demo account
                  <span className="tag" aria-hidden="true">
                    Demo
                  </span>
                </button>
              </div>
            )}
          </div>
          <Footer />
        </div>
      </div>
    </div>
  );
}
