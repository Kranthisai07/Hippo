import { describe, expect, it } from "vitest";
import { A } from "./helpers";
import { json, makeWeb } from "./webHelpers";

// Round 3 review: labels, names and file names come from model extracted free text and were returned unmasked by
// /alerts, /obligations, /assets and /docs. Ids and dates must stay exactly as they are.
const CARD = "4111 1111 1111 1111";
const RAW = (s: string) => expect(s).not.toContain(CARD);

describe("free text in the list endpoints is masked, ids and dates are not", () => {
  it("GET /api/alerts masks label and detail, keeps ids and dates", async () => {
    const w = await makeWeb();
    await w.repo.putAlert(A, {
      id: "alert-x:renews:2026-11-30",
      refId: "x:renews:2026-11-30",
      source: "deadline",
      severity: "high",
      status: "pending",
      label: `Pay card ${CARD} now`,
      detail: `Account ${CARD}`,
      dueDate: "2026-11-30",
    });
    const body = await json(await w.a.get("/api/alerts?open=true"));
    const mine = body.alerts.find((a: any) => a.id === "alert-x:renews:2026-11-30");
    expect(mine).toBeTruthy();
    RAW(JSON.stringify(mine));
    expect(mine.label).toContain("ending 1111");
    expect(mine.refId).toBe("x:renews:2026-11-30");
    expect(mine.dueDate).toBe("2026-11-30");
  });

  it("GET /api/obligations masks the label, keeps the id and the date", async () => {
    const w = await makeWeb();
    await w.repo.replaceObligations(A, "ag-card", [
      {
        id: "ag-card:renews:2026-11-30",
        agreementId: "ag-card",
        type: "renews",
        dueDate: "2026-11-30",
        label: `Card ${CARD} renews`,
        confirmed: true,
        severity: "possible",
      },
    ]);
    const body = await json(await w.a.get("/api/obligations?from=2026-11-01&to=2026-12-31"));
    const item = body.items.find((i: any) => i.obligation.id === "ag-card:renews:2026-11-30");
    RAW(JSON.stringify(item));
    expect(item.obligation.label).toContain("ending 1111");
    expect(item.obligation.dueDate).toBe("2026-11-30");
  });

  it("GET /api/assets and /api/assets/:id mask the name, brand, model and aliases", async () => {
    const w = await makeWeb();
    await w.repo.putAsset(A, {
      id: "asset-card",
      name: `Fridge ${CARD}`,
      aliases: [`cold ${CARD}`],
      brand: `Acme ${CARD}`,
      modelNumber: `M-${CARD}`,
      location: `Room ${CARD}`,
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    await w.repo.addEvent(A, {
      id: "event-1",
      assetId: "asset-card",
      ts: "2026-10-01T00:00:00.000Z",
      action: `Serviced ${CARD}`,
      note: `Note ${CARD}`,
      source: "web",
    });
    const list = await json(await w.a.get("/api/assets"));
    RAW(JSON.stringify(list.assets.find((a: any) => a.id === "asset-card")));
    const one = await json(await w.a.get("/api/assets/asset-card"));
    RAW(JSON.stringify(one));
    expect(one.asset.id).toBe("asset-card");
    expect(one.asset.name).toContain("ending 1111");
  });

  it("GET /api/docs and /api/docs/:id mask the file name", async () => {
    const w = await makeWeb();
    await w.repo.putDoc(A, {
      id: "doc-card",
      s3Key: "uploads/hh_demo/doc-card/original.pdf",
      filename: `policy-${CARD}.pdf`,
      docType: "other",
      status: "active",
      uploadedAt: "2026-10-01T00:00:00.000Z",
      assetIds: [],
    });
    const list = await json(await w.a.get("/api/docs"));
    RAW(JSON.stringify(list.docs.find((d: any) => d.id === "doc-card")));
    const one = await json(await w.a.get("/api/docs/doc-card"));
    RAW(JSON.stringify(one));
    expect(one.doc.id).toBe("doc-card");
  });

  it("ordinary names and labels are not changed", async () => {
    const w = await makeWeb();
    const list = await json(await w.a.get("/api/assets"));
    const dish = list.assets.find((a: any) => a.id === "A-dishwasher");
    expect(dish.name).toBe("Dishwasher");
    const docs = await json(await w.a.get("/api/docs"));
    expect(docs.docs.some((d: any) => d.filename === "lease.pdf")).toBe(true);
  });
});
