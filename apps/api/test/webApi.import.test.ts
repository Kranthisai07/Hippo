import { readFileSync } from "node:fs";
import { createCaptureIngest } from "../../workers/src/ingest/capture";
import { describe, expect, it } from "vitest";
import { createGmailClient } from "../src/import/gmail";
import { createImportService, type ImportService } from "../src/import/service";
import { createMemoryImportStore } from "../src/import/store";
import { createTokenBox } from "../src/import/tokenBox";
import { A } from "./helpers";
import { createFakeGmail, type FakeMail } from "./fakeGmail";
import { json, makeWeb } from "./webHelpers";

// The import routes: session only, the household from the session, a job of another household is a plain 404, and
// nothing a route returns holds an id of a message, an address or a token.

const MAILS: FakeMail[] = [
  {
    id: "m1",
    from: "Fernwood Streaming <billing@account.fernwood-streaming.example>",
    subject: "Your bill",
    text: /<body>([\s\S]*)<\/body>/
      .exec(readFileSync(new URL("../../../fixtures/pages/fernwood_billing.html", import.meta.url), "utf8"))![1]!
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<[^>]+>/g, "\n")
      .replaceAll("&gt;", ">"),
    kind: "subscription",
  },
];

async function setup() {
  const ref: { svc?: ImportService } = {};
  const lazy = new Proxy({} as ImportService, { get: (_t, k) => (ref.svc as never)[k] });
  const w = await makeWeb({ web: { importService: lazy } });
  const fake = createFakeGmail(MAILS);
  const { createMemoryObjectStore } = await import("../src/api/storage");
  const { createMemoryIndexSource } = await import("../src/mcp/indexCache");
  const objectStore = createMemoryObjectStore();
  const indexStore = createMemoryIndexSource();
  let n = 0;
  ref.svc = createImportService({
    store: createMemoryImportStore(),
    box: createTokenBox("route-test-key-route-test-key-route-test"),
    gmail: createGmailClient({ fetch: fake.fetch, sleep: async () => undefined }),
    repo: w.repo,
    now: () => w.clock.t,
    newId: () => `job-${++n}`,
    capture: createCaptureIngest({ repo: w.repo, objectStore, indexStore, now: () => w.clock.t, log: () => undefined }),
  });
  const start = async (householdId = A) => {
    const r = await ref.svc!.start({ householdId, accessToken: fake.token, expiresInSec: 3599 });
    return (r as { id: string }).id;
  };
  return { w, fake, start };
}

describe("the import routes", () => {
  it("need a session", async () => {
    const { w } = await setup();
    for (const [m, p] of [
      ["GET", "/api/import/latest"],
      ["GET", "/api/import/x"],
      ["POST", "/api/import/x/step"],
      ["POST", "/api/import/x/cancel"],
      ["POST", "/api/import/decline"],
    ] as const) {
      const r = await w.app.request(`http://api.hippo.test${p}`, {
        method: m,
        headers: { origin: "http://api.hippo.test" },
      });
      expect(r.status, `${m} ${p}`).toBe(401);
    }
  });

  it("run a whole scan in steps and end with the access revoked and no secret in any answer", async () => {
    const { w, fake, start } = await setup();
    const id = await start();
    const first = await json(await w.a.get(`/api/import/${id}`));
    expect(first).toMatchObject({ id, status: "running", finished: false });
    let v = (await json(await w.a.send("POST", `/api/import/${id}/step`, {}))) as { finished: boolean };
    for (let i = 0; i < 20 && !v.finished; i++) {
      v = (await json(await w.a.send("POST", `/api/import/${id}/step`, {}))) as { finished: boolean };
    }
    expect(v).toMatchObject({ status: "done", finished: true, revoked: true });
    // The demo household already has Fernwood, so the one mail is counted as a duplicate, not saved twice.
    expect(v).toMatchObject({ counts: { candidates: 1, scanned: 1, duplicates: 1, found: 0, failed: 0 } });
    expect(fake.revoked).toHaveLength(1);
    const latest = JSON.stringify(await json(await w.a.get("/api/import/latest")));
    expect(latest).not.toContain(fake.token);
    expect(latest).not.toContain("m1");
    expect(latest).not.toContain("fernwood-streaming.example");
    expect(await json(await w.a.get("/api/me"))).toMatchObject({ gmail: "done" });
  });

  it("answer 404 for a job of another household, for reading, stepping and cancelling", async () => {
    const { w, fake, start } = await setup();
    const id = await start(A);
    for (const [m, p] of [
      ["GET", `/api/import/${id}`],
      ["POST", `/api/import/${id}/step`],
      ["POST", `/api/import/${id}/cancel`],
    ] as const) {
      const r = await w.b.call(p, { method: m, ...(m === "POST" ? { json: {} } : {}) });
      expect(r.status, `${m} ${p}`).toBe(404);
    }
    // Nothing happened to it: still running, token not revoked.
    expect(await json(await w.a.get(`/api/import/${id}`))).toMatchObject({ status: "running" });
    expect(fake.revoked).toHaveLength(0);
    expect(await json(await w.b.get("/api/import/latest"))).toEqual({ import: null });
  });

  it("cancel ends the job and revokes", async () => {
    const { w, fake, start } = await setup();
    const id = await start();
    const r = await w.a.send("POST", `/api/import/${id}/cancel`, {});
    expect(await json(r)).toMatchObject({ status: "cancelled", finished: true, revoked: true });
    expect(fake.revoked).toHaveLength(1);
  });

  it("decline is remembered and shown by /api/me", async () => {
    const { w } = await setup();
    await w.repo.putHousehold("hh_other", {
      id: "hh_other",
      digestOn: true,
      email: "other@hippo.test",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(await json(await w.b.get("/api/me"))).toMatchObject({ gmail: "offer" });
    expect((await w.b.send("POST", "/api/import/decline", {})).status).toBe(200);
    expect(await json(await w.b.get("/api/me"))).toMatchObject({ gmail: "declined" });
  });

  it("refuse a write from another origin", async () => {
    const { w } = await setup();
    const r = await w.a.call("/api/import/decline", { method: "POST", json: {}, origin: "http://evil.example" });
    expect(r.status).toBe(403);
  });

  it("are a plain 404 when the import is off", async () => {
    const w = await makeWeb();
    expect((await w.a.get("/api/import/latest")).status).toBe(404);
    expect((await w.a.send("POST", "/api/import/decline", {})).status).toBe(404);
    expect(await json(await w.a.get("/api/me"))).toMatchObject({ gmail: "off" });
  });
});
