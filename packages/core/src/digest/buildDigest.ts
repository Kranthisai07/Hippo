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
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return t / 86_400_000;
}

function validateAppUrl(raw: string): string {
  const bad = () => new Error(`appUrl must be an https:// URL (or http://localhost for dev), got: ${JSON.stringify(raw)}`);
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s || !/^[^\s<>"'\\`]+$/.test(s)) throw bad();
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw bad();
  }
  if (u.username || u.password || !u.hostname) throw bad();
  if (u.protocol === "https:" || (u.protocol === "http:" && u.hostname === "localhost")) return s;
  throw bad();
}

/** Strips controls, links and dashes, masks long digit runs, then truncates. Masking comes before truncation so a cut can never expose digits. */
function clean(raw: string | undefined): string {
  let s = String(raw ?? "")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\p{Cf}/gu, "")
    .replace(/[\u2012-\u2015\u2212]/g, "-")
    .replace(/(?:\b[a-z][a-z0-9+.-]*:\/\/|\b(?:javascript|data|vbscript):|\bwww\.)\S*/gi, "[link removed]")
    // Digits split by single spaces or hyphens count as one number. This also masks things like "2026-10-18" in untrusted text, on purpose.
    .replace(/\p{Nd}(?:[ -]?\p{Nd}){4,}/gu, (run) => `****${[...run.replace(/[^\p{Nd}]/gu, "")].slice(-4).join("")}`)
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...s];
  if (chars.length > MAX_TEXT) s = chars.slice(0, MAX_TEXT - 3).join("").trimEnd() + "...";
  return s;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function dueLine(due: string | null | undefined, today: number): string | null {
  const d = due ? dayNumber(due) : null;
  if (d === null) return null;
  const [, mo, day] = due!.split("-");
  const when = `${MONTHS[Number(mo) - 1]} ${Number(day)}`;
  const diff = d - today;
  if (diff === 0) return "Due today";
  if (diff === 1) return "Due tomorrow";
  if (diff < 0) return `Was due ${when}`;
  return `Due ${when}, ${diff} days from now`;
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

  const n = picked.length;
  const subject = `Homefile: ${n} ${n === 1 ? "thing needs" : "things need"} you this week`;
  const moreLine = more > 0 ? `and ${more} more in the app` : null;

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
