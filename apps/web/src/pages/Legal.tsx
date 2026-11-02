import { Link } from "react-router";
import { Brand, Footer } from "../components/Layout";

const PRIVACY: [string, string][] = [
  [
    "What Hippo keeps",
    "The documents you upload, the dates and terms read from them with the exact quote and page each came from, whether you confirmed each one, the things and subscriptions built from them, your settings, and the email address you sign in with. It is kept for your household and is only shown to you. In the hosted Hippo that data is stored with Cloudflare, our hosting provider, and with no one else. Hippo is still a prototype: the public demo keeps everything in memory and forgets it when the server restarts, so do not put real documents in it.",
  ],
  [
    "The browser extension",
    "The extension reads a page only after you click its button, and only that tab. It reads the visible text, the page title and the site name, never form values, never the full page address (only the site name) and never anything in the background. Nothing is sent until you press Save, and the popup tells you how much text will be sent. Long numbers are masked in your browser before they are sent.",
  ],
  [
    "Signing in",
    "You sign in with Google, or with a code sent to your email where that is available. When you sign in, Google only tells Hippo which email address you control. Reading your Gmail is a separate step that you start yourself, described below.",
  ],
  [
    "Finding subscriptions in Gmail (optional, one time)",
    "Only if you press Connect Gmail, and only after you agree on Google's own page, Hippo reads your Gmail once with read only access. It searches the last two years for subscription emails such as receipts, trials and renewals, and for each one it finds it keeps the text of that email with numbers hidden, the sender, and the dates in it. It also lists emails that look like leases, warranties, manuals or policies by subject, sender and date, without opening them or their attachments. When the scan ends, Hippo asks Google to end its access and deletes the access token. It does not keep a way back in; to scan again you are asked again. It never sends, deletes or changes an email, and never reads your mail in the background. People at Hippo do not read your email, except if you give explicit permission for a specific message, to investigate abuse or a security problem, or where the law requires it. Hippo's use and transfer of information received from Google APIs to any other app adheres to the Google API Services User Data Policy, including the Limited Use requirements. The data from your email is used only to show you your subscriptions and dates. It is not used for advertising or to train AI models, and it is not sold or shared. What it finds is saved like any other document, so you can delete it in Settings, one document at a time or all at once. During the beta Google shows a warning that the app is in testing; that is expected.",
  ],
  [
    "What Hippo does not do",
    "It does not read your email unless you choose the optional Gmail scan above, and it never reads your bank. Otherwise it only knows what you upload, tell it, or save yourself with the extension. It does not sell your data and does not use it for advertising.",
  ],
  ["Numbers", "Policy and account numbers are shown with only the last 4 digits."],
  ["Logs", "Hippo is built so the text of your documents is not written to its logs."],
  [
    "Email",
    "Hippo sends a daily email only when something is due soon. It is on by default, every email has a link that turns it off without signing in, and you can change it in Settings. It names what is due and links back to Hippo, and never includes a full policy or account number.",
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

/** Who runs Hippo and where to write. */
const PUBLISHER = "Kranthi Gadi";
const CONTACT = "devnest007@gmail.com";

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
      <section className="stack">
        <h2>Who runs Hippo</h2>
        <p>
          Hippo is run by {PUBLISHER}. For questions about your data, to ask for your data to be deleted, or for
          anything else in this page, write to <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
        </p>
      </section>
      <p>
        <Link to="/">Back to Hippo</Link>
      </p>
      <Footer />
    </div>
  );
}
