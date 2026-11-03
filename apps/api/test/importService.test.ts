import { readFileSync } from "node:fs";
import { createMemoryRepository } from "core/src/repository";
import { describe, expect, it } from "vitest";
import { createCaptureIngest } from "../../workers/src/ingest/capture";
import { MAX_CAPTURED_PAGES, type OnCaptured } from "../src/api/extension";
import { createMemoryObjectStore } from "../src/api/storage";
import { createGmailClient } from "../src/import/gmail";
import { createImportService, LOCK_MS, MIN_GAP_MS } from "../src/import/service";
import { createMemoryImportStore } from "../src/import/store";
import { createTokenBox } from "../src/import/tokenBox";
import { createMemoryIndexSource } from "../src/mcp/indexCache";
import { createFakeGmail, type FakeMail, type FakeGmailOptions } from "./fakeGmail";

const HH = "hh_import";
const OTHER = "hh_other";
const T0 = Date.UTC(2026, 10, 2, 12, 0, 0);
const KEY = "import-service-test-key-import-service-test-key";

const pageText = (name: string): string => {
  const html = readFileSync(new URL(`../../../fixtures/pages/${name}.html`, import.meta.url), "utf8");
  return /<body>([\s\S]*)<\/body>/
    .exec(html)![1]!
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, "\n")
    .replaceAll("&gt;", ">");
};
const mail = (id: string, from: string, subject: string, text: string, over: Partial<FakeMail> = {}): FakeMail => ({
  id,
  from,
  subject,
  text,
  kind: "subscription",
  ...over,
});

const MAILS: FakeMail[] = [
  mail(
    "m1",
    "Fernwood Streaming <billing@account.fernwood-streaming.example>",
    "Your bill",
    pageText("fernwood_billing"),
  ),
  mail("m2", "Kestrel Learning <hello@www.kestrel-learning.example>", "Your trial", pageText("kestrel_trial")),
  mail("m3", "Cedar Cloud Storage <receipts@billing.cedarcloud.example>", "Your receipt", pageText("cedar_receipt")),
  mail("m4", "News <news@blog.example>", "Ten tips", "Gardens and cooking, ten tips for your weekend."),
  mail("d1", "Oak Realty <sam@oakrealty.example>", "Your lease", "Attached.", {
    kind: "document",
    attachments: ["Lease.pdf"],
  }),
];

function world(over: { mails?: FakeMail[]; gmail?: FakeGmailOptions; stepSize?: number; capture?: OnCaptured } = {}) {
  const repo = createMemoryRepository();
  const objectStore = createMemoryObjectStore();
  const indexStore = createMemoryIndexSource();
  const fake = createFakeGmail(over.mails ?? MAILS, over.gmail);
  const gmail = createGmailClient({ fetch: fake.fetch, sleep: async () => undefined });
  const clock = { t: T0 };
  const store = createMemoryImportStore();
  const lines: string[] = [];
  let n = 0;
  const box = createTokenBox(KEY);
  const svc = createImportService({
    store,
    box,
    gmail,
    repo,
    now: () => clock.t,
    newId: () => `job-${++n}`,
    stepSize: over.stepSize ?? 25,
    sleep: async () => new Promise<void>((r) => setTimeout(r, 1)),
    log: (l) => lines.push(l),
    capture:
      over.capture ?? createCaptureIngest({ repo, objectStore, indexStore, now: () => clock.t, log: () => undefined }),
  });
  const hh = async (id = HH) =>
    repo.putHousehold(id, { id, digestOn: true, email: `${id}@x.test`, createdAt: "2026-01-01T00:00:00.000Z" });
  const grant = (id = HH) => ({ householdId: id, accessToken: fake.token, expiresInSec: 3599 });
  /** Steps until the job ends. */
  async function run(id: string, household = HH) {
    let v = await svc.step(household, id);
    for (let i = 0; i < 50 && v && !v.finished; i++) v = await svc.step(household, id);
    return v!;
  }
  return { repo, objectStore, fake, store, svc, clock, lines, hh, grant, run, box };
}

describe("a whole scan", () => {
  it("lists, reads in steps, saves what it finds, spots the documents, then revokes and forgets the token", async () => {
    const w = world({ stepSize: 2 });
    await w.hh();
    const { id } = (await w.svc.start(w.grant())) as { id: string };
    const stored = await w.store.get(id);
    expect(stored?.tokenCipher).toBeTruthy();
    expect(stored?.tokenCipher).not.toContain("ya29");

    const first = await w.svc.step(HH, id);
    expect(first).toMatchObject({ finished: false, counts: { candidates: 4, scanned: 2 } });
    const done = await w.run(id);
    expect(done).toMatchObject({
      status: "done",
      finished: true,
      error: null,
      revoked: true,
      counts: { candidates: 4, scanned: 4, found: 3, skipped: 1, duplicates: 0, failed: 0 },
    });
    expect(done.spotted).toEqual([
      { kind: "lease", subject: "Your lease", sender: "oakrealty.example", date: "2026-10-20", filename: "Lease.pdf" },
    ]);

    // The token is gone and Google was told to end the access, once.
    expect((await w.store.get(id))?.tokenCipher).toBeNull();
    expect(w.fake.calls.revoke).toBe(1);
    expect(w.fake.revoked).toEqual([w.fake.token]);
    expect(w.fake.calls.attachment).toBe(0);

    // What was saved is waiting for confirmation, in this household only, and nothing alerts.
    const agreements = await w.repo.listAgreements(HH);
    expect(agreements).toHaveLength(3);
    for (const a of agreements) expect(Object.values(a.fieldStatus).every((s) => s === "extracted")).toBe(true);
    expect(await w.repo.listAlerts(HH)).toEqual([]);
    expect(await w.repo.listAgreements(OTHER)).toEqual([]);
    expect((await w.repo.getHousehold(HH))?.gmail).toBe("done");
  });

  it("reads at most a step's worth of messages per call", async () => {
    const w = world({ stepSize: 2 });
    await w.hh();
    const { id } = (await w.svc.start(w.grant())) as { id: string };
    await w.svc.step(HH, id);
    expect(w.fake.calls.get).toBe(2);
    // The second step reads the last two, then, because that finishes the job, fetches the one document to list.
    const last = await w.svc.step(HH, id);
    expect(last?.finished).toBe(true);
    expect(w.fake.calls.get).toBe(4 + 1);
  });

  it("a step on a finished job does nothing more", async () => {
    const w = world();
    await w.hh();
    const { id } = (await w.svc.start(w.grant())) as { id: string };
    await w.run(id);
    const calls = w.fake.calls.get + w.fake.calls.list + w.fake.calls.revoke;
    expect((await w.svc.step(HH, id))?.finished).toBe(true);
    expect(w.fake.calls.get + w.fake.calls.list + w.fake.calls.revoke).toBe(calls);
  });

  it("two steps at once do not read anything twice", async () => {
    const w = world({ stepSize: 25 });
    await w.hh();
    const { id } = (await w.svc.start(w.grant())) as { id: string };
    const [a, b] = await Promise.all([w.svc.step(HH, id), w.svc.step(HH, id)]);
    expect([a, b].filter((v) => v?.finished)).toHaveLength(1);
    expect(w.fake.calls.get).toBe(4 + 1);
    expect((await w.svc.view(HH, id))?.counts.scanned).toBe(4);
  });

  it("says nothing to read when the mailbox has no subscription mail, and still revokes", async () => {
    const w = world({ mails: [] });
    await w.hh();
    const { id } = (await w.svc.start(w.grant())) as { id: string };
    expect(await w.run(id)).toMatchObject({
      status: "done",
      counts: { candidates: 0, scanned: 0, found: 0 },
      revoked: true,
    });
  });
});

describe("every way a job can end revokes the token and forgets it", () => {
  it("a refused token in the middle of the scan", async () => {
    const w = world({ stepSize: 2 });
    await w.hh();
    const { id } = (await w.svc.start({ ...w.grant(), accessToken: "ya29.stale-token" })) as { id: string };
    expect(await w.run(id)).toMatchObject({ status: "failed", error: "auth_ended" });
    expect((await w.store.get(id))?.tokenCipher).toBeNull();
    expect((await w.repo.getHousehold(HH))?.gmail).toBeUndefined();
  });

  it("an error thrown while saving", async () => {
    const w = world({
      capture: async () => {
        throw new TypeError("storage down for ya29.fake-access-token");
      },
    });
    await w.hh();
    const { id } = (await w.svc.start(w.grant())) as { id: string };
    expect(await w.run(id)).toMatchObject({ status: "failed", error: "failed", revoked: true });
    expect((await w.store.get(id))?.tokenCipher).toBeNull();
    expect(w.lines.join("\n")).toContain("step failed (TypeError)");
    expect(w.lines.join("\n")).not.toContain("ya29");
  });

  it("a search that fails", async () => {
    const w = world({ gmail: { listFails: 500 } });
    await w.hh();
    const { id } = (await w.svc.start(w.grant())) as { id: string };
    expect(await w.run(id)).toMatchObject({ status: "failed", error: "failed", revoked: true });
    expect((await w.store.get(id))?.tokenCipher).toBeNull();
    expect(w.fake.calls.revoke).toBe(1);
  });

  it("a search the token is refused for is reported as the access having ended", async () => {
    const w = world({ gmail: { listFails: 401 } });
    await w.hh();
    const { id } = (await w.svc.start(w.grant())) as { id: string };
    expect(await w.run(id)).toMatchObject({ status: "failed", error: "auth_ended" });
  });

  it("the person cancelling", async () => {
    const w = world({ stepSize: 1 });
    await w.hh();
    const { id } = (await w.svc.start(w.grant())) as { id: string };
    await w.svc.step(HH, id);
    expect(await w.svc.cancel(HH, id)).toMatchObject({ status: "cancelled", finished: true, revoked: true });
    expect((await w.store.get(id))?.tokenCipher).toBeNull();
    expect(w.fake.calls.revoke).toBe(1);
    // Cancelling again, or stepping, changes nothing.
    await w.svc.cancel(HH, id);
    await w.svc.step(HH, id);
    expect(w.fake.calls.revoke).toBe(1);
  });

  it("a token past its hour: no call to Gmail is made with it", async () => {
    const w = world();
    await w.hh();
    const { id } = (await w.svc.start(w.grant())) as { id: string };
    w.clock.t += 2 * 3600_000;
    expect(await w.svc.step(HH, id)).toMatchObject({ status: "failed", error: "expired" });
    expect(w.fake.calls.list + w.fake.calls.get).toBe(0);
    expect((await w.store.get(id))?.tokenCipher).toBeNull();
  });

  it("the household already holding the most pages it may: finishes with what it has", async () => {
    const w = world();
    await w.hh();
    for (let i = 0; i < MAX_CAPTURED_PAGES; i++) {
      await w.repo.putDoc(HH, {
        id: `doc-old-${i}`,
        s3Key: `captures/${HH}/doc-old-${i}/page.txt`,
        filename: "x.txt",
        docType: "other",
        status: "uploaded",
        uploadedAt: "2026-01-01T00:00:00.000Z",
        assetIds: [],
      });
    }
    const { id } = (await w.svc.start(w.grant())) as { id: string };
    expect(await w.run(id)).toMatchObject({ status: "done", error: "cap", revoked: true });
  });

  it("a sealed token that cannot be opened ends the job", async () => {
    const w = world();
    await w.hh();
    const { id } = (await w.svc.start(w.grant())) as { id: string };
    const j = (await w.store.get(id))!;
    await w.store.update({ ...j, tokenCipher: "v1.garbage.garbage" }, null);
    expect(await w.svc.step(HH, id)).toMatchObject({ status: "failed", error: "failed" });
    expect(w.fake.calls.list).toBe(0);
  });
});

describe("starting", () => {
  it("one finished scan a day: another is refused until a day has passed", async () => {
    const w = world();
    await w.hh();
    const { id } = (await w.svc.start(w.grant())) as { id: string };
    await w.run(id);
    expect(await w.svc.start(w.grant())).toEqual({ refused: "too_soon" });
    w.clock.t += MIN_GAP_MS + 1;
    expect(await w.svc.start(w.grant())).toMatchObject({ id: expect.any(String) });
  });

  it("a scan that failed or was cancelled does not block a new one", async () => {
    const w = world();
    await w.hh();
    const a = (await w.svc.start(w.grant())) as { id: string };
    await w.svc.cancel(HH, a.id);
    expect(await w.svc.start(w.grant())).toMatchObject({ id: expect.any(String) });
  });

  it("coming back to a half finished scan revokes the old token and starts fresh", async () => {
    const w = world({ stepSize: 1 });
    await w.hh();
    const a = (await w.svc.start(w.grant())) as { id: string };
    await w.svc.step(HH, a.id);
    const b = (await w.svc.start(w.grant())) as { id: string };
    expect(b.id).not.toBe(a.id);
    expect((await w.store.get(a.id))?.status).toBe("cancelled");
    expect((await w.store.get(a.id))?.tokenCipher).toBeNull();
    expect(w.fake.calls.revoke).toBe(1);
  });

  it("keeps the lifetime of the token no longer than an hour, whatever Google says", async () => {
    const w = world();
    await w.hh();
    const { id } = (await w.svc.start({ ...w.grant(), expiresInSec: 999_999 })) as { id: string };
    expect((await w.store.get(id))!.tokenExpiresAt - T0).toBeLessThanOrEqual(3600_000);
  });

  it("the lock is released after a step, so the next step can run", async () => {
    const w = world({ stepSize: 1 });
    await w.hh();
    const { id } = (await w.svc.start(w.grant())) as { id: string };
    await w.svc.step(HH, id);
    expect(await w.store.tryLock(id, "next", T0, LOCK_MS)).toBe(true);
  });
});

describe("whose job it is", () => {
  it("another household can neither see, step nor cancel it, and nothing changes", async () => {
    const w = world();
    await w.hh();
    const { id } = (await w.svc.start(w.grant())) as { id: string };
    const before = JSON.stringify(await w.store.get(id));
    expect(await w.svc.view(OTHER, id)).toBeNull();
    expect(await w.svc.step(OTHER, id)).toBeNull();
    expect(await w.svc.cancel(OTHER, id)).toBeNull();
    expect(JSON.stringify(await w.store.get(id))).toBe(before);
    expect(w.fake.calls.list + w.fake.calls.get + w.fake.calls.revoke).toBe(0);
    expect(await w.svc.view(HH, "no-such-job")).toBeNull();
  });

  it("the latest job is the household's own", async () => {
    const w = world();
    await w.hh();
    await w.hh(OTHER);
    const a = (await w.svc.start(w.grant())) as { id: string };
    expect((await w.svc.latest(HH))?.id).toBe(a.id);
    expect(await w.svc.latest(OTHER)).toBeNull();
  });
});

describe("what the person and the log are shown", () => {
  it("the view holds counts and outcomes, no message id, no token and no sealed text", async () => {
    const w = world();
    await w.hh();
    const { id } = (await w.svc.start(w.grant())) as { id: string };
    const v = await w.run(id);
    const text = JSON.stringify(v);
    expect(text).not.toMatch(/ya29|v1\.|m1|m2|"remaining"|tokenCipher/);
  });

  it("the log has counts and error names only", async () => {
    const w = world();
    await w.hh();
    const { id } = (await w.svc.start(w.grant())) as { id: string };
    await w.run(id);
    const log = w.lines.join("\n");
    expect(log).toMatch(/done scanned=4 found=3 revoked=true/);
    expect(log).not.toMatch(/ya29|kestrel|fernwood|cedar|lease|@|job-1/i);
  });
});

describe("saying no", () => {
  it("is remembered on the household, and a scan is not started", async () => {
    const w = world();
    await w.hh();
    await w.svc.decline(HH);
    expect((await w.repo.getHousehold(HH))?.gmail).toBe("declined");
    expect(w.fake.calls.list).toBe(0);
  });
});

describe("what the review found", () => {
  it("a cancel while a step is working stays cancelled: the step writes nothing and the token is not brought back", async () => {
    let cancelled = false;
    let svcRef: ReturnType<typeof world>["svc"] | undefined;
    let jobId = "";
    const w = world({
      stepSize: 25,
      capture: async () => {
        if (!cancelled) {
          cancelled = true;
          await svcRef!.cancel(HH, jobId);
        }
        return { status: "none" };
      },
    });
    svcRef = w.svc;
    await w.hh();
    jobId = ((await w.svc.start(w.grant())) as { id: string }).id;
    const seen = await w.svc.step(HH, jobId);
    expect(seen).toMatchObject({ status: "cancelled", finished: true });
    const stored = await w.store.get(jobId);
    expect(stored).toMatchObject({ status: "cancelled", tokenCipher: null, remaining: [] });
    // Revoking twice (the cancel, then the step finishing) is harmless: Google ignores a token it already revoked.
    expect(w.fake.revoked.length).toBeGreaterThanOrEqual(1);
    expect(new Set(w.fake.revoked).size).toBe(1);
  });

  it("a step that finds the job busy says so and does no work, and does not call beforeWork", async () => {
    const w = world();
    await w.hh();
    const { id } = (await w.svc.start(w.grant())) as { id: string };
    expect(await w.store.tryLock(id, "other-tab", w.clock.t, LOCK_MS)).toBe(true);
    let charged = 0;
    const v = await w.svc.step(HH, id, async () => void charged++);
    expect(v).toMatchObject({ busy: true, status: "running" });
    expect(charged).toBe(0);
    expect(w.fake.calls.list).toBe(0);
  });

  it("beforeWork refusing stops the step without ending the job, and lets the next one run", async () => {
    const w = world();
    await w.hh();
    const { id } = (await w.svc.start(w.grant())) as { id: string };
    await expect(
      w.svc.step(HH, id, async () => {
        throw new Error("limit");
      }),
    ).rejects.toThrow("limit");
    expect((await w.store.get(id))?.status).toBe("running");
    expect(w.fake.calls.list).toBe(0);
    expect((await w.svc.step(HH, id))?.busy).toBeUndefined();
  });

  it("a refused second scan gives the access back to Google at once", async () => {
    const w = world();
    await w.hh();
    const { id } = (await w.svc.start(w.grant())) as { id: string };
    await w.run(id);
    const before = w.fake.revoked.length;
    expect(await w.svc.start(w.grant())).toEqual({ refused: "too_soon" });
    expect(w.fake.revoked.length).toBe(before + 1);
  });

  it("reading a job whose token has run out ends it and deletes the sealed copy, without waiting for the cleanup", async () => {
    const w = world();
    await w.hh();
    const { id } = (await w.svc.start(w.grant())) as { id: string };
    w.clock.t += 3600_000;
    expect(await w.svc.view(HH, id)).toMatchObject({ status: "failed", error: "expired", finished: true });
    expect((await w.store.get(id))?.tokenCipher).toBeNull();
    const again = (await w.svc.start(w.grant())) as { id: string };
    w.clock.t += 3600_000;
    expect((await w.svc.latest(HH))?.error).toBe("expired");
    expect((await w.store.get(again.id))?.tokenCipher).toBeNull();
  });

  it("delete all data ends a running scan, revokes it and deletes the records, and touches no other household", async () => {
    const w = world();
    await w.hh();
    await w.hh(OTHER);
    const { id } = (await w.svc.start(w.grant())) as { id: string };
    const other = (await w.svc.start(w.grant(OTHER))) as { id: string };
    await w.svc.step(HH, id);
    await w.svc.forget(HH);
    expect(await w.store.get(id)).toBeNull();
    expect(await w.store.latestFor(HH)).toBeNull();
    expect(w.fake.revoked).toHaveLength(1);
    expect(await w.store.get(other.id)).toMatchObject({ status: "running" });
    // A step that was in flight finds nothing and writes nothing.
    expect(await w.svc.step(HH, id)).toBeNull();
  });

  it("delete all data also removes a finished scan's record, spotted list and all", async () => {
    const w = world();
    await w.hh();
    const { id } = (await w.svc.start(w.grant())) as { id: string };
    await w.run(id);
    expect((await w.store.get(id))?.spotted.length).toBeGreaterThan(0);
    await w.svc.forget(HH);
    expect(await w.store.get(id)).toBeNull();
  });
});

describe("what the second review found: a step must not outlive its lock or a delete", () => {
  it("a step whose lock was taken over stops before the next message and writes nothing over the new owner", async () => {
    let saved = 0;
    let svcRef: ReturnType<typeof world>["svc"] | undefined;
    let w!: ReturnType<typeof world>;
    let jobId = "";
    w = world({
      stepSize: 25,
      capture: async () => {
        saved++;
        if (saved === 1) {
          // This step took so long that its lease ran out, and another tab took the job over.
          w.clock.t += LOCK_MS + 1;
          expect(await w.store.tryLock(jobId, "other-tab", w.clock.t, LOCK_MS)).toBe(true);
        }
        return { status: "none" };
      },
    });
    svcRef = w.svc;
    void svcRef;
    await w.hh();
    jobId = ((await w.svc.start(w.grant())) as { id: string }).id;
    await w.svc.step(HH, jobId);
    // One page was already being saved when it was taken over; no second one is started.
    expect(saved).toBe(1);
    const stored = await w.store.get(jobId);
    expect(stored).toMatchObject({ status: "running", counts: { scanned: 0, found: 0 } });
    expect(stored?.remaining.length).toBe(stored?.counts.candidates);
    // The new owner still holds the lock: the old step's release did nothing.
    expect(await w.store.tryLock(jobId, "third", w.clock.t, LOCK_MS)).toBe(false);
  });

  it("keeps the lease alive while a step works, so a long step is not taken over", async () => {
    let w!: ReturnType<typeof world>;
    let jobId = "";
    let stolen: boolean | undefined;
    w = world({
      capture: async () => {
        // 50 s into a step the lease is 60 s from the last renewal, not from the start.
        w.clock.t += 50_000;
        stolen = await w.store.tryLock(jobId, "other-tab", w.clock.t, LOCK_MS);
        return { status: "none" };
      },
    });
    await w.hh();
    jobId = ((await w.svc.start(w.grant())) as { id: string }).id;
    await w.svc.step(HH, jobId);
    expect(stolen).toBe(false);
  });

  it("delete all data during a step: the step stops before saving another page, and the delete finishes after it", async () => {
    let calls = 0;
    let forgetting: Promise<boolean> | undefined;
    let w!: ReturnType<typeof world>;
    w = world({
      capture: async () => {
        calls++;
        if (calls === 1) forgetting = w.svc.forget(HH);
        // Let the delete reach its wait.
        await new Promise((r) => setTimeout(r, 5));
        return { status: "none" };
      },
    });
    await w.hh();
    const { id } = (await w.svc.start(w.grant())) as { id: string };
    await w.svc.step(HH, id);
    expect(await forgetting).toBe(true);
    expect(calls).toBe(1);
    expect(await w.store.latestFor(HH)).toBeNull();
    expect((await w.repo.listDocs(HH)).length).toBe(0);
    expect(w.fake.revoked.length).toBeGreaterThanOrEqual(1);
  });

  it("delete all data says no, and deletes nothing, while a step is still holding the job", async () => {
    const w = world();
    await w.hh();
    const { id } = (await w.svc.start(w.grant())) as { id: string };
    expect(await w.store.tryLock(id, "stuck-step", w.clock.t, 10 * LOCK_MS)).toBe(true);
    expect(await w.svc.forget(HH)).toBe(false);
    // The scan itself is ended and its access revoked, but its record is still there until the step lets go.
    expect(await w.store.get(id)).toMatchObject({ status: "cancelled", tokenCipher: null });
    expect(w.fake.revoked.length).toBe(1);
    await w.store.unlock(id, "stuck-step");
    expect(await w.svc.forget(HH)).toBe(true);
    expect(await w.store.get(id)).toBeNull();
  });
});
