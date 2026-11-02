import type { Repository } from "core/src/contracts";
import { prepareCapture } from "../api/captureDoc";
import type { OnCaptured } from "../api/extension";
import { MAX_CAPTURED_PAGES } from "../api/extension";
import { maskNumbers } from "../mcp/speak";
import { DOCUMENT_QUERY, GmailError, SUBSCRIPTION_QUERY, type GmailClient, type MailMessage } from "./gmail";

// What the one time import does with a batch of messages. A subscription email goes the same way as a page saved with the
// extension: the same rules read it (no model), a vendor the household already tracks is a duplicate, and every field is
// only `extracted` until the person confirms it, so nothing here can start a reminder. Email text is untrusted: it is read
// by fixed patterns, masked, stored as plain text and never followed as an instruction.

export const MAX_SUBSCRIPTION_MAILS = 500;
export const MAX_SPOTTED = 30;

export interface ScanCounts {
  /** Messages read. */
  scanned: number;
  /** New subscriptions saved, each waiting for the person's confirmation. */
  found: number;
  /** Messages about a vendor the household already tracks. */
  duplicates: number;
  /** Messages with no subscription in them, or no text. */
  skipped: number;
  failed: number;
}

export const emptyCounts = (): ScanCounts => ({ scanned: 0, found: 0, duplicates: 0, skipped: 0, failed: 0 });

export interface Spotted {
  kind: "lease" | "warranty" | "manual" | "policy" | "other";
  subject: string;
  sender: string;
  /** YYYY-MM-DD or "". */
  date: string;
  filename: string;
}

/** Labels that only say "this is mail" in front of a company's own name. */
const MAIL_LABELS = new Set([
  "mail",
  "email",
  "e",
  "em",
  "mailer",
  "mailing",
  "news",
  "newsletter",
  "billing",
  "bill",
  "bills",
  "payments",
  "pay",
  "account",
  "accounts",
  "receipts",
  "receipt",
  "orders",
  "order",
  "support",
  "info",
  "notify",
  "notifications",
  "noreply",
  "no-reply",
  "send",
  "smtp",
  "mg",
  "bounce",
  "reply",
  "hello",
  "team",
  "service",
  "services",
  "www",
]);
/** Second level names that make the registrable part three labels (co.uk). */
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "ac", "edu"]);

/** The company's own domain from a sender address: `billing@mail.kestrel.example` gives `kestrel.example`. */
export function senderHost(address: string): string {
  const domain = address.split("@")[1]?.toLowerCase() ?? "";
  const labels = domain.split(".").filter(Boolean);
  if (labels.length < 2 || !/^[a-z0-9.-]+$/.test(domain)) return "";
  let keep = SECOND_LEVEL.has(labels[labels.length - 2]!) && labels[labels.length - 1]!.length === 2 ? 3 : 2;
  keep = Math.min(keep, labels.length);
  const reg = labels.slice(-keep);
  // A leading mail label inside what is left (mail.example.com is two labels already: nothing to strip there).
  while (reg.length > 2 && MAIL_LABELS.has(reg[0]!)) reg.shift();
  const out = reg.join(".");
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(out) && out.length <= 253 ? out : "";
}

export interface ScanDeps {
  gmail: GmailClient;
  capture: OnCaptured;
  repo: Repository;
  now: () => number;
}

export interface BatchResult {
  counts: ScanCounts;
  /** How many of the ids were dealt with, in order. The rest are left for the next step. */
  consumed: number;
  /** `auth`: Google refused the token (it ended). `cap`: the household holds the most saved pages it may. */
  stopped?: "auth" | "cap";
}

/** Display names that say nothing about who the company is. */
const GENERIC_NAMES = new Set(
  "noreply donotreply notifications notification support billing team info hello service mail email accounts account receipts orders admin customercare payments alerts updates".split(
    " ",
  ),
);

/**
 * The line the rules read as the title. For a web page that is the page title, which carries the brand. For an email the
 * subject rarely does ("Your receipt"), but the sender's display name usually does, so it goes first when it is more than a
 * label like "Billing". The subject then leads the body, so a date in it is still read.
 */
export function titleFor(m: MailMessage): { title: string; text: string } {
  const name = m.fromName.replace(/[^\p{L}\p{N} .&'-]/gu, "").trim();
  const folded = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const usable = name.length >= 2 && /\p{L}/u.test(name) && !GENERIC_NAMES.has(folded);
  return usable ? { title: name, text: `${m.subject}\n${m.text}` } : { title: m.subject, text: m.text };
}

const holds = (key: string) => key.startsWith("captures/") || key.startsWith("imports/");

export async function scanBatch(
  deps: ScanDeps,
  householdId: string,
  token: string,
  ids: string[],
): Promise<BatchResult> {
  const counts = emptyCounts();
  let held = (await deps.repo.listDocs(householdId)).filter((d) => holds(d.s3Key)).length;
  let consumed = 0;
  for (const id of ids) {
    let m: MailMessage;
    try {
      m = await deps.gmail.getMessage(token, id);
    } catch (e) {
      if (e instanceof GmailError && (e.status === 401 || e.status === 403))
        return { counts, consumed, stopped: "auth" };
      counts.failed++;
      consumed++;
      continue;
    }
    if (held >= MAX_CAPTURED_PAGES) return { counts, consumed, stopped: "cap" };
    consumed++;
    counts.scanned++;
    const host = senderHost(m.from);
    if (!m.text.trim() || !host) {
      counts.skipped++;
      continue;
    }
    const named = titleFor(m);
    const { doc, text } = await prepareCapture({
      householdId,
      title: named.title,
      host,
      text: named.text,
      now: deps.now,
      prefix: "imports",
    });
    const existing = await deps.repo.getDoc(householdId, doc.id);
    if (existing && existing.status !== "failed") {
      counts.duplicates++;
      continue;
    }
    const r = await deps.capture({ householdId, doc, text, host });
    if (r.status === "saved") {
      counts.found++;
      held++;
    } else if (r.status === "duplicate") counts.duplicates++;
    else if (r.status === "none") counts.skipped++;
    else counts.failed++;
  }
  return { counts, consumed };
}

/** The ids to read, newest first, and the ids of mail that carries a document to list (not read). */
export async function listCandidates(
  gmail: GmailClient,
  token: string,
): Promise<{ ids: string[]; documentIds: string[] }> {
  const ids = await gmail.listIds(token, SUBSCRIPTION_QUERY, MAX_SUBSCRIPTION_MAILS);
  const documentIds = await gmail.listIds(token, DOCUMENT_QUERY, MAX_SPOTTED);
  return { ids, documentIds };
}

const KINDS: [Spotted["kind"], RegExp][] = [
  ["lease", /\b(lease|rental|tenan)/i],
  ["warranty", /\bwarrant/i],
  ["manual", /\bmanual|\bguide\b/i],
  ["policy", /\b(policy|insurance|coverage)\b/i],
];

const isoDay = (header: string): string => {
  const t = Date.parse(header);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : "";
};

/**
 * Lists the mail that carries a lease, warranty, manual or policy as an attachment: who sent it, when, and the file name.
 * Nothing else is kept: not the text, and the attachment itself is never asked for.
 */
export async function spotDocuments(gmail: GmailClient, token: string, ids: string[]): Promise<Spotted[]> {
  const out: Spotted[] = [];
  for (const id of ids.slice(0, MAX_SPOTTED)) {
    try {
      const m = await gmail.getMessage(token, id);
      const file = m.attachments.find((a) => /\.pdf$/i.test(a.filename)) ?? m.attachments[0];
      if (!file) continue;
      const label = `${m.subject} ${file.filename}`;
      const kind = KINDS.find(([, re]) => re.test(label))?.[0] ?? "other";
      out.push({
        kind,
        subject: maskNumbers(m.subject).slice(0, 120),
        sender: senderHost(m.from),
        date: isoDay(m.date),
        filename: maskNumbers(file.filename).slice(0, 120),
      });
    } catch (e) {
      // An unreadable message is simply not listed. A refused token ends the listing, since every call would fail.
      if (e instanceof GmailError && (e.status === 401 || e.status === 403)) break;
    }
  }
  return out;
}
