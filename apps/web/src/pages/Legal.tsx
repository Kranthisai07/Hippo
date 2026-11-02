import { Link } from "react-router";
import { Brand, Footer } from "../components/Layout";

const PRIVACY: [string, string][] = [
  [
    "What Hippo keeps",
    "The documents you upload, the dates and terms read from them with the exact quote and page each came from, whether you confirmed each one, the things and subscriptions built from them, your settings, and the email address you sign in with. It is kept for your household and is only shown to you. Hippo is still a prototype: the public demo keeps everything in memory and forgets it when the server restarts, so do not put real documents in it.",
  ],
  [
    "The browser extension",
    "The extension reads a page only after you click its button, and only that tab. It reads the visible text, the page title and the site name, never form values, never the full page address (only the site name) and never anything in the background. Nothing is sent until you press Save, and the popup tells you how much text will be sent. Long numbers are masked in your browser before they are sent.",
  ],
  [
    "Signing in",
    "You sign in with a code sent to your email, or with Google. Google only tells Hippo which email address you control. Hippo asks Google for nothing else.",
  ],
  [
    "What Hippo does not do",
    "It does not read your email or your bank. It only knows what you upload, tell it, or save yourself with the extension. It does not sell your data and does not use it for advertising.",
  ],
  ["Numbers", "Policy and account numbers are shown with only the last 4 digits."],
  ["Logs", "Hippo is built so the text of your documents is not written to its logs."],
  [
    "Email",
    "If you turn on the daily email, it names what is due soon and links back here. It never includes a full policy or account number.",
  ],
  [
    "Deleting",
    "Delete a document and its file, page text, fields, dates and reminders go with it. Delete all data removes everything for your household.",
  ],
];

const TERMS: [string, string][] = [
  [
    "What this is",
    "Hippo helps you keep track of dates and terms in your own paperwork. It reads documents with software, so it can be wrong. Check each value against the quote and page before you confirm it.",
  ],
  ["Reminders", "Hippo only reminds you about dates you have confirmed."],
  [
    "Not advice",
    "Hippo is not legal or insurance advice. For a claim, a lease dispute or a cancellation, check the original document and talk to the company or a professional.",
  ],
  ["Your content", "Your documents stay yours. You can delete them at any time."],
];

export function Legal({ which }: { which: "privacy" | "terms" }) {
  const rows = which === "privacy" ? PRIVACY : TERMS;
  return (
    <div className="page">
      <Brand />
      <h1>{which === "privacy" ? "Privacy" : "Terms"}</h1>
      {rows.map(([h, t]) => (
        <section key={h} className="stack">
          <h2>{h}</h2>
          <p>{t}</p>
        </section>
      ))}
      <p>
        <Link to="/">Back to Hippo</Link>
      </p>
      <Footer />
    </div>
  );
}
