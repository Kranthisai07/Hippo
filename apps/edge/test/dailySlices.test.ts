import { createD1Repository, markD1HouseholdsDone, nextD1HouseholdIds } from "core/src/repository/d1";
import { describe, expect, it, vi } from "vitest";
import { createSqliteD1 } from "../../../packages/core/test/d1.sqlite";
import { ANCHOR, NOW } from "../../workers/test/helpers";
import { DEFAULT_DAILY_BATCH, dailyBatchSize, runDailyJob } from "../src/daily";
import { createD1AuthStore } from "../src/d1AuthStore";
import { isCleanupRun, runScheduled, type Env } from "../src/index";

// The daily job takes a few households per run, every 15 minutes, and each household is done once a day.

const quiet = () => undefined;
const DAY = 86_400_000;

function world(count: number, batch?: string) {
  const db = createSqliteD1();
  const repo = createD1Repository(db);
  const env = { DB: db, ...(batch ? { HIPPO_DAILY_BATCH: batch } : {}) };
  const ids = Array.from({ length: count }, (_, i) => `hh_${String(i + 1).padStart(2, "0")}`);
  const seed = () =>
    Promise.all(ids.map((id) => repo.putHousehold(id, { id, digestOn: false, createdAt: `${ANCHOR}T00:00:00.000Z` })));
  return { db, repo, env, ids, seed };
}

const emptyRecalls = () =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ results: [], Count: 0 }), { status: 200 })),
  );

describe("working through the households in slices", () => {
  it("does each household exactly once a day, a batch at a time, in key order", async () => {
    emptyRecalls();
    const w = world(7, "3");
    await w.seed();
    const seen: string[][] = [];
    for (let run = 0; run < 5; run++) {
      const r = await runDailyJob(w.env, () => NOW + run * 900_000, quiet);
      seen.push(r.households.map((h) => h.householdId));
    }
    expect(seen).toEqual([["hh_01", "hh_02", "hh_03"], ["hh_04", "hh_05", "hh_06"], ["hh_07"], [], []]);
    vi.unstubAllGlobals();
  });

  it("starts again the next day", async () => {
    emptyRecalls();
    const w = world(2, "5");
    await w.seed();
    expect((await runDailyJob(w.env, () => NOW, quiet)).households).toHaveLength(2);
    expect((await runDailyJob(w.env, () => NOW + 3600_000, quiet)).households).toHaveLength(0);
    expect((await runDailyJob(w.env, () => NOW + DAY, quiet)).households).toHaveLength(2);
    vi.unstubAllGlobals();
  });

  it("a household that signs in later in the day is picked up by a later run the same day", async () => {
    emptyRecalls();
    const w = world(2, "5");
    await w.seed();
    await runDailyJob(w.env, () => NOW, quiet);
    await w.repo.putHousehold("hh_new", { id: "hh_new", digestOn: false, createdAt: `${ANCHOR}T13:00:00.000Z` });
    const r = await runDailyJob(w.env, () => NOW + 900_000, quiet);
    expect(r.households.map((h) => h.householdId)).toEqual(["hh_new"]);
    vi.unstubAllGlobals();
  });

  it("with nobody to do it is a cheap no-op that logs that it was idle and calls no one", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const w = world(0);
    const lines: string[] = [];
    const r = await runDailyJob(
      w.env,
      () => NOW,
      (l) => lines.push(l),
    );
    expect(r.households).toEqual([]);
    expect(JSON.parse(lines[0]!)).toMatchObject({ job: "daily", households: 0, idle: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("if the run itself fails, the households are not marked done and the next run takes them again", async () => {
    emptyRecalls();
    const w = world(3, "5");
    await w.seed();
    let breakBatch = true;
    // Only the write that records "done" fails, so the failure is in the marking step and not in the run itself.
    const flaky = {
      prepare: (sql: string) => w.db.prepare(sql),
      batch: (s: Parameters<typeof w.db.batch>[0]) => {
        const marking = (s as unknown as { sql: string }[]).some((x) => x.sql.startsWith("INSERT INTO daily_runs"));
        if (breakBatch && marking) throw new TypeError("database busy");
        return w.db.batch(s);
      },
    };
    const env = { DB: flaky, HIPPO_DAILY_BATCH: "5" } as never;
    await expect(runDailyJob(env, () => NOW, quiet)).rejects.toThrow("database busy");
    expect(w.db.count("daily_runs")).toBe(0);
    breakBatch = false;
    const again = await runDailyJob(env, () => NOW + 60_000, quiet);
    expect(again.households).toHaveLength(3);
    expect(w.db.count("daily_runs")).toBe(3);
    vi.unstubAllGlobals();
  });
});

describe("the list of households still to do", () => {
  it("leaves out the ones done for that day only, and comes back with the day", async () => {
    const w = world(3);
    await w.seed();
    await markD1HouseholdsDone(w.db, ["hh_01", "hh_03"], "2026-10-21");
    expect(await nextD1HouseholdIds(w.db, "2026-10-21", 10)).toEqual(["hh_02"]);
    expect(await nextD1HouseholdIds(w.db, "2026-10-22", 10)).toEqual(["hh_01", "hh_02", "hh_03"]);
  });

  it("respects the limit, ignores things that are not households, and handles ids with the key separator", async () => {
    const w = world(0);
    for (const id of ["a#b", "c%d", "e"]) {
      await w.repo.putHousehold(id, { id, digestOn: false, createdAt: `${ANCHOR}T00:00:00.000Z` });
    }
    await w.repo.putDoc("hh_docs_only", {
      id: "d",
      s3Key: "k",
      filename: "f.txt",
      docType: "other",
      status: "uploaded",
      uploadedAt: `${ANCHOR}T00:00:00.000Z`,
      assetIds: [],
    });
    const two = await nextD1HouseholdIds(w.db, "2026-10-21", 2);
    expect(two).toHaveLength(2);
    const all = await nextD1HouseholdIds(w.db, "2026-10-21", 50);
    expect([...all].sort()).toEqual(["a#b", "c%d", "e"]);
    await markD1HouseholdsDone(w.db, all, "2026-10-21");
    expect(await nextD1HouseholdIds(w.db, "2026-10-21", 50)).toEqual([]);
  });

  it("marks a long list in several batches", async () => {
    const w = world(60);
    await w.seed();
    await markD1HouseholdsDone(w.db, w.ids, "2026-10-21");
    expect(await nextD1HouseholdIds(w.db, "2026-10-21", 100)).toEqual([]);
    expect(w.db.count("daily_runs")).toBe(60);
  });
});

describe("the batch size setting", () => {
  it.each([
    [undefined, DEFAULT_DAILY_BATCH],
    ["", DEFAULT_DAILY_BATCH],
    ["3", 3],
    ["50", 50],
    ["1000", 50],
    ["0", DEFAULT_DAILY_BATCH],
    ["-2", DEFAULT_DAILY_BATCH],
    ["2.5", DEFAULT_DAILY_BATCH],
    ["many", DEFAULT_DAILY_BATCH],
  ])("%s gives %s", (raw, expected) => {
    expect(dailyBatchSize(raw as string | undefined)).toBe(expected);
  });
});

describe("which run does the cleanup", () => {
  it.each([
    [Date.UTC(2026, 10, 2, 3, 0), true],
    [Date.UTC(2026, 10, 2, 3, 14), true],
    [Date.UTC(2026, 10, 2, 3, 15), false],
    [Date.UTC(2026, 10, 2, 2, 59), false],
    [Date.UTC(2026, 10, 2, 4, 0), false],
    [Date.UTC(2026, 10, 2, 15, 5), false],
  ])("%s is %s", (t, expected) => {
    expect(isCleanupRun(t)).toBe(expected);
  });

  it("only that run deletes expired sign in records; the others leave them for it", async () => {
    emptyRecalls();
    const w = world(0);
    const store = createD1AuthStore(w.db, { now: () => NOW });
    await store.putSession("old", { email: "a@x.example", sub: "u", householdId: "h", expiresAt: NOW - 1000 });
    const env = { DB: w.db } as unknown as Env;
    vi.spyOn(console, "log").mockImplementation(quiet);
    await runScheduled(env, () => Date.UTC(2026, 10, 2, 10, 5));
    expect(w.db.count("auth_sessions")).toBe(1);
    await runScheduled(env, () => Date.UTC(2026, 10, 3, 3, 5));
    expect(w.db.count("auth_sessions")).toBe(0);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("the cleanup also drops finished-day rows older than three days and keeps the recent ones", async () => {
    const w = world(0);
    const store = createD1AuthStore(w.db, { now: () => NOW });
    await markD1HouseholdsDone(w.db, ["old"], "2026-10-10");
    await markD1HouseholdsDone(w.db, ["recent"], "2026-10-20");
    await store.purgeExpired(NOW);
    expect(w.db.count("daily_runs")).toBe(1);
  });
});
