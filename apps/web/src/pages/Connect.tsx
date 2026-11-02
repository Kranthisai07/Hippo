import { Inbox, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { ErrorState, useToast } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ASKED } from "../lib/gmail";

// The one time Gmail scan, step one: say plainly what will happen, then hand over to Google. Nothing is read until the
// person has pressed Connect and agreed on Google's own page.

const REFUSED: Record<string, string> = {
  declined: "Google did not give access, so nothing was read.",
  not_granted: "Reading your email was not allowed on Google's page, so nothing was read.",
  wrong_account: "That was a different Google account from the one you signed in with, so nothing was read.",
  failed: "We could not finish connecting to Google, so nothing was read. You can try again.",
  unavailable: "Connecting to Google is not available right now, so nothing was read.",
  too_soon: "You already looked through your email in the last day. You can scan again tomorrow.",
};

export function Connect() {
  const { me, refresh } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  useEffect(() => sessionStorage.setItem(ASKED, "1"), []);
  const reason = REFUSED[params.get("gmail") ?? ""];

  // Not switched on here: there is nothing to offer.
  if (me && (me.gmail === "off" || me.gmail === undefined)) return <Navigate to="/" replace />;

  async function notNow() {
    setBusy(true);
    try {
      await api.importDecline();
      await refresh();
      navigate("/", { replace: true });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not save that. Please try again.", "error");
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Find your subscriptions in Gmail</h1>
      {reason && <ErrorState message={reason} />}
      <section className="card stack" aria-labelledby="gm-what">
        <h2 id="gm-what" className="card-h">
          <Inbox size={20} aria-hidden="true" /> What happens
        </h2>
        <ul className="stack">
          <li>
            <strong>Hippo looks once.</strong> It searches your Gmail for subscription emails from the last two years:
            receipts, trials and renewals.
          </li>
          <li>
            <strong>It keeps the dates, not your inbox.</strong> For each subscription it finds, Hippo saves the text of
            that one email with numbers hidden, and the dates in it.
          </li>
          <li>
            <strong>Then it disconnects.</strong> When the scan ends, Hippo asks Google to end its access. It does not
            keep a way back in. To scan again you are asked again.
          </li>
        </ul>
      </section>
      <section className="card stack" aria-labelledby="gm-not">
        <h2 id="gm-not" className="card-h">
          <ShieldCheck size={20} aria-hidden="true" /> What Hippo never does
        </h2>
        <ul className="stack">
          <li>It never sends, deletes or changes an email. The access is read only.</li>
          <li>It never reads in the background or after the scan.</li>
          <li>It never opens attachments. Leases and manuals it spots are listed by name only.</li>
          <li>Nothing reminds you until you confirm a date yourself.</li>
        </ul>
        <p className="muted small">
          Hippo reads English emails with US dollar prices, so some subscriptions may be missed or only partly found.
          You can see and fix everything it found. Google will show a warning that the app is in testing; that is
          expected while Hippo is in its beta.
        </p>
      </section>
      <div className="row">
        <a className="btn btn-primary" href="/oauth/google/import/start">
          Connect Gmail
        </a>
        <button type="button" className="btn" onClick={() => void notNow()} disabled={busy}>
          Not now
        </button>
      </div>
    </>
  );
}
