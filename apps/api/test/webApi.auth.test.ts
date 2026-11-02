import { beforeAll, describe, expect, it } from "vitest";
import { BASE } from "./helpers";
import { DEV_ORIGIN, json, makeWeb, type Web } from "./webHelpers";

let w: Web;
beforeAll(async () => {
  w = await makeWeb();
});

const READS = [
  "/api/me",
  "/api/docs",
  "/api/docs/doc-lease",
  "/api/docs/doc-lease/pages/1",
  "/api/obligations",
  "/api/alerts?open=true",
  "/api/assets",
  "/api/assets/A-car",
  "/api/export",
];
const WRITES: [string, string, unknown][] = [
  ["POST", "/api/uploads", { filename: "a.pdf", contentType: "application/pdf", size: 5 }],
  ["PATCH", "/api/agreements/agr-lease/fields/endDate", { value: "2026-12-31" }],
  ["POST", "/api/agreements/agr-lease/confirm", { fields: ["endDate"] }],
  ["POST", "/api/alerts/alert-recall-26530/resolve", { action: "done" }],
  ["PUT", "/api/settings", { digestOn: false }],
  ["DELETE", "/api/docs/doc-lease", undefined],
  ["DELETE", "/api/data", { confirm: "delete all my data" }],
];

describe("session", () => {
  it("the cookie from POST /oauth/session authenticates /api/me", async () => {
    const r = await w.a.get("/api/me");
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({ email: "demo@hippo.test", digestOn: true });
  });

  it("the cookie from the magic code login authenticates too, for its own household", async () => {
    const r = await w.b.get("/api/me");
    expect(r.status).toBe(200);
    expect((await json(r)).email).toBe("other@hippo.test");
  });

  it("logout ends the session", async () => {
    const cookie = w.a.cookie;
    const tmp = w.clientFor(cookie);
    const out = await tmp.call("/oauth/logout", { method: "POST", json: {} });
    expect(out.status).toBe(200);
    expect((await tmp.get("/api/me")).status).toBe(401);
    // restore for the other tests: log in again
    const r = await w.app.request(`${BASE}/oauth/session`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ demo: true }),
    });
    expect(r.status).toBe(200);
    w.a.cookie = /hippo_session=[^;]+/.exec(r.headers.get("set-cookie") ?? "")![0];
    Object.assign(w.a, w.clientFor(w.a.cookie));
  });

  it("GET /api/me returns the digest address once it is set", async () => {
    await w.a.send("PUT", "/api/settings", { digestOn: false, email: "Home@Example.com" });
    expect(await json(await w.a.get("/api/me"))).toEqual({ email: "home@example.com", digestOn: false });
    await w.a.send("PUT", "/api/settings", { digestOn: true });
  });
});

describe("no cookie, bad cookie", () => {
  it.each(READS)("GET %s without a cookie is 401 in the error format", async (path) => {
    const r = await w.anon.get(path);
    expect(r.status).toBe(401);
    expect(await json(r)).toEqual({ error: { code: "unauthenticated", message: expect.any(String) } });
  });

  it.each(WRITES)("%s %s without a cookie is 401", async (method, path, body) => {
    const r = await w.anon.call(path, { method, ...(body !== undefined ? { json: body } : {}) });
    expect(r.status).toBe(401);
  });

  it("a tampered cookie is 401", async () => {
    const c = w.a.cookie;
    const bad = c.slice(0, -2) + (c.endsWith("aa") ? "bb" : "aa");
    expect((await w.clientFor(bad).get("/api/me")).status).toBe(401);
  });

  it("a made up cookie is 401", async () => {
    expect((await w.clientFor("hippo_session=not-a-session").get("/api/docs")).status).toBe(401);
  });

  it("a bearer token is not a session", async () => {
    const r = await w.anon.call("/api/me", { headers: { authorization: "Bearer abc" } });
    expect(r.status).toBe(401);
  });

  it("an expired session is 401", async () => {
    const x = await makeWeb();
    expect((await x.a.get("/api/me")).status).toBe(200);
    x.clock.t += 8 * 24 * 3600_000;
    expect((await x.a.get("/api/me")).status).toBe(401);
  });

  it("the 401 body does not say whether a cookie was present or wrong", async () => {
    const one = await json(await w.anon.get("/api/me"));
    const two = await json(await w.clientFor("hippo_session=zzz").get("/api/me"));
    expect(one).toEqual(two);
  });
});

describe("Origin and content type", () => {
  it("a write with a foreign Origin is 403", async () => {
    const r = await w.a.call("/api/settings", {
      method: "PUT",
      json: { digestOn: true },
      origin: "https://evil.example",
    });
    expect(r.status).toBe(403);
    expect((await json(r)).error.code).toBe("forbidden_origin");
  });

  it("a write with no Origin is 403", async () => {
    const r = await w.a.call("/api/settings", { method: "PUT", json: { digestOn: true }, origin: null });
    expect(r.status).toBe(403);
  });

  it("the origin of a different port of the same host is not the same origin", async () => {
    const r = await w.a.call("/api/settings", {
      method: "PUT",
      json: { digestOn: true },
      origin: "http://api.hippo.test:8080",
    });
    expect(r.status).toBe(403);
  });

  it("the configured dev origin may write", async () => {
    const r = await w.a.call("/api/settings", { method: "PUT", json: { digestOn: true }, origin: DEV_ORIGIN });
    expect(r.status).toBe(200);
  });

  it("an origin that is only a prefix of an allowed one is refused", async () => {
    const r = await w.a.call("/api/settings", {
      method: "PUT",
      json: { digestOn: true },
      origin: `${DEV_ORIGIN}.evil.example`,
    });
    expect(r.status).toBe(403);
  });

  it("the Origin is checked before the session, and a bad one never reaches the handler", async () => {
    const before = (await json(await w.a.get("/api/docs"))).docs.length;
    const r = await w.a.call("/api/docs/doc-lease", { method: "DELETE", origin: "https://evil.example" });
    expect(r.status).toBe(403);
    expect((await json(await w.a.get("/api/docs"))).docs.length).toBe(before);
  });

  it.each(WRITES.filter(([, p]) => !p.startsWith("/api/docs")))(
    "%s %s with a foreign Origin is 403",
    async (method, path, body) => {
      const r = await w.a.call(path, {
        method,
        origin: "https://evil.example",
        ...(body !== undefined ? { json: body } : {}),
      });
      expect(r.status).toBe(403);
    },
  );

  it("GET needs no Origin", async () => {
    expect((await w.a.call("/api/me", { origin: null })).status).toBe(200);
  });

  it.each([
    ["PUT", "/api/settings"],
    ["POST", "/api/uploads"],
    ["POST", "/api/agreements/agr-lease/confirm"],
    ["PATCH", "/api/agreements/agr-lease/fields/endDate"],
    ["POST", "/api/alerts/alert-recall-26530/resolve"],
    ["DELETE", "/api/data"],
  ])("%s %s with a form content type is 415", async (method, path) => {
    const r = await w.a.call(path, { method, body: "a=b", type: "application/x-www-form-urlencoded" });
    expect(r.status).toBe(415);
    expect((await json(r)).error.code).toBe("unsupported_type");
  });

  it("a JSON write with no content type is 415", async () => {
    const r = await w.a.call("/api/settings", { method: "PUT", body: '{"digestOn":true}', type: null });
    expect(r.status).toBe(415);
  });

  it("a text/plain body is 415 (the form that a cross site page can send)", async () => {
    const r = await w.a.call("/api/settings", { method: "PUT", body: '{"digestOn":true}', type: "text/plain" });
    expect(r.status).toBe(415);
  });

  it("no CORS headers on any answer", async () => {
    for (const r of [await w.a.get("/api/me"), await w.anon.get("/api/me"), await w.a.get("/api/docs/nope")]) {
      expect(r.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("every answer is no-store and nosniff", async () => {
    const r = await w.a.get("/api/docs");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("household isolation", () => {
  it("B sees none of A's documents, assets or alerts", async () => {
    expect((await json(await w.b.get("/api/docs"))).docs).toEqual([]);
    expect((await json(await w.b.get("/api/assets"))).assets).toEqual([]);
    expect((await json(await w.b.get("/api/alerts"))).alerts).toEqual([]);
    expect((await json(await w.b.get("/api/obligations?from=2026-01-01&to=2027-01-01"))).items).toEqual([]);
  });

  const guesses: [string, string, unknown][] = [
    ["GET", "/api/docs/doc-lease", undefined],
    ["GET", "/api/docs/doc-lease/pages/1", undefined],
    ["GET", "/api/assets/A-car", undefined],
    ["PATCH", "/api/agreements/agr-lease/fields/endDate", { value: "2027-01-01" }],
    ["POST", "/api/agreements/agr-lease/confirm", { fields: ["endDate"] }],
    ["POST", "/api/alerts/alert-recall-26530/resolve", { action: "dismiss" }],
    ["DELETE", "/api/docs/doc-lease", undefined],
    ["PUT", "/api/uploads/doc-lease/content", undefined],
  ];

  it.each(guesses)("B %s %s is 404, the same as an id that does not exist", async (method, path, body) => {
    const call = (p: string) =>
      w.b.call(p, {
        method,
        ...(body !== undefined
          ? { json: body }
          : method === "PUT"
            ? { body: new Uint8Array([1]) as BodyInit, type: "application/pdf" }
            : {}),
      });
    const real = await call(path);
    const missing = await call(
      path
        .replace("doc-lease", "doc-nope")
        .replace("agr-lease", "agr-nope")
        .replace("A-car", "A-nope")
        .replace("alert-recall-26530", "alert-nope"),
    );
    expect(real.status).toBe(404);
    expect(await json(real)).toEqual(await json(missing));
  });

  it("after all of B's attempts, A's data is untouched", async () => {
    const doc = await json(await w.a.get("/api/docs/doc-lease"));
    expect(doc.doc.status).toBe("active");
    expect(doc.agreement.fields.every((f: any) => f.status === "confirmed")).toBe(true);
    expect((await json(await w.a.get("/api/alerts?open=true"))).alerts.map((a: any) => a.id)).toContain(
      "alert-recall-26530",
    );
  });

  it("B deleting all data does not touch A", async () => {
    const r = await w.b.send("DELETE", "/api/data", { confirm: "delete all my data" });
    expect(r.status).toBe(204);
    expect((await json(await w.a.get("/api/docs"))).docs.length).toBe(5);
  });

  it("a household id in the body is rejected by the strict schemas", async () => {
    for (const [path, method, body] of [
      ["/api/settings", "PUT", { digestOn: true, householdId: "hh_other" }],
      ["/api/uploads", "POST", { filename: "a.pdf", contentType: "application/pdf", size: 5, householdId: "hh_other" }],
      ["/api/agreements/agr-lease/confirm", "POST", { fields: ["endDate"], householdId: "hh_other" }],
      ["/api/alerts/alert-recall-26530/resolve", "POST", { action: "done", householdId: "hh_other" }],
      ["/api/data", "DELETE", { confirm: "delete all my data", householdId: "hh_other" }],
    ] as const) {
      expect((await w.a.send(method, path, body)).status, path).toBe(400);
    }
  });

  it("a household id in the query is ignored: B asking for hh_demo still gets nothing", async () => {
    for (const q of ["?householdId=hh_demo", "?hh=hh_demo&household=hh_demo", "?open=true&householdId=hh_demo"]) {
      expect((await json(await w.b.get(`/api/alerts${q}`))).alerts).toEqual([]);
      expect((await json(await w.b.get(`/api/docs${q}`))).docs).toEqual([]);
    }
  });

  it("an upload by A lands under A's prefix and B cannot PUT to it", async () => {
    const r = await w.a.send("POST", "/api/uploads", { filename: "x.pdf", contentType: "application/pdf", size: 4 });
    const { docId, upload } = await json(r);
    const put = await w.b.call(upload.url, {
      method: "PUT",
      body: new Uint8Array([0x25, 0x50, 0x44, 0x46]) as BodyInit,
      type: "application/pdf",
    });
    expect(put.status).toBe(404);
    expect(docId).toMatch(/^doc-/);
    expect(w.objectStore.keys().some((k) => k.startsWith(`uploads/hh_other/${docId}`))).toBe(false);
  });
});

describe("errors", () => {
  it("an unknown route is a 404 in the error format", async () => {
    const r = await w.a.get("/api/nothing-here");
    expect(r.status).toBe(404);
    expect(await json(r)).toEqual({ error: { code: "not_found", message: expect.any(String) } });
  });

  it("a malformed JSON body is 400 and never a stack trace", async () => {
    const r = await w.a.call("/api/settings", { method: "PUT", body: "{not json", type: "application/json" });
    expect(r.status).toBe(400);
    const text = JSON.stringify(await json(r));
    expect(text).not.toMatch(/at \S+ \(|node_modules|\.ts:\d+/);
  });

  it("a 1 MB JSON body is 413", async () => {
    const r = await w.a.call("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ digestOn: true, email: "a".repeat(1_000_000) }),
      type: "application/json",
    });
    expect(r.status).toBe(413);
    expect((await json(r)).error.code).toBe("too_large");
  });

  it("a 1 MB JSON body with no Content-Length header is 413 too (streamed)", async () => {
    const big = new TextEncoder().encode(JSON.stringify({ fields: ["x".repeat(1_000_000)] }));
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(big);
        c.close();
      },
    });
    const r = await w.app.request(`${BASE}/api/agreements/agr-lease/confirm`, {
      method: "POST",
      headers: { cookie: w.a.cookie, origin: BASE, "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(r.status).toBe(413);
  });

  it("a JSON array or scalar body is 400", async () => {
    for (const body of ["[]", "5", "null", '"x"']) {
      expect((await w.a.call("/api/settings", { method: "PUT", body, type: "application/json" })).status).toBe(400);
    }
  });

  it("a 400 names the field and not the value", async () => {
    const r = await w.a.send("PUT", "/api/settings", { digestOn: "SECRET-VALUE-123" });
    expect(r.status).toBe(400);
    expect(JSON.stringify(await json(r))).not.toContain("SECRET-VALUE-123");
  });
});
