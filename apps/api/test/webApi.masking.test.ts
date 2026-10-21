import { describe, expect, it } from "vitest";
import { fixture, json, makeWeb } from "./webHelpers";

// Hard rule: policy and account numbers are masked to the last 4 everywhere. WEB_API.md says the same. The review page
// shows source quotes next to each value, and the demo policy quote reads "Policy number: HM-AU-0048-4821".
async function insurance() {
  const w = await makeWeb();
  const { docId, put } = await w.upload(w.b, "insurance_auto.pdf", fixture("insurance_auto.pdf"), "application/pdf");
  expect(put.status).toBe(204);
  const view = await json(await w.b.get(`/api/docs/${docId}`));
  return { w, docId, view };
}

describe("numbers in the review view are masked to the last 4", () => {
  it("never returns the full policy number in a quote or a value", async () => {
    const { view } = await insurance();
    const text = JSON.stringify(view);
    expect(text).not.toContain("0048");
    expect(text).not.toContain("HM-AU-0048-4821");
    expect(text).not.toMatch(/\d{5}/);
    // The person can still tell which policy it is.
    expect(text).toContain("4821");
  });

  it("keeps dates, amounts and phone numbers readable", async () => {
    const { view } = await insurance();
    const f = (name: string) => view.agreement.fields.find((x: any) => x.name === name);
    expect(f("expirationDate").value).toBe("2026-10-30");
    expect(f("effectiveDate").value).toBe("2026-04-30");
    expect(JSON.stringify(f("contact").value)).toContain("1-800-555-0177");
    expect(JSON.stringify(f("premium").value)).toContain("684");
  });

  it("masks the confirm response and the asset detail too", async () => {
    const { w, view } = await insurance();
    const names = view.agreement.fields.filter((x: any) => x.isDate).map((x: any) => x.name);
    const res = await json(await w.b.send("POST", `/api/agreements/${view.agreement.id}/confirm`, { fields: names }));
    expect(JSON.stringify(res)).not.toMatch(/\d{5}/);
    expect(JSON.stringify(res)).not.toContain("0048");
    const assets = await json(await w.b.get("/api/assets"));
    for (const a of assets.assets) {
      const detail = await json(await w.b.get(`/api/assets/${a.id}`));
      expect(JSON.stringify(detail.agreements)).not.toContain("0048");
    }
  });

  it("only changes what the browser sees: the stored agreement keeps the real quote for verification", async () => {
    const { w, view } = await insurance();
    const stored = await w.repo.getAgreement("hh_other", view.agreement.id);
    expect(JSON.stringify(stored)).toContain("HM-AU-0048-4821");
  });
});
