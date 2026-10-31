import { beforeAll, describe, expect, it } from "vitest";
import { json, makeWeb, type Web } from "./webHelpers";

let w: Web;
beforeAll(async () => {
  w = await makeWeb();
});

describe("GET /api/export", () => {
  it("returns this household's data as a download, and nothing of another household", async () => {
    const r = await w.a.get("/api/export");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toContain("hippo-export.json");
    const body = await json(r);
    expect(body.documents.length).toBeGreaterThan(0);
    expect(body.agreements.length).toBeGreaterThan(0);
    expect(body.settings.email).toBe("demo@hippo.test");
    const other = await json(await w.b.get("/api/export"));
    expect(other.documents).toEqual([]);
    expect(other.agreements).toEqual([]);
  });
  it("is limited to 5 a hour per household", async () => {
    const hits = [];
    for (let i = 0; i < 6; i++) hits.push((await w.b.get("/api/export")).status);
    expect(hits.at(-1)).toBe(429);
  });
});
