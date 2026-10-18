// Builds the daily digest message (SPEC section 10 step 5). Pure: no SES, no network. Everything derived from a
// document or a recall is untrusted data: cleaned, masked to the last 4 digits, and escaped before it reaches the page.

export interface DigestAlert {
  id: string;
  source: "deadline" | "recall";
  severity: "high" | "possible";
  status: "pending" | "announced" | "done" | "dismissed";
  emailedAt?: string | null;
  /** Untrusted. */
  label: string;
  dueDate?: string | null;
  /** Untrusted. */
  detail?: string;
}

export interface DigestInput {
  alerts: DigestAlert[];
  appUrl: string;
  /** ISO date, YYYY-MM-DD. */
  today: string;
  /** Defaults to on; the caller passes the household setting. */
  digestOn?: boolean;
  maxItems?: number;
}

export interface Digest {
  subject: string;
  text: string;
  html: string;
  /** Only the alerts actually shown, so the caller marks exactly those emailed. */
  alertIds: string[];
}

const MAX_TEXT = 120;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayNumber(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1000) return null; // Date.UTC maps years 0-99 to the 1900s
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return t / 86_400_000;
}

function validateAppUrl(raw: string): string {
  const bad = () => new Error(`appUrl must be an https:// URL (or http://localhost for dev), got: ${JSON.stringify(raw)}`);
  const s = typeof raw === "string" ? raw.trim() : "";
  // Printable ASCII only: no controls, zero width, spaces, dash look-alikes. Also no quotes, angle brackets, backslash, backtick.
  // shortcut: internationalized hosts must be given as punycode, upgrade if a household ever needs a non-ASCII domain.
  if (!/^[\x21-\x7e]+$/.test(s) || /["'<>\\`]/.test(s)) throw bad();
  // new URL() forgives "https:evil.com" and "https:///x", so insist on a real "scheme://host".
  if (!/^https?:\/\/[^/?#]/i.test(s)) throw bad();
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw bad();
  }
  if (u.username || u.password || !u.hostname) throw bad();
  if (!(u.protocol === "https:" || (u.protocol === "http:" && u.hostname === "localhost"))) throw bad();
  // A long number in a link is a smell (it could be an account number).
  if (/\d{5}/.test(u.pathname + u.search + u.hash)) throw bad();
  return u.href;
}

/**
 * Strips controls, links and dashes, masks long digit runs, then truncates. Masking comes before truncation so a cut can never expose digits.
 * Digit rule: 5 or more digits, split only by separators (spaces, hyphens, dots, commas, slashes, underscores), count as one number
 * and become "****" plus the last 4. Fail safe on purpose: "1 2 3 4 5" and "Dec 5, 2026" are masked too, and so are ISO dates.
 */
function clean(raw: string | undefined): string {
  let s = String(raw ?? "")
    .normalize("NFKC") // superscripts and full width digits become plain digits, look-alike dashes and dots become ASCII
    .replace(/\p{M}/gu, "")
    .replace(/[\p{Z}\p{Cc}\p{Cf}]/gu, " ")
    .replace(/[\p{Pd}\u2212]/gu, "-")
    .replace(/[^\s@]+@[^\s@]+/g, "[link removed]")
    .replace(/(?:\b[a-z][a-z0-9+.-]*:\/\/|\b(?:javascript|data|vbscript|mailto|tel):|\bwww\.)\S*/gi, "[link removed]")
    .replace(/(?<![^\s(\[])\/\/\S*/g, "[link removed]")
    // A bare domain with a letters-only TLD of 2+ characters, and anything after it. "Dec. 5" and "e.g. this" survive.
    .replace(/\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.\p{L}{2,}\b(?:[/?#]\S*)?/giu, "[link removed]")
    .replace(/\p{Nd}(?:[ .,/_-]*\p{Nd}){4,}/gu, (run) => `****${[...run.replace(/[^\p{Nd}]/gu, "")].slice(-4).join("")}`)
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...s];
  if (chars.length > MAX_TEXT) s = chars.slice(0, MAX_TEXT - 3).join("").trimEnd() + "...";
  return s;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function dueLine(due: string | null | undefined, today: number): string | null {
  if (!due) return null;
  const d = dayNumber(due);
  if (d === null) return "Date unclear";
  const [y, mo, day] = due.split("-").map(Number) as [number, number, number];
  const diff = d - today;
  if (diff === 0) return "Due today";
  if (diff === 1) return "Due tomorrow";
  // Show the year whenever it differs from this year, so "Was due Jan 1" is never ambiguous.
  const when = `${MONTHS[mo - 1]} ${day}${y === new Date(today * 86_400_000).getUTCFullYear() ? "" : `, ${y}`}`;
  if (diff < 0) return `Was due ${when}`;
  // Past a year out a day count is just a big number, so print the date only.
  return diff > 365 ? `Due ${when}` : `Due ${when}, ${diff} days from now`;
}

function eligible(a: DigestAlert): boolean {
  if (a.emailedAt) return false;
  if (a.status !== "pending" && a.status !== "announced") return false;
  if (a.severity === "high") return true;
  // Possible recalls only appear when asked; a possible deadline is new only until voice has announced it.
  return a.source === "deadline" && a.status === "pending";
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function order(a: DigestAlert, b: DigestAlert): number {
  const ad = a.dueDate ? dayNumber(a.dueDate) : null;
  const bd = b.dueDate ? dayNumber(b.dueDate) : null;
  if (ad !== bd) return (ad ?? Infinity) < (bd ?? Infinity) ? -1 : 1;
  return cmp(a.label, b.label) || cmp(a.id, b.id);
}

export function buildDigest(input: DigestInput): Digest | null {
  const link = validateAppUrl(input.appUrl);
  const today = dayNumber(input.today);
  if (today === null) throw new Error(`today must be an ISO date (YYYY-MM-DD), got: ${JSON.stringify(input.today)}`);
  if (input.digestOn === false) return null;

  const picked = input.alerts
    .filter(eligible)
    .sort((a, b) => Number(b.severity === "high") - Number(a.severity === "high") || order(a, b));
  if (picked.length === 0) return null;

  const cap = Number.isFinite(input.maxItems) && (input.maxItems as number) >= 1 ? Math.floor(input.maxItems as number) : 10;
  const shown = picked.slice(0, cap);
  const more = picked.length - shown.length;

  const items = shown.map((a) => {
    const lines: string[] = [];
    const due = a.source === "deadline" ? dueLine(a.dueDate, today) : null;
    if (due) lines.push(due);
    if (a.source === "recall") lines.push("This recall may affect something you own.");
    const detail = clean(a.detail);
    if (detail) lines.push(detail);
    return { label: clean(a.label) || "Untitled", lines };
  });

  const n = shown.length;
  // Counts in the subject and the "more" line are capped so a huge alert pile never prints a long number.
  const subject = more > 0 ? "Homefile: Several things need you" : `Homefile: ${n} ${n === 1 ? "thing needs" : "things need"} you`;
  const moreLine = more > 0 ? `and ${more > 99 ? "many" : more} more in the app` : null;

  const text = [
    ...items.map((i) => [`- ${i.label}`, ...i.lines.map((l) => `  ${l}`)].join("\n")),
    ...(moreLine ? [moreLine] : []),
    `Open Homefile: ${link}`,
  ].join("\n\n");

  const p = 'style="margin:0 0 14px;font-size:16px;line-height:1.4"';
  const html = [
    '<div style="font-family:Arial,Helvetica,sans-serif;color:#222;max-width:560px;margin:0 auto;padding:16px">',
    ...items.map((i) => `<p ${p}><strong>${esc(i.label)}</strong>${i.lines.map((l) => `<br>${esc(l)}`).join("")}</p>`),
    ...(moreLine ? [`<p ${p}>${moreLine}</p>`] : []),
    `<p ${p}><a href="${esc(link)}" style="color:#0b5cad">Open Homefile</a></p>`,
    "</div>",
  ].join("\n");

  return { subject, text, html, alertIds: shown.map((a) => a.id) };
}
