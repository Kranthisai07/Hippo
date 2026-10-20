import { beforeEach, describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES, createLocalUploader, createMemoryObjectStore, sanitizeFilename } from "../src/api/storage";
import { UPLOADS_PER_HOUR } from "../src/api/routes";
import { PDF_BYTES, fixture, json, makeWeb, type Web } from "./webHelpers";

let w: Web;
beforeEach(async () => {
  w = await makeWeb();
});

const announce = (body: unknown) => w.a.send("POST", "/api/uploads", body);
const pdf = (n = 10) => ({ filename: "a.pdf", contentType: "application/pdf", size: n });
const bytes = (n: number, head = [0x25, 0x50, 0x44, 0x46, 0x2d]) => {
  const b = new Uint8Array(n);
  head.slice(0, n).forEach((x, i) => (b[i] = x));
  return b;
};

describe("POST /api/uploads", () => {
  it("creates an uploaded doc and returns a local PUT descriptor", async () => {
    const r = await announce(pdf(PDF_BYTES.length));
    expect(r.status).toBe(201);
    const { docId, upload } = await json(r);
    expect(docId).toMatch(/^doc-/);
    expect(upload).toEqual({
      method: "PUT",
      url: `/api/uploads/${docId}/content`,
      headers: { "Content-Type": "application/pdf" },
      expiresInSeconds: 900,
    });
    const doc = await json(await w.a.get(`/api/docs/${docId}`));
    expect(doc.doc).toMatchObject({ id: docId, status: "uploaded", filename: "a.pdf", assetIds: [] });
    expect(doc.agreement).toBeNull();
  });

  it("does not return the storage key to the browser", async () => {
    const { docId } = await json(await announce(pdf()));
    const doc = await json(await w.a.get(`/api/docs/${docId}`));
    expect(JSON.stringify(doc)).not.toContain("uploads/");
    expect(doc.doc.s3Key).toBeUndefined();
    expect(JSON.stringify(await json(await w.a.get("/api/docs")))).not.toContain("s3Key");
  });

  it("stores the doc under uploads/<household>/<docId>/ with a key made from ids", async () => {
    const { docId } = await json(
      await announce({ filename: "My Lease.pdf", contentType: "application/pdf", size: 10 }),
    );
    const doc = await w.repo.getDoc("hh_demo", docId);
    expect(doc?.s3Key).toBe(`uploads/hh_demo/${docId}/original.pdf`);
  });

  it.each([
    ["application/pdf", "pdf"],
    ["image/jpeg", "jpg"],
    ["image/png", "png"],
  ])("accepts %s", async (contentType, ext) => {
    const r = await announce({ filename: "x", contentType, size: 100 });
    expect(r.status).toBe(201);
    const { docId } = await json(r);
    expect((await w.repo.getDoc("hh_demo", docId))?.s3Key).toMatch(new RegExp(`original\\.${ext}$`));
  });

  it("accepts a content type in capitals", async () => {
    expect((await announce({ filename: "x.pdf", contentType: "Application/PDF", size: 5 })).status).toBe(201);
  });

  it.each(["image/heic", "image/heif", "IMAGE/HEIC"])("%s is 415 and says to convert to JPEG", async (contentType) => {
    const r = await announce({ filename: "IMG_1.HEIC", contentType, size: 100 });
    expect(r.status).toBe(415);
    const body = await json(r);
    expect(body.error.code).toBe("unsupported_type");
    expect(body.error.message).toMatch(/HEIC/);
    expect(body.error.message).toMatch(/JPEG/);
  });

  it("a .heic name with a generic type is still HEIC", async () => {
    const r = await announce({ filename: "IMG_1.heic", contentType: "application/octet-stream", size: 100 });
    expect(r.status).toBe(415);
    expect((await json(r)).error.message).toMatch(/JPEG/);
  });

  it.each([
    "text/html",
    "image/gif",
    "application/zip",
    "application/octet-stream",
    "image/svg+xml",
    "text/plain",
    "application/pdf; x=1",
  ])("%s is 415", async (contentType) => {
    const r = await announce({ filename: "x", contentType, size: 100 });
    expect(r.status).toBe(415);
  });

  it("no doc is created for a refused upload", async () => {
    await announce({ filename: "x", contentType: "text/html", size: 100 });
    await announce({ filename: "x.pdf", contentType: "application/pdf", size: 0 });
    expect((await w.repo.listDocs("hh_demo")).length).toBe(5);
  });

  it("size 0 is 400", async () => {
    const r = await announce(pdf(0));
    expect(r.status).toBe(400);
    expect((await json(r)).error.code).toBe("invalid_request");
  });

  it("size 1 is fine", async () => {
    expect((await announce(pdf(1))).status).toBe(201);
  });

  it("size 15 MB is fine", async () => {
    expect((await announce(pdf(MAX_UPLOAD_BYTES))).status).toBe(201);
  });

  it("size 15 MB + 1 is 413", async () => {
    const r = await announce(pdf(MAX_UPLOAD_BYTES + 1));
    expect(r.status).toBe(413);
    expect((await json(r)).error.code).toBe("too_large");
  });

  it.each([-1, 1.5, "10", null, Number.MAX_SAFE_INTEGER * 2 + 0.5])("size %j is rejected", async (size) => {
    const r = await announce({ filename: "a.pdf", contentType: "application/pdf", size });
    expect([400, 413]).toContain(r.status);
  });

  it.each([
    [{ contentType: "application/pdf", size: 5 }],
    [{ filename: "a.pdf", size: 5 }],
    [{ filename: "a.pdf", contentType: "application/pdf" }],
    [{ filename: "", contentType: "application/pdf", size: 5 }],
    [{ filename: 5, contentType: "application/pdf", size: 5 }],
    [{ filename: "a.pdf", contentType: "application/pdf", size: 5, key: "uploads/hh_other/x" }],
    [{ filename: "a".repeat(1025), contentType: "application/pdf", size: 5 }],
  ])("a bad body %j is 400", async (body) => {
    expect((await announce(body)).status).toBe(400);
  });

  it(`the ${UPLOADS_PER_HOUR + 1}th upload within an hour is 429`, async () => {
    for (let i = 0; i < UPLOADS_PER_HOUR; i++) expect((await announce(pdf(5))).status).toBe(201);
    const r = await announce(pdf(5));
    expect(r.status).toBe(429);
    expect((await json(r)).error.code).toBe("rate_limited");
    expect(r.headers.get("retry-after")).not.toBeNull();
  });

  it("the limit is per household and clears after an hour", async () => {
    for (let i = 0; i < UPLOADS_PER_HOUR; i++) await announce(pdf(5));
    expect((await w.b.send("POST", "/api/uploads", pdf(5))).status).toBe(201);
    w.clock.t += 3_600_001;
    // the session lives 7 days, so the same cookie still works
    expect((await announce(pdf(5))).status).toBe(201);
  });
});

describe("filename hostility", () => {
  it.each([
    ["../../etc/passwd", "passwd"],
    ["..\\..\\windows\\system32\\cmd.exe", "cmd.exe"],
    ["/abs/path/file.pdf", "file.pdf"],
    ["C:\\Users\\me\\lease.pdf", "lease.pdf"],
    ["na\u0000me.pdf", "name.pdf"],
    ["bell\u0007\u001b[31m.pdf", "bell[31m.pdf"],
    ["evil\u202Efdp.exe", "evilfdp.exe"],
    ["zero\u200Bwidth.pdf", "zerowidth.pdf"],
    ["...hidden.pdf", "hidden.pdf"],
    ["   spaced   out.pdf  ", "spaced out.pdf"],
    ["line\nbreak\r\n.pdf", "linebreak.pdf"],
    ["", "document.pdf"],
    ["...", "document.pdf"],
    ["/", "document.pdf"],
  ])("sanitizes %j", (raw, expected) => {
    expect(sanitizeFilename(raw, "pdf")).toBe(expected);
  });

  it("limits the length and keeps the extension", () => {
    const out = sanitizeFilename(`${"a".repeat(500)}.pdf`, "pdf");
    expect(out.length).toBe(100);
    expect(out.endsWith(".pdf")).toBe(true);
  });

  it("limits a very long name with no extension", () => {
    expect(sanitizeFilename("b".repeat(500), "pdf").length).toBe(100);
  });

  it("keeps ordinary unicode names", () => {
    expect(sanitizeFilename("Bail \u00e9t\u00e9 \u5951\u7d04.pdf", "pdf")).toBe("Bail \u00e9t\u00e9 \u5951\u7d04.pdf");
  });

  it("normalises to NFC", () => {
    expect(sanitizeFilename("e\u0301.pdf", "pdf")).toBe("\u00e9.pdf");
  });

  it("the stored doc keeps only the clean display name and the key never has the raw name", async () => {
    const raw = "../../evil\u0000 name\u202E.pdf";
    const { docId } = await json(await announce({ filename: raw, contentType: "application/pdf", size: 5 }));
    const doc = await w.repo.getDoc("hh_demo", docId);
    expect(doc?.filename).toBe("evil name.pdf");
    expect(doc?.s3Key).not.toContain("evil");
    expect(doc?.s3Key).not.toContain("..");
    expect(doc?.s3Key.startsWith("uploads/hh_demo/")).toBe(true);
  });

  it("HTML in a filename comes back as plain text in JSON", async () => {
    const { docId } = await json(
      await announce({ filename: "<img src=x onerror=alert(1)>.pdf", contentType: "application/pdf", size: 5 }),
    );
    const r = await w.a.get(`/api/docs/${docId}`);
    expect(r.headers.get("content-type")).toMatch(/application\/json/);
    expect((await json(r)).doc.filename).toBe("<img src=x onerror=alert(1)>.pdf");
  });
});

describe("PUT /api/uploads/<docId>/content", () => {
  const put = (docId: string, body: Uint8Array, type = "application/pdf") =>
    w.a.call(`/api/uploads/${docId}/content`, { method: "PUT", body: body as BodyInit, type });

  it("stores the bytes, runs the hook and answers 204", async () => {
    const calls: unknown[] = [];
    w = await makeWeb({ web: { onUploaded: (e) => void calls.push(e) } });
    const { docId } = await json(await announce(pdf(PDF_BYTES.length)));
    const r = await put(docId, PDF_BYTES);
    expect(r.status).toBe(204);
    expect(calls).toEqual([{ householdId: "hh_demo", docId }]);
    expect(w.objectStore.keys()).toContain(`uploads/hh_demo/${docId}/original.pdf`);
  });

  it("a wrong content type is 415 and nothing is stored", async () => {
    const { docId } = await json(await announce(pdf(PDF_BYTES.length)));
    const r = await put(docId, PDF_BYTES, "image/png");
    expect(r.status).toBe(415);
    expect(w.objectStore.keys().some((k) => k.includes(docId))).toBe(false);
  });

  it("a content type with parameters is not the exact type", async () => {
    const { docId } = await json(await announce(pdf(PDF_BYTES.length)));
    expect((await put(docId, PDF_BYTES, "application/pdf; charset=utf-8")).status).toBe(415);
  });

  it("fewer bytes than declared is 400", async () => {
    const { docId } = await json(await announce(pdf(PDF_BYTES.length + 5)));
    expect((await put(docId, PDF_BYTES)).status).toBe(400);
  });

  it("more bytes than declared is 413 and stops reading", async () => {
    const { docId } = await json(await announce(pdf(PDF_BYTES.length - 3)));
    const r = await put(docId, PDF_BYTES);
    expect(r.status).toBe(413);
    expect(w.objectStore.keys().some((k) => k.includes(docId))).toBe(false);
  });

  it("more bytes than declared is 413 with no Content-Length (streamed)", async () => {
    const { docId } = await json(await announce(pdf(8)));
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(bytes(8));
        c.enqueue(bytes(8));
        c.close();
      },
    });
    const r = await w.a.call(`/api/uploads/${docId}/content`, {
      method: "PUT",
      body: stream as BodyInit,
      type: "application/pdf",
    });
    expect(r.status).toBe(413);
  });

  it("a failed attempt can be retried", async () => {
    const { docId } = await json(await announce(pdf(PDF_BYTES.length)));
    expect((await put(docId, bytes(3))).status).toBe(400);
    expect((await put(docId, PDF_BYTES)).status).toBe(204);
  });

  it("a second PUT is 409", async () => {
    const { docId } = await json(await announce(pdf(PDF_BYTES.length)));
    expect((await put(docId, PDF_BYTES)).status).toBe(204);
    const again = await put(docId, PDF_BYTES);
    expect(again.status).toBe(409);
    expect((await json(again)).error.code).toBe("conflict");
  });

  it("two PUTs at the same time store one", async () => {
    const { docId } = await json(await announce(pdf(PDF_BYTES.length)));
    const [x, y] = await Promise.all([put(docId, PDF_BYTES), put(docId, PDF_BYTES)]);
    expect([x.status, y.status].sort()).toEqual([204, 409]);
  });

  it("a PUT to a doc that does not exist is 404", async () => {
    expect((await put("doc-nope", PDF_BYTES)).status).toBe(404);
  });

  it("a PUT to a seeded active doc is 409 (it already has its file)", async () => {
    expect((await put("doc-lease", PDF_BYTES)).status).toBe(409);
  });

  it("PUT for another household's doc is 404 and stores nothing", async () => {
    const { docId } = await json(await announce(pdf(PDF_BYTES.length)));
    const r = await w.b.call(`/api/uploads/${docId}/content`, {
      method: "PUT",
      body: PDF_BYTES as BodyInit,
      type: "application/pdf",
    });
    expect(r.status).toBe(404);
    expect(w.objectStore.keys().some((k) => k.includes(docId))).toBe(false);
    expect((await put(docId, PDF_BYTES)).status).toBe(204);
  });

  it("a PUT needs the same origin as any write", async () => {
    const { docId } = await json(await announce(pdf(PDF_BYTES.length)));
    const r = await w.a.call(`/api/uploads/${docId}/content`, {
      method: "PUT",
      body: PDF_BYTES as BodyInit,
      type: "application/pdf",
      origin: "https://evil.example",
    });
    expect(r.status).toBe(403);
  });

  it("a PUT without a session is 401", async () => {
    const { docId } = await json(await announce(pdf(PDF_BYTES.length)));
    const r = await w.anon.call(`/api/uploads/${docId}/content`, {
      method: "PUT",
      body: PDF_BYTES as BodyInit,
      type: "application/pdf",
    });
    expect(r.status).toBe(401);
  });

  it.each([
    ["application/pdf", [0x4d, 0x5a, 0x90, 0x00, 0x03]],
    ["image/jpeg", [0x25, 0x50, 0x44, 0x46, 0x2d]],
    ["image/png", [0xff, 0xd8, 0xff, 0xe0, 0x00]],
  ])("%s bytes that are something else are 415", async (type, head) => {
    const { docId } = await json(await announce({ filename: "x", contentType: type, size: 20 }));
    const r = await put(docId, bytes(20, head), type);
    expect(r.status).toBe(415);
    expect(w.objectStore.keys().some((k) => k.includes(docId))).toBe(false);
  });

  it("a hook that throws leaves the doc failed, not stuck", async () => {
    w = await makeWeb({
      web: {
        onUploaded: () => {
          throw new Error("boom with document text SECRET-CLAUSE");
        },
      },
    });
    const { docId } = await json(await announce(pdf(PDF_BYTES.length)));
    expect((await put(docId, PDF_BYTES)).status).toBe(204);
    const doc = await json(await w.a.get(`/api/docs/${docId}`));
    expect(doc.doc.status).toBe("failed");
    expect(JSON.stringify(doc)).not.toContain("SECRET-CLAUSE");
  });

  it("works with another uploader and no PUT route when the uploader is not local", async () => {
    w = await makeWeb({
      web: {
        uploader: {
          prepare: ({ key }) => ({
            method: "PUT",
            url: `https://s3.example/${key}`,
            headers: {},
            expiresInSeconds: 60,
          }),
        },
      },
    });
    const { docId, upload } = await json(await announce(pdf(5)));
    expect(upload.url).toBe(`https://s3.example/uploads/hh_demo/${docId}/original.pdf`);
    expect((await put(docId, PDF_BYTES)).status).toBe(404);
  });
});

describe("object store and local uploader", () => {
  it("put, get and delete by keys", async () => {
    const s = createMemoryObjectStore();
    await s.put("a", new Uint8Array([1]));
    await s.put("b", new Uint8Array([2]));
    expect(await s.get("a")).toEqual(new Uint8Array([1]));
    await s.delete(["a", "missing"]);
    expect(await s.get("a")).toBeNull();
    expect(s.keys()).toEqual(["b"]);
  });

  it("the local uploader remembers what it promised until done", () => {
    const u = createLocalUploader();
    u.prepare({ key: "uploads/h/d1/original.pdf", contentType: "application/pdf", size: 7 });
    expect(u.expected("uploads/h/d1/original.pdf")).toEqual({ contentType: "application/pdf", size: 7 });
    u.done("uploads/h/d1/original.pdf");
    expect(u.expected("uploads/h/d1/original.pdf")).toBeUndefined();
  });
});

describe("a file that is not a demo document", () => {
  it("goes to failed with the plain reason", async () => {
    const { docId, put } = await w.upload(w.a, "mine.pdf", PDF_BYTES);
    expect(put.status).toBe(204);
    const doc = await json(await w.a.get(`/api/docs/${docId}`));
    expect(doc.doc.status).toBe("failed");
    expect(doc.doc.failureReason).toBe(
      "This build can only read the demo documents until the real reader is connected.",
    );
    expect(doc.agreement).toBeNull();
  });

  it("a fixture with one byte changed is not a fixture", async () => {
    const b = fixture("lease.pdf").slice();
    b[b.length - 1] = (b[b.length - 1]! + 1) % 256;
    const { docId } = await w.upload(w.a, "lease.pdf", b);
    expect((await json(await w.a.get(`/api/docs/${docId}`))).doc.status).toBe("failed");
  });
});
