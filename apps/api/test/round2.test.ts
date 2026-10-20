import { describe, expect, it } from "vitest";
import { createLocalUploader, createMemoryObjectStore, type ObjectStore } from "../src/api/storage";
import { askDocuments } from "../src/mcp/tools/askDocuments";
import { fixture, json, makeWeb } from "./webHelpers";

// Round 2 review findings on the web API.

/** A store whose deletes can be made to fail, to see what a half finished delete leaves behind. */
const flakyStore = () => {
  const inner = createMemoryObjectStore();
  const state = { failDelete: false };
  const store: ObjectStore & { keys(): string[] } = {
    ...inner,
    delete: async (keys) => {
      if (state.failDelete) throw new Error("storage is down");
      await inner.delete(keys);
    },
  };
  return { store, state };
};

describe("deleting is retryable when the object store fails", () => {
  it("DELETE /docs/:id: a storage failure leaves the document in place so a retry works", async () => {
    const { store, state } = flakyStore();
    const w = await makeWeb({ web: { objectStore: store } });
    const { docId } = await w.upload(w.b, "lease.pdf", fixture("lease.pdf"));
    const keysBefore = store.keys();
    expect(keysBefore.length).toBeGreaterThan(0);

    state.failDelete = true;
    const failed = await w.b.send("DELETE", `/api/docs/${docId}`, undefined);
    expect(failed.status).toBe(500);
    expect((await w.b.get(`/api/docs/${docId}`)).status).toBe(200);
    expect(store.keys()).toEqual(keysBefore);

    state.failDelete = false;
    expect((await w.b.send("DELETE", `/api/docs/${docId}`, undefined)).status).toBe(204);
    expect((await w.b.get(`/api/docs/${docId}`)).status).toBe(404);
    expect(store.keys().filter((k) => k.includes(docId))).toEqual([]);
  });

  it("DELETE /data: a storage failure keeps the data so a retry works", async () => {
    const { store, state } = flakyStore();
    const w = await makeWeb({ web: { objectStore: store } });
    await w.upload(w.b, "lease.pdf", fixture("lease.pdf"));
    state.failDelete = true;
    const failed = await w.b.send("DELETE", "/api/data", { confirm: "delete all my data" });
    expect(failed.status).toBe(500);
    expect(((await json(await w.b.get("/api/docs"))) as any).docs).toHaveLength(1);

    state.failDelete = false;
    expect((await w.b.send("DELETE", "/api/data", { confirm: "delete all my data" })).status).toBe(204);
    expect(((await json(await w.b.get("/api/docs"))) as any).docs).toHaveLength(0);
    expect(store.keys().filter((k) => k.includes("other"))).toEqual([]);
  });
});

describe("page text is masked like every other answer", () => {
  it("GET /docs/:id/pages/:n does not return a full policy number", async () => {
    const w = await makeWeb();
    const { docId } = await w.upload(w.b, "insurance_auto.pdf", fixture("insurance_auto.pdf"));
    const r = await json(await w.b.get(`/api/docs/${docId}/pages/1`));
    expect(r.text).not.toContain("HM-AU-0048-4821");
    expect(r.text).toContain("ending 4821");
    expect(r.text).toContain("Harbor Mutual");
  });
});

describe("an unreviewed document is not answerable", () => {
  it("ask_documents finds nothing in a needs_review document until it is activated", async () => {
    const w = await makeWeb();
    // The seeded household already has this lease; a second copy under another name shows which document answered.
    const { docId } = await w.upload(w.a, "second_lease.pdf", fixture("lease.pdf"));
    const view = await json(await w.a.get(`/api/docs/${docId}`));
    expect(view.doc.status).toBe("needs_review");
    const ctx = w.ctxFor("hh_demo");
    const ask = () => askDocuments(ctx, { question: "how many days notice do I have to give to vacate the lease" });

    const before = JSON.stringify(await ask());
    expect(before).toContain("sixty (60) days");
    expect(before).not.toContain("second_lease.pdf");

    const names = view.agreement.fields.map((f: { name: string }) => f.name);
    const confirmed = await w.a.send("POST", `/api/agreements/${view.agreement.id}/confirm`, { fields: names });
    expect(confirmed.status).toBe(200);
    expect((await json(await w.a.get(`/api/docs/${docId}`))).doc.status).toBe("active");

    const ctx2 = w.ctxFor("hh_demo");
    expect(
      JSON.stringify(
        await askDocuments(ctx2, { question: "how many days notice do I have to give to vacate the lease" }),
      ),
    ).toContain("second_lease.pdf");
  });
});

describe("the JSON content type is matched exactly", () => {
  it("refuses application/jsonx and similar, accepts a charset parameter", async () => {
    const w = await makeWeb();
    const put = (type: string) =>
      w.b.call("/api/settings", { method: "PUT", body: JSON.stringify({ digestOn: false }), type });
    for (const bad of ["application/jsonx", "application/json-patch+json", "application/jsonp", "text/json"]) {
      expect((await put(bad)).status, bad).toBe(415);
    }
    expect((await put("application/json; charset=utf-8")).status).toBe(200);
    expect((await put("Application/JSON")).status).toBe(200);
  });
});

describe("the upload link expires", () => {
  it("rejects the PUT once the announced expiry has passed", async () => {
    const clock = { t: Date.parse("2026-10-21T12:00:00Z") };
    const uploader = createLocalUploader({ now: () => clock.t });
    const w = await makeWeb({ web: { uploader } });
    const bytes = fixture("lease.pdf");
    const r = await w.b.send("POST", "/api/uploads", {
      filename: "lease.pdf",
      contentType: "application/pdf",
      size: bytes.length,
    });
    const { upload } = (await r.json()) as { docId: string; upload: { url: string; expiresInSeconds: number } };
    expect(upload.expiresInSeconds).toBe(900);

    clock.t += 901_000;
    const late = await w.b.call(upload.url, { method: "PUT", body: bytes as BodyInit, type: "application/pdf" });
    expect(late.status).toBeGreaterThanOrEqual(400);
    expect(late.status).toBeLessThan(500);
  });

  it("accepts the PUT just before the expiry", async () => {
    const clock = { t: Date.parse("2026-10-21T12:00:00Z") };
    const uploader = createLocalUploader({ now: () => clock.t });
    const w = await makeWeb({ web: { uploader } });
    const bytes = fixture("lease.pdf");
    const r = await w.b.send("POST", "/api/uploads", {
      filename: "lease.pdf",
      contentType: "application/pdf",
      size: bytes.length,
    });
    const { upload } = (await r.json()) as { upload: { url: string } };
    clock.t += 899_000;
    expect(
      (await w.b.call(upload.url, { method: "PUT", body: bytes as BodyInit, type: "application/pdf" })).status,
    ).toBe(204);
  });
});
