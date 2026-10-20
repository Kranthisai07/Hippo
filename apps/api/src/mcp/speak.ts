import { parseIso } from "obligation-kit";

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

// A shape is only exempt when it really is what it looks like. "1234-56-78" has the shape of a date but is not one, and
// "123456-7890" has the shape of a phone number but has no separator after the first group, so both are masked.
const dayMonthOk = (a: number, b: number): boolean => a >= 1 && a <= 12 && b >= 1 && b <= 31;
const isRealDate = (core: string): boolean => {
  if (parseIso(core) !== null) return true;
  const m = /^(\d{1,2})[/.](\d{1,2})[/.](?:\d{2}|\d{4})$/.exec(core);
  return !!m && (dayMonthOk(Number(m[1]), Number(m[2])) || dayMonthOk(Number(m[2]), Number(m[1])));
};
const isMoney = (core: string): boolean =>
  /^\$\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(core) || /^\$\d+(?:\.\d+)?$/.test(core);
const isPhone = (core: string): boolean => /^(?:\+?1[-. ])?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}$/.test(core);
const isExempt = (core: string): boolean => isRealDate(core) || isMoney(core) || isPhone(core);

const LEAD = /^[("'[“]+/;

const splitToken = (token: string): { lead: string; core: string; trail: string } => {
  const lead = LEAD.exec(token)?.[0] ?? "";
  const rest = token.slice(lead.length);
  const trail = TRAILING_PUNCT.exec(rest)?.[0] ?? "";
  return { lead, core: trail ? rest.slice(0, rest.length - trail.length) : rest, trail };
};

const PLAIN_DIGITS = /^\p{Nd}{2,}$/u;
/** Numbers are often written in groups ("1234 5678 9012 3456"): this many digits in adjacent groups is one number. */
const MIN_GROUPED_DIGITS = 8;

/** Joins runs of two or more whitespace separated digit groups, so a spaced card or account number is masked as one. */
function maskSpacedGroups(input: string): string {
  const parts = input.split(/(\s+)/);
  const out: string[] = [];
  let i = 0;
  while (i < parts.length) {
    let digits = "";
    let groups = 0;
    let end = i;
    let lead = "";
    let trail = "";
    for (let j = i; j < parts.length; j += 2) {
      const t = splitToken(parts[j]!);
      if (!PLAIN_DIGITS.test(t.core) || (groups > 0 && t.lead)) break;
      if (groups === 0) lead = t.lead;
      digits += t.core;
      groups++;
      end = j + 1;
      trail = t.trail;
      if (trail) break;
    }
    if (groups >= 2 && digits.length >= MIN_GROUPED_DIGITS) {
      out.push(`${lead}ending ${digits.slice(-4)}${trail}`);
      i = end;
    } else {
      out.push(parts[i]!);
      i++;
    }
  }
  return out.join("");
}

/** Any number with 5 or more digits (policy, account, card numbers), also in groups, becomes "ending" plus the last 4. */
export function maskNumbers(input: string): string {
  return maskSpacedGroups(input).replace(/\S+/g, (token) => {
    const { lead, core, trail } = splitToken(token);
    const digits = core.match(/\p{Nd}/gu);
    if (!digits || digits.length < 5) return token;
    if (isExempt(core)) return token;
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
