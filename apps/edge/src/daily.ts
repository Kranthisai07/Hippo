import { createD1Repository, markD1HouseholdsDone, nextD1HouseholdIds, type D1Like } from "core/src/repository/d1";
import { createUnsubscribe } from "../../api/src/unsubscribe";
import { runDaily } from "../../workers/src/daily/runDaily";
import type { DailyDeps, EmailSender, RunReport } from "../../workers/src/daily/types";
import type { EmailBindingLike } from "./cloudflareMailer";

// The daily job on the Worker: deadlines and alerts, the recall check, and the digest email, for every household that has a
// record. It is the same runDaily as the command line job (apps/workers), with the repository on D1. It reads only the
// bindings and settings it is given and builds no web app, so it still runs when the app refuses to start.

export interface DailyEnv {
  DB: D1Like;
  EMAIL?: EmailBindingLike | undefined;
  HIPPO_ISSUER?: string | undefined;
  HIPPO_SIGNING_KEY?: string | undefined;
  HIPPO_MAIL_FROM?: string | undefined;
  /** Most households one run takes (default 5). The cron runs every 15 minutes and each household is done once a day. */
  HIPPO_DAILY_BATCH?: string | undefined;
}

export const DEFAULT_DAILY_BATCH = 5;
const MAX_DAILY_BATCH = 50;

/** The setting as a whole number from 1 to 50, or the default for anything else. */
export function dailyBatchSize(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_DAILY_BATCH) : DEFAULT_DAILY_BATCH;
}

/** What goes in the log: counts and error names only. Never an address, a page, a link or a message from a provider. */
export function summarize(report: RunReport): Record<string, number> {
  const out = {
    households: report.households.length,
    alertsCreated: 0,
    alertsRefreshed: 0,
    recallAlertsCreated: 0,
    emailsSent: 0,
    emailsFailed: 0,
    emailsDryRun: 0,
    errors: 0,
  };
  for (const h of report.households) {
    out.alertsCreated += h.alertsCreated;
    out.alertsRefreshed += h.alertsRefreshed;
    out.recallAlertsCreated += h.recallAlertsCreated;
    out.errors += h.errors.length;
    if (h.email.status === "sent") out.emailsSent++;
    else if (h.email.status === "failed") out.emailsFailed++;
    else if (h.email.status === "skipped" && h.email.reason === "dry_run") out.emailsDryRun++;
  }
  return out;
}

/**
 * Mail goes out only when everything that makes it safe is present: the email binding, a public https address to link to,
 * and the signing key that the turn off link is signed with. Without any of them the digest is built and counted as a dry
 * run, and alerts still sync, so Coming up in the app is right either way.
 */
export function dailyDeps(env: DailyEnv, now: () => number, ids: string[]): DailyDeps {
  const repository = createD1Repository(env.DB);
  const issuer = env.HIPPO_ISSUER ?? "";
  const https = issuer.startsWith("https://");
  const key = env.HIPPO_SIGNING_KEY ?? "";
  const canMail = Boolean(env.EMAIL) && https && key.length >= 32;
  const unsubscribe = canMail ? createUnsubscribe({ signingKey: key, repo: repository, now }) : undefined;
  const from = env.HIPPO_MAIL_FROM ?? "Hippo <digest@localhost>";
  const binding = env.EMAIL;
  const sender: EmailSender | undefined =
    canMail && binding
      ? {
          // Plain text only, the same as the sign in mail. The digest's html is not sent through this binding.
          send: async (e) => void (await binding.send({ from, to: e.to, subject: e.subject, text: e.text })),
        }
      : undefined;
  return {
    repository,
    listHouseholdIds: async () => ids,
    // A hung recall service must not hold the whole run, so each request gets ten seconds.
    fetch: (url: string) => fetch(url, { signal: AbortSignal.timeout(10_000) }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    ...(sender ? { sender } : {}),
    now,
    appUrl: https ? issuer : "http://localhost",
    ...(unsubscribe ? { unsubscribeUrl: (id: string) => unsubscribe.link(issuer, id) } : {}),
  };
}

export async function runDailyJob(
  env: DailyEnv,
  now: () => number = () => Date.now(),
  log: (line: string) => void = (l) => console.log(l),
): Promise<RunReport> {
  const today = new Date(now()).toISOString().slice(0, 10);
  // A few households per run, so one run stays well inside what a Worker may spend (time and requests). The cron comes back
  // every 15 minutes, and a household finished today is skipped, so each is done exactly once a day.
  const ids = await nextD1HouseholdIds(env.DB, today, dailyBatchSize(env.HIPPO_DAILY_BATCH));
  if (ids.length === 0) {
    log(JSON.stringify({ job: "daily", today, households: 0, idle: true }));
    return { today, households: [], requests: { cpsc: 0, nhtsa: 0, nhtsaCap: 0, nhtsaCapReached: false } };
  }
  const report = await runDaily(dailyDeps(env, now, ids), today);
  // Only after the run: if the run itself fails (not one household, which runDaily isolates) they are tried again next time.
  await markD1HouseholdsDone(env.DB, ids, today);
  log(JSON.stringify({ job: "daily", today, ...summarize(report) }));
  return report;
}
