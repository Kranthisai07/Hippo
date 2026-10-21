import type { ReactNode } from "react";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Splits page text around the quote (tolerating different line breaks). Returns plain strings only. */
export function splitAtQuote(text: string, quote: string): [string, string, string] | null {
  const words = quote.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const m = new RegExp(words.map(escapeRe).join("\\s+")).exec(text);
  if (!m) return null;
  return [text.slice(0, m.index), m[0], text.slice(m.index + m[0].length)];
}

/** The cited page as plain text, with the quote in a mark element. Built from text nodes, never HTML. */
export function SourcePanel({
  page,
  text,
  quote,
  title,
}: {
  page: number;
  text: string;
  quote?: string;
  title?: ReactNode;
}) {
  const parts = quote ? splitAtQuote(text, quote) : null;
  return (
    <section className="card stack" aria-label={`Page ${page} text`}>
      <div className="row">
        <h2>Page {page}</h2>
        {title && <span className="muted small">{title}</span>}
      </div>
      {quote && !parts && (
        <p className="muted small">We could not find the exact quote on this page. The page text is below.</p>
      )}
      <pre className="pagetext" data-testid="page-text">
        {parts ? (
          <>
            {parts[0]}
            <mark data-testid="quote-mark">{parts[1]}</mark>
            {parts[2]}
          </>
        ) : (
          text
        )}
      </pre>
    </section>
  );
}
