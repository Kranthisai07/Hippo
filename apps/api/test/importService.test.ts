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
    await w.store.update({ ...j, tokenCipher: "v1.garbage.garbage" });
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
    expect(await w.store.tryLock(id, T0, LOCK_MS)).toBe(true);
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
