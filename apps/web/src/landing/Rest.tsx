import { ArrowRight, FileCheck2, FilePlus2, Hash, KeyRound, Mail, Puzzle, Trash2 } from "lucide-react";
import { Link } from "react-router";
import { DemoLink, HOSTED, REPO_URL } from "./DemoLink";

const rules = [
  {
    icon: FileCheck2,
    h: "No alert from an unconfirmed date",
    p: "A date a model read is only a suggestion until you confirm it.",
  },
  { icon: Hash, h: "Numbers masked to the last 4", p: "Policy and account numbers never show in full." },
  { icon: Trash2, h: "Delete everything in one click", p: "Documents, dates and alerts, gone together." },
  {
    icon: KeyRound,
    h: "Documents are untrusted data",
    p: "Text inside a document is read as content, never followed as an instruction.",
  },
];

export function Trust() {
  return (
    <section className="lp-trust" aria-labelledby="trust-h">
      <div className="lp-wrap">
        <h2 id="trust-h">Four rules Hippo follows</h2>
        <ul className="lp-rules">
          {rules.map(({ icon: Icon, h, p }) => (
            <li key={h}>
              <span className="lp-tile">
                <Icon size={26} strokeWidth={1.75} aria-hidden="true" />
              </span>
              <h3>{h}</h3>
              <p>{p}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function Planned() {
  return (
    <section id="planned" className="lp-wrap lp-planned" aria-labelledby="planned-h">
      <p className="lp-eyebrow">Planned, not built yet</p>
      <h2 id="planned-h">Planned: a Chrome extension</h2>
      <p className="lp-lead">
        Save a file from any page and get a reminder by email when it matters. This is on the roadmap. Today, Hippo
        works through the web app and an Alexa+ style voice demo.
      </p>
      <div className="lp-browser" aria-hidden="true">
        <div className="lp-browser-bar">
          <span className="lp-browser-url">Any page</span>
          <span className="lp-browser-ext">
            <Puzzle size={18} strokeWidth={1.75} />
          </span>
        </div>
        <div className="lp-browser-menu">
          <span>
            <FilePlus2 size={18} strokeWidth={1.75} />
            Save to Hippo
          </span>
          <span>
            <Mail size={18} strokeWidth={1.75} />
            Reminder by email
          </span>
        </div>
      </div>
    </section>
  );
}

export function Closing() {
  return (
    <section className="lp-closing" aria-labelledby="close-h">
      <h2 id="close-h">Give your paperwork a memory</h2>
      <p className="lp-lead">Upload one document and see the first date it finds.</p>
      <DemoLink
        className="lp-btn lp-btn-lg"
        label="Try the demo"
        icon={<ArrowRight size={18} strokeWidth={1.75} aria-hidden="true" />}
      />
    </section>
  );
}

export function Footer() {
  return (
    <footer className="lp-footer">
      <div className="lp-wrap lp-footer-in">
        <span className="lp-brand-plain">Hippo</span>
        <nav aria-label="Footer">
          <Link to="/privacy">Privacy</Link>
          <Link to="/terms">Terms</Link>
          {HOSTED ? <a href={REPO_URL}>Source</a> : <Link to="/signin">Sign in</Link>}
        </nav>
      </div>
    </footer>
  );
}
