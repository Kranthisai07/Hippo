import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ErrorState, Skeleton, useToast } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useLoad } from "../lib/useLoad";

const PHRASE = "delete all my data";

export function SettingsPage() {
  const toast = useToast();
  const { me, refresh } = useAuth();
  const docs = useLoad(() => api.listDocs(), []);
  const [digestOn, setDigestOn] = useState(true);
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [asking, setAsking] = useState<string | null>(null);
  const [removed, setRemoved] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [wiping, setWiping] = useState(false);

  useEffect(() => {
    if (me) {
      setDigestOn(me.digestOn);
      setEmail(me.email);
    }
  }, [me]);

  async function save() {
    setSaving(true);
    try {
      await api.putSettings({ digestOn, email: email.trim() });
      await refresh();
      toast("Settings saved.");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not save.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function removeDoc(id: string, name: string) {
    try {
      await api.deleteDoc(id);
      setAsking(null);
      setRemoved(
        `Deleted ${name}. Removed the file, its page text, the extracted fields, and the dates and reminders made from it.`,
      );
      docs.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not delete.", "error");
    }
  }

  async function wipe() {
    setWiping(true);
    try {
      await api.deleteAllData();
      setTyped("");
      setRemoved(
        "Deleted all your data: every document and file, page text, extracted fields, dates, reminders and things.",
      );
      docs.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not delete.", "error");
    } finally {
      setWiping(false);
    }
  }

  return (
    <>
      <h1>Settings</h1>

      <section className="card stack" aria-labelledby="digest-h">
        <h2 id="digest-h">Daily email</h2>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label className="row">
            <input type="checkbox" checked={digestOn} onChange={(e) => setDigestOn(e.target.checked)} />
            Send me a short email when something is due soon
          </label>
          <div>
            <label className="field-label" htmlFor="digest-email">
              Send it to
            </label>
            <input
              id="digest-email"
              type="email"
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              Save
            </button>
          </div>
        </form>
      </section>

      <section className="card stack" aria-labelledby="docs-h">
        <h2 id="docs-h">Your documents</h2>
        {removed && (
          <p className="banner banner-ok" role="status">
            {removed}
          </p>
        )}
        {docs.error ? (
          <ErrorState message={docs.error} onRetry={docs.reload} />
        ) : !docs.data ? (
          <Skeleton lines={3} label="Loading your documents" />
        ) : docs.data.docs.length === 0 ? (
          <p className="muted">
            You have no documents. <Link to="/upload">Upload one</Link> to get started.
          </p>
        ) : (
          <ul className="list">
            {docs.data.docs.map((d) => (
              <li key={d.id} className="row">
                <Link className="grow" to={`/review/${encodeURIComponent(d.id)}`}>
                  {d.filename}
                </Link>
                {asking === d.id ? (
                  <>
                    <span className="small">Delete this document and everything made from it?</span>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      onClick={() => void removeDoc(d.id, d.filename)}
                    >
                      Yes, delete
                    </button>
                    <button type="button" className="btn btn-sm" onClick={() => setAsking(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setAsking(d.id)}
                    aria-label={`Delete ${d.filename}`}
                  >
                    <Trash2 size={16} aria-hidden="true" /> Delete
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card stack" aria-labelledby="wipe-h">
        <h2 id="wipe-h">Delete all data</h2>
        <p className="muted">
          This removes every document and file, the page text, extracted fields, dates, reminders and things. It cannot
          be undone. You stay signed in.
        </p>
        <div>
          <label className="field-label" htmlFor="wipe-phrase">
            Type {PHRASE} to confirm
          </label>
          <input
            id="wipe-phrase"
            className="input"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div>
          <button
            type="button"
            className="btn btn-danger"
            disabled={typed !== PHRASE || wiping}
            onClick={() => void wipe()}
          >
            <Trash2 size={16} aria-hidden="true" /> Delete all my data
          </button>
        </div>
      </section>
    </>
  );
}
