// The one place that turns text into something a speaker can read: no markdown, no links, no long numbers, a word cap.
// Every model-facing tool builds its `content` through speak() (SPEC section 6 response contract).

export const MAX_SPOKEN_WORDS = 45;
/** Input is cut here before any pattern runs, so a huge string cannot make the cleanup slow. */
const MAX_INPUT_CHARS = 20_000;

export const countWords = (s: string): number => {
  const m = s.match(/\S+/g);
  return m ? m.length : 0;
};

const tidy = (s: string): string =>
  s
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();

export function stripMarkdown(input: string): string {
  const s = input
    .replace(/\[([^\]\n]{0,300})\]\([^)\n]{0,2000}\)/g, "$1")
    .replace(/^\s*\|?[\s:|-]*-{3,}[\s:|-]*\|?\s*$/gm, " ")
    .replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/gm, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/(\*\*|__)([^\n]{0,500}?)\1/g, "$2")
    .replace(/\*([^*\n]{0,500})\*/g, "$1")
    .replace(/(^|\s)_([^_\n]{1,500})_(?=\s|$|[.,;:!?])/g, "$1$2")
    .replace(/<\/?[a-zA-Z][^>\n]{0,200}>/g, " ")
    .replace(/[*~`<>|\\^]/g, " ");
  return tidy(s);
}

const TRAILING_PUNCT = /[.,;:!?)\]"']+$/;

export function stripUrls(input: string): string {
  const s = input
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>"]{1,2000}/gi, (m) => TRAILING_PUNCT.exec(m)?.[0] ?? "")
    .replace(/[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,5}/g, "")
    .replace(
      /\b[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){0,4}\.[a-z]{2,}\/[^\s<>"]{0,2000}/gi,
      (m) => TRAILING_PUNCT.exec(m)?.[0] ?? "",
    )
    .replace(/\b[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){0,4}\.(?:com|org|net|io|gov|edu|co|example)\b/gi, "");
  return tidy(s);
}

const EXEMPT = [
  /^\d{4}-\d{2}-\d{2}$/,
  /^\d{1,2}[/.]\d{1,2}[/.]\d{2,4}$/,
  /^\$?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/,
  /^\$\d+(?:\.\d+)?$/,
  /^(?:\+?1-)?\(?\d{3}\)?[-. ]?\d{3}-\d{4}$/,
];

const LEAD = /^[("'[“]+/;

/** Any word with 5 or more digits (policy, account, card numbers) becomes "ending" plus its last 4 digits. */
export function maskNumbers(input: string): string {
  return input.replace(/\S+/g, (token) => {
    const lead = LEAD.exec(token)?.[0] ?? "";
    const rest = token.slice(lead.length);
    const trail = TRAILING_PUNCT.exec(rest)?.[0] ?? "";
    const core = trail ? rest.slice(0, rest.length - trail.length) : rest;
    const digits = core.match(/\p{Nd}/gu);
    if (!digits || digits.length < 5) return token;
    if (EXEMPT.some((re) => re.test(core))) return token;
    return `${lead}ending ${digits.slice(-4).join("")}${trail}`;
  });
}

function sentencesOf(s: string): string[] {
  return s.split(/(?<=[.!?])\s+/).filter((x) => x.length > 0);
}

/**
 * Plain spoken text: markdown and links removed, long numbers masked, at most `maxWords` words. When the text is too
 * long it is cut after the last whole sentence that fits, or after `maxWords` words when one sentence is too long.
 */
export function speak(parts: string | readonly string[], maxWords: number = MAX_SPOKEN_WORDS): string {
  const raw = (Array.isArray(parts) ? parts.join(" ") : (parts as string)).slice(0, MAX_INPUT_CHARS);
  const clean = tidy(maskNumbers(stripUrls(stripMarkdown(raw))));
  if (countWords(clean) <= maxWords) return clean;
  let out = "";
  let used = 0;
  for (const sentence of sentencesOf(clean)) {
    const n = countWords(sentence);
    if (used + n > maxWords) break;
    out = out ? `${out} ${sentence}` : sentence;
    used += n;
  }
  if (out) return out;
  const cut = clean
    .match(/\S+/g)!
    .slice(0, maxWords)
    .join(" ")
    .replace(/[.,;:!?]+$/, "");
  return `${cut}.`;
}
