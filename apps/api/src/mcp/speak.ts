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
// Money is capped at 9 digits: "$4111111111111111" is a card number with a dollar sign in front, not an amount.
const isMoney = (core: string): boolean =>
  /^\$\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(core) || /^\$\d{1,9}(?:\.\d+)?$/.test(core);
const isPhone = (core: string): boolean => /^(?:\+?1[-. ])?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}$/.test(core);
/** "25,000": one thousands group is a quantity, two or more ("1,234,567") look like an account number. */
const isThousands = (core: string): boolean => /^\d{1,3},\d{3}(?:\.\d+)?$/.test(core);
// A phone shape is handled before the word pass (see maskNumbers), so a 10 digit account number written 3-3-4 is not
// mistaken for a phone number just because of how it is grouped.
const isExempt = (core: string): boolean => isRealDate(core) || isMoney(core) || isThousands(core);

/** Words that say a number is a phone number. Without one, or a country code or parentheses, a 3-3-4 number is masked. */
const PHONE_CUE = /\b(?:tel|telephone|phone|call|fax|cell|mobile|dial|text|contact|reach|ph)\b[^\p{Nd}]{0,12}$/iu;
const phoneKept = (match: string, before: string): boolean =>
  /^\+?1[-. ]/.test(match) || match.includes("(") || PHONE_CUE.test(before);

const MONTH_BEFORE =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s*$/iu;

const LEAD = /^[("'[“]+/;

const splitToken = (token: string): { lead: string; core: string; trail: string } => {
  const lead = LEAD.exec(token)?.[0] ?? "";
  const rest = token.slice(lead.length);
  const trail = TRAILING_PUNCT.exec(rest)?.[0] ?? "";
  return { lead, core: trail ? rest.slice(0, rest.length - trail.length) : rest, trail };
};

/**
 * A number written in groups is one number. Joined by punctuation ("1234 - 5678 - 9012", "4111, 1111") it needs 7 digits,
 * so "Oct 21, 2026" stays a date. Joined by spaces only ("12 345", "123 4567") it needs 5, each group at least 2 digits,
 * and a month name right before it ("Oct 21 2026") means it is a date.
 */
const MIN_PUNCTUATED_DIGITS = 7;
const MIN_SPACED_DIGITS = 5;

/**
 * Digit groups joined by spaces or by punctuation (dash, slash, dot, comma, bullet, bar, with or without spaces around
 * it). Not after a letter or a dollar sign ("HM-AU-0048-4821" is handled as one word, "$1,850" is money) and not inside
 * a longer digit run. Every part is bounded, so it runs in linear time.
 */
const DIGIT_RUN = /(?<![\p{L}\p{Nd}$])(?<!\p{L}-)\p{Nd}+(?:(?:\s*[-–—/.,;•|·]\s*|\s+)\p{Nd}+)+(?!\p{Nd})/gu;

const maskDigitRuns = (s: string): string =>
  s.replace(DIGIT_RUN, (run, offset: number) => {
    const digits = run.match(/\p{Nd}/gu) ?? [];
    const spacesOnly = !/[^\p{Nd}\s]/u.test(run);
    const enough = spacesOnly
      ? digits.length >= MIN_SPACED_DIGITS &&
        (run.match(/\p{Nd}+/gu) ?? []).every((g) => g.length >= 2) &&
        !MONTH_BEFORE.test(s.slice(0, offset))
      : digits.length >= MIN_PUNCTUATED_DIGITS;
    return enough ? `ending ${digits.slice(-4).join("")}` : run;
  });

/** One word with 5 or more digits (policy, account, card numbers) becomes "ending" plus its last 4 digits. */
const maskTokens = (s: string): string =>
  s.replace(/\S+/g, (token) => {
    const { lead, core, trail } = splitToken(token);
    const digits = core.match(/\p{Nd}/gu);
    if (!digits || digits.length < 5) return token;
    if (isExempt(core)) return token;
    return `${lead}ending ${digits.slice(-4).join("")}${trail}`;
  });

/**
 * A number typed one digit at a time ("4 1 1 1 1 1 1 1"). Seven single digits in a row, joined by one space, dot or
 * dash, are one number. Each step is one character, so it runs in linear time.
 */
const SINGLE_DIGITS = /(?<![\p{L}\p{Nd}$])\p{Nd}(?:[\s.\-–—]\p{Nd}){6,}(?!\p{Nd})/gu;
const maskSingleDigits = (s: string): string =>
  s.replace(SINGLE_DIGITS, (run) => `ending ${(run.match(/\p{Nd}/gu) ?? []).slice(-4).join("")}`);

const maskPlain = (s: string): string => maskTokens(maskDigitRuns(maskSingleDigits(s)));

/** Things that look like numbers but are not account numbers. Kept only when they pass the checks above. */
const PROTECTED = new RegExp(
  [
    String.raw`(?<!\p{Nd})(?:\+?1[-. ])?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}(?!\p{Nd})`,
    String.raw`(?<!\p{Nd})\d{4}-\d{2}-\d{2}(?!\p{Nd})`,
    String.raw`(?<!\p{Nd})\d{1,2}[/.]\d{1,2}[/.](?:\d{4}|\d{2})(?!\p{Nd})`,
    String.raw`\$\d{1,3}(?:,\d{3})+(?:\.\d+)?(?!\p{Nd})`,
    String.raw`\$\d{1,9}(?:\.\d+)?(?!\p{Nd})`,
  ].join("|"),
  "gu",
);

/**
 * Any number with 5 or more digits (policy, account, card numbers), also written in groups or split by punctuation or
 * invisible characters, becomes "ending" plus the last 4. Real dates, phone numbers and amounts of money stay readable.
 */
export function maskNumbers(input: string): string {
  // Zero width characters, soft hyphens and bidi marks (category Cf) are invisible to a reader and hide digits from a
  // pattern, so they are dropped first.
  const text = input.replace(/\p{Cf}/gu, "");
  let out = "";
  let last = 0;
  for (const m of text.matchAll(PROTECTED)) {
    const before = text.slice(Math.max(0, m.index - 25), m.index);
    if (!(isRealDate(m[0]) || isMoney(m[0]) || (isPhone(m[0]) && phoneKept(m[0], before)))) continue;
    out += maskPlain(text.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + maskPlain(text.slice(last));
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
