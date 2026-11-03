import { describe, expect, it } from "vitest";
import { FINISHED_KEEP_MS, type ImportJob, type ImportStore } from "../src/import/store";

// What every import store must do, run against the memory store and against D1 (on SQLite).

const T0 = Date.UTC(2026, 10, 2, 12, 0, 0);

export const job = (over: Partial<ImportJob> = {}): ImportJob => ({
  id: "job-1",
  householdId: "hh_a",
  status: "running",
  createdAt: T0,
  finishedAt: null,
  counts: { scanned: 0, found: 0, duplicates: 0, skipped: 0, failed: 0, candidates: 0 },
  remaining: [],
  listed: false,
  documentIds: [],
  spotted: [],
  tokenCipher: "v1.iv.ct",
  tokenExpiresAt: T0 + 3600_000,
  error: null,
  revoked: false,
  ...over,
});

export function runImportStoreSuite(name: string, make: () => ImportStore): void {
  describe(`the import store: ${name}`, () => {
    it("gives back exactly what was created, and nothing for an unknown id", async () => {
      const s = make();
      const j = job({
        remaining: ["a", "b"],
        listed: true,
        documentIds: ["d1"],
        counts: { scanned: 3, found: 2, duplicates: 1, skipped: 0, failed: 0, candidates: 9 },
        spotted: [{ kind: "lease", subject: "Lease", sender: "oak.example", date: "2025-01-01", filename: "l.pdf" }],
      });
      await s.create(j);
      expect(await s.get("job-1")).toEqual(j);
      expect(await s.get("nope")).toBeNull();
    });

    it("replaces the record on update, including dropping the sealed token", async () => {
      const s = make();
      await s.create(job());
      await s.update(
        job({ status: "done", finishedAt: T0 + 5, tokenCipher: null, revoked: true, error: "cap", remaining: [] }),
      );
      expect(await s.get("job-1")).toMatchObject({
        status: "done",
        finishedAt: T0 + 5,
        tokenCipher: null,
        revoked: true,
        error: "cap",
      });
    });

    it("lets one caller take the job, makes the others wait, and lets it go again", async () => {
      const s = make();
      await s.create(job());
      expect(await s.tryLock("job-1", T0, 60_000)).toBe(true);
      expect(await s.tryLock("job-1", T0 + 1000, 60_000)).toBe(false);
      expect(await s.tryLock("job-1", T0 + 61_000, 60_000)).toBe(true);
      await s.unlock("job-1");
      expect(await s.tryLock("job-1", T0 + 62_000, 60_000)).toBe(true);
      expect(await s.tryLock("unknown", T0, 1000)).toBe(false);
    });

    it("has exactly one winner when many callers try at once", async () => {
      const s = make();
      await s.create(job());
      const results = await Promise.all(Array.from({ length: 20 }, () => s.tryLock("job-1", T0, 60_000)));
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it("finds the newest job of a household and never another household's", async () => {
      const s = make();
      await s.create(job({ id: "old", createdAt: T0 - 10_000 }));
      await s.create(job({ id: "new", createdAt: T0 }));
      await s.create(job({ id: "other", householdId: "hh_b", createdAt: T0 + 5000 }));
      expect((await s.latestFor("hh_a"))?.id).toBe("new");
      expect((await s.latestFor("hh_b"))?.id).toBe("other");
      expect(await s.latestFor("hh_none")).toBeNull();
    });

    it("purge ends a running job whose token has expired and drops the sealed token, and leaves the others", async () => {
      const s = make();
      await s.create(job({ id: "stale", tokenExpiresAt: T0 - 1 }));
      await s.create(job({ id: "live", tokenExpiresAt: T0 + 1000 }));
      await s.create(
        job({ id: "done", status: "done", finishedAt: T0 - 1000, tokenCipher: null, tokenExpiresAt: T0 - 5000 }),
      );
      await s.purge(T0);
      expect(await s.get("stale")).toMatchObject({ status: "failed", error: "expired", tokenCipher: null });
      expect((await s.get("stale"))?.finishedAt).toBe(T0);
      expect(await s.get("live")).toMatchObject({ status: "running", tokenCipher: "v1.iv.ct" });
      expect((await s.get("done"))?.status).toBe("done");
    });

    it("purge removes finished jobs after thirty days and keeps newer ones", async () => {
      const s = make();
      await s.create(job({ id: "ancient", status: "done", finishedAt: T0 - FINISHED_KEEP_MS - 1, tokenCipher: null }));
      await s.create(
        job({ id: "recent", status: "done", finishedAt: T0 - FINISHED_KEEP_MS + 1000, tokenCipher: null }),
      );
      await s.purge(T0);
      expect(await s.get("ancient")).toBeNull();
      expect(await s.get("recent")).not.toBeNull();
    });
  });
}

export function runImportStoreGuards(name: string, make: () => ImportStore): void {
  describe(`the import store guards: ${name}`, () => {
    it("update writes only while the job is running, and says whether it did", async () => {
      const s = make();
      await s.create(job());
      expect(await s.update(job({ status: "cancelled", finishedAt: T0, tokenCipher: null }))).toBe(true);
      // A step that was in flight tries to put it back to running with the token.
      expect(await s.update(job())).toBe(false);
      expect(await s.get("job-1")).toMatchObject({ status: "cancelled", tokenCipher: null });
      expect(await s.update(job({ id: "nope" }))).toBe(false);
    });

    it("deleteFor removes every job of one household and no other", async () => {
      const s = make();
      await s.create(job({ id: "a1" }));
      await s.create(job({ id: "a2", status: "done", finishedAt: T0, tokenCipher: null }));
      await s.create(job({ id: "b1", householdId: "hh_b" }));
      await s.deleteFor("hh_a");
      expect(await s.get("a1")).toBeNull();
      expect(await s.get("a2")).toBeNull();
      expect(await s.get("b1")).not.toBeNull();
    });

    it("purge of an expired running job also drops the lists of message ids", async () => {
      const s = make();
      await s.create(job({ id: "stale", tokenExpiresAt: T0 - 1, remaining: ["m1", "m2"], documentIds: ["d1"] }));
      await s.purge(T0);
      expect(await s.get("stale")).toMatchObject({
        status: "failed",
        remaining: [],
        documentIds: [],
        tokenCipher: null,
      });
    });
  });
}
