import { Link } from "react-router";
import { Brand, Footer } from "../components/Layout";

const PRIVACY: [string, string][] = [
  [
    "What Hippo stores",
    "The documents you upload, the fields read from them (dates, terms, contacts), and the text of each page so you can see where a value came from. In a hosted setup the files sit in an encrypted bucket. The demo build keeps everything in memory on one computer and forgets it when stopped.",
  ],
  ["What Hippo does not do", "It does not read your email or your bank. It only knows what you upload or tell it."],
  ["Numbers", "Policy and account numbers are shown with only the last 4 digits."],
  ["Logs", "Document text is never written to logs."],
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
