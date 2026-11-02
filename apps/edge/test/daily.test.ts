import { createD1Repository } from "core/src/repository/d1";
import { describe, expect, it, vi } from "vitest";
import { createSqliteD1 } from "../../../packages/core/test/d1.sqlite";
import { ANCHOR, NOW, addWarranty, days } from "../../workers/test/helpers";
import { dailyDeps, runDailyJob, summarize } from "../src/daily";
import { buildApp, runScheduled, type Env } from "../src/index";
import { fakeBucket } from "./fakes";

// The daily job on the Worker, against the same SQLite stand in for D1 the other edge tests use. The recall services are
// replaced by an empty answer, so nothing here reaches the network.

const ISSUER = "https://api.hippo.test";
const KEY = "daily-test-signing-key-daily-test-signing-key";

type Mail = { from: string; to: string; subject: string; text: string };

function world(over: { email?: boolean; issuer?: string; key?: string } = {}) {
  const db = createSqliteD1();
  const repo = createD1Repository(db);
  const mails: Mail[] = [];
  const env = {
    DB: db,
    ...(over.email === false
      ? {}
      : {
          EMAIL: {
            async send(m: Mail) {
              mails.push(m);
              return { messageId: "m" };
            },
          },
        }),
    HIPPO_ISSUER: over.issuer ?? ISSUER,
    HIPPO_SIGNING_KEY: over.key ?? KEY,
    HIPPO_MAIL_FROM: "Hippo <digest@hippo.test>",
  };
  return { db, repo, env, mails };
}

const emptyRecalls = () =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ results: [], Count: 0 }), { status: 200 })),
  );

async function household(w: ReturnType<typeof world>, id: string, over: { email?: string; digestOn?: boolean } = {}) {
  await w.repo.putHousehold(id, {
    id,
    email: over.email ?? `${id}@hippo.test`,
    digestOn: over.digestOn ?? true,
    createdAt: `${ANCHOR}T00:00:00.000Z`,
  });
}

const quiet = () => undefined;

describe("the daily job on the Worker", () => {
  it("alerts only for a confirmed date, and a household with no record is not touched", async () => {
    emptyRecalls();
    const w = world({ email: false });
    await household(w, "hh_a");
    await addWarranty(w.repo, "hh_a", "sure", days(5), "confirmed");
    await addWarranty(w.repo, "hh_a", "unsure", days(6), "extracted");
    await addWarranty(w.repo, "hh_ghost", "ghost", days(5), "confirmed");
    const report = await runDailyJob(w.env, () => NOW, quiet);
    expect(report.households.map((h) => h.householdId)).toEqual(["hh_a"]);
    const alerts = await w.repo.listAlerts("hh_a");
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts.every((a) => !a.id.includes("unsure"))).toBe(true);
    expect(await w.repo.listAlerts("hh_ghost")).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("sends the digest with a working turn off link, marks it emailed, and sends nothing the second day", async () => {
    emptyRecalls();
    const w = world();
    await household(w, "hh_a", { email: "a@hippo.test" });
    await addWarranty(w.repo, "hh_a", "sure", days(5), "confirmed");
    const first = await runDailyJob(w.env, () => NOW, quiet);
    expect(first.households[0]!.email.status).toBe("sent");
    expect(w.mails).toHaveLength(1);
    expect(w.mails[0]).toMatchObject({ from: "Hippo <digest@hippo.test>", to: "a@hippo.test" });
    const link = /Turn off this email: (\S+)/.exec(w.mails[0]!.text)![1]!;
    expect(new URL(link).origin).toBe(ISSUER);

    await runDailyJob(w.env, () => NOW + 3600_000, quiet);
    expect(w.mails).toHaveLength(1);

    // The link from the mail works against the Worker's own app, and after it nothing more is sent.
    const app = buildApp({ ...w.env, BUCKET: fakeBucket().bucket, HIPPO_ENV: "development" } as unknown as Env, {
      now: () => NOW,
      log: quiet,
    });
    expect((await app.request(link)).status).toBe(200);
    const off = await app.request(`${ISSUER}/unsubscribe`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ t: new URL(link).searchParams.get("t")! }).toString(),
    });
    expect(off.status).toBe(200);
    expect((await w.repo.getHousehold("hh_a"))?.digestOn).toBe(false);
    await addWarranty(w.repo, "hh_a", "later", days(9), "confirmed");
    await runDailyJob(w.env, () => NOW + 2 * 86_400_000, quiet);
    expect(w.mails).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it.each([
    ["no email binding", { email: false }],
    ["an address that is not https", { issuer: "http://api.hippo.test" }],
    ["a signing key that is too short", { key: "short" }],
  ])("sends nothing with %s, but still makes the alerts", async (_name, over) => {
    emptyRecalls();
    const w = world(over);
    await household(w, "hh_a");
    await addWarranty(w.repo, "hh_a", "sure", days(5), "confirmed");
    const report = await runDailyJob(w.env, () => NOW, quiet);
    expect(w.mails).toEqual([]);
    expect(report.households[0]!.email).toMatchObject({ status: "skipped", reason: "dry_run" });
    expect((await w.repo.listAlerts("hh_a")).length).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });

  it("a household with the daily email off is not mailed", async () => {
    emptyRecalls();
    const w = world();
    await household(w, "hh_a", { digestOn: false });
    await addWarranty(w.repo, "hh_a", "sure", days(5), "confirmed");
    await runDailyJob(w.env, () => NOW, quiet);
    expect(w.mails).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("logs counts only: no address, no link, no document text", async () => {
    emptyRecalls();
    const w = world();
    await household(w, "hh_a", { email: "private@hippo.test" });
    await addWarranty(w.repo, "hh_a", "sure", days(5), "confirmed");
    const lines: string[] = [];
    await runDailyJob(
      w.env,
      () => NOW,
      (l) => lines.push(l),
    );
    expect(JSON.parse(lines[0]!)).toMatchObject({ job: "daily", households: 1, emailsSent: 1 });
    expect(lines.join("\n")).not.toMatch(/private@|unsubscribe|https?:/);
    vi.unstubAllGlobals();
  });

  it("summarize adds up the households", () => {
    const base = { obligationsComputed: 0, alertsLeftAlone: 0, alertsDismissed: 0, recallsChecked: 0 };
    const s = summarize({
      today: ANCHOR,
      requests: { cpsc: 0, nhtsa: 0, nhtsaCap: 20, nhtsaCapReached: false },
      households: [
        {
          householdId: "a",
          ...base,
          alertsCreated: 2,
          alertsRefreshed: 1,
          recallAlertsCreated: 1,
          errors: [],
          email: { status: "sent", alertIds: [] },
        },
        {
          householdId: "b",
          ...base,
          alertsCreated: 0,
          alertsRefreshed: 0,
          recallAlertsCreated: 0,
          errors: [{ source: "digest", kind: "unexpected", message: "x" }],
          email: { status: "failed", reason: "r", alertIds: [] },
        },
      ],
    });
    expect(s).toMatchObject({
      households: 2,
      alertsCreated: 2,
      alertsRefreshed: 1,
      recallAlertsCreated: 1,
      emailsSent: 1,
      emailsFailed: 1,
      errors: 1,
    });
  });
});

describe("the scheduled run", () => {
  it("runs the daily job even when the cleanup fails, and then reports the failure", async () => {
    emptyRecalls();
    const w = world({ email: false });
    await household(w, "hh_a");
    await addWarranty(w.repo, "hh_a", "sure", days(5), "confirmed");
    const failing = {
      prepare: (sql: string) => {
        if (/^DELETE FROM auth_/.test(sql)) throw new TypeError("secret detail");
        return w.db.prepare(sql);
      },
      batch: w.db.batch.bind(w.db),
    };
    const err = vi.spyOn(console, "error").mockImplementation(quiet);
    vi.spyOn(console, "log").mockImplementation(quiet);
    // 03:05 UTC on the day of NOW: the run that also does the cleanup.
    await expect(
      runScheduled({ ...w.env, DB: failing } as unknown as Env, () => Date.UTC(2026, 9, 21, 3, 5)),
    ).rejects.toThrow();
    expect((await w.repo.listAlerts("hh_a")).length).toBeGreaterThan(0);
    expect(JSON.stringify(err.mock.calls)).not.toContain("secret detail");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("builds the deps without any network or app", () => {
    const w = world();
    const d = dailyDeps(w.env, () => NOW, []);
    expect(d.sender).toBeDefined();
    expect(d.unsubscribeUrl).toBeDefined();
    expect(d.appUrl).toBe(ISSUER);
  });
});

describe("a failed marking after the mail went out", () => {
  it("does not send the same alerts a second time when the household is taken again", async () => {
    emptyRecalls();
    const w = world();
    await household(w, "hh_a", { email: "a@hippo.test" });
    await addWarranty(w.repo, "hh_a", "sure", days(5), "confirmed");
    let breakMark = true;
    const flaky = {
      prepare: (sql: string) => w.db.prepare(sql),
      batch: (s: Parameters<typeof w.db.batch>[0]) => {
        const marking = (s as unknown as { sql: string }[]).some((x) => x.sql.startsWith("INSERT INTO daily_runs"));
        if (breakMark && marking) throw new TypeError("database busy");
        return w.db.batch(s);
      },
    };
    const env = { ...w.env, DB: flaky } as never;
    await expect(runDailyJob(env, () => NOW, quiet)).rejects.toThrow("database busy");
    expect(w.mails).toHaveLength(1);
    breakMark = false;
    const again = await runDailyJob(env, () => NOW + 900_000, quiet);
    // Taken again, because it was not marked, but the alerts already carry the time they were mailed.
    expect(again.households).toHaveLength(1);
    expect(w.mails).toHaveLength(1);
    vi.unstubAllGlobals();
  });
});
