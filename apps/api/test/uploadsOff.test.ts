import { describe, expect, it } from "vitest";
import { json, makeWeb } from "./webHelpers";

describe("a server with no ingest connected", () => {
  it("answers an upload announcement with a plain 503 and stores nothing", async () => {
    const w = await makeWeb({ web: { onUploaded: undefined } });
    const before = (await w.repo.listDocs("hh_other")).length;
    const r = await w.b.send("POST", "/api/uploads", { filename: "a.pdf", contentType: "application/pdf", size: 5 });
    expect(r.status).toBe(503);
    const body = await json(r);
    expect(body.error).toEqual({ code: "unavailable", message: "Uploads are not available yet." });
    expect((await w.repo.listDocs("hh_other")).length).toBe(before);
  });
});
