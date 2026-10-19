import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMemoryRepository } from "core/src/repository";
import { describe, expect, it } from "vitest";
import { createMemoryIndexSource } from "../src/mcp/indexCache";
import { seedHousehold, DEMO_HOUSEHOLD } from "../src/seed";
import { A, ANCHOR, B, seeded } from "./helpers";

const expectedObligations = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "..", "fixtures", "expected", "obligations.json"), "utf8"),
) as { obligations: { from: string; type: string; dueDate: string }[]; severity: { high: string[] } };

describe("seedHousehold", () => {
  it("builds the demo household", async () => {
    const repo = createMemoryRepository();
    const indexSource = createMemoryIndexSource();
    const r = await seedHousehold(repo, { today: ANCHOR, indexSource });
    expect(r.householdId).toBe(DEMO_HOUSEHOLD);
    expect(r.assetIds.sort()).toEqual(["A-baby-bottles", "A-car", "A-dishwasher"]);
    expect(r.docIds).toHaveLength(5);
    expect(r.agreementIds).toHaveLength(5);
    expect(r.chunkCount).toBeGreaterThan(10);
    expect(await indexSource.load(DEMO_HOUSEHOLD)).toContain('"v":1');
  });

  it("makes every agreement confirmed, because the seed stands in for the review step", async () => {
    const { repo } = await seeded();
    for (const a of await repo.listAgreements(A)) {
      expect(Object.keys(a.fields).length).toBeGreaterThan(0);
      for (const k of Object.keys(a.fields)) expect(a.fieldStatus[k], `${a.id}.${k}`).toBe("confirmed");
    }
  });

  it("links documents and agreements to the right assets", async () => {
    const { repo } = await seeded();
    expect((await repo.getAgreement(A, "agr-warranty_dishwasher"))!.assetIds).toEqual(["A-dishwasher"]);
    expect((await repo.getAgreement(A, "agr-insurance_auto"))!.assetIds).toEqual(["A-car"]);
    expect((await repo.getAgreement(A, "agr-lease"))!.assetIds).toEqual([]);
    expect((await repo.getDoc(A, "doc-insurance_auto"))!.assetIds).toEqual(["A-car"]);
    expect((await repo.listDocs(A, { status: "active" })).map((d) => d.filename).sort()).toEqual([
      "insurance_auto.pdf",
      "lease.pdf",
      "subscription_fernwood.pdf",
      "subscription_kestrel.pdf",
      "warranty_dishwasher.pdf",
    ]);
  });

  it("computes the obligations of fixtures/expected/obligations.json at the anchor date", async () => {
    const { repo } = await seeded();
    const got = (await repo.listObligations(A, { from: ANCHOR, to: "2027-12-31" })).filter((o) => o.confirmed);
    for (const want of expectedObligations.obligations) {
      const found = got.find((o) => o.agreementId === `agr-${want.from}` && o.type === want.type);
      expect(found?.dueDate, `${want.from} ${want.type}`).toBe(want.dueDate);
    }
  });

  it("raises an alert for each confirmed high obligation and for nothing unconfirmed", async () => {
    const { repo } = await seeded();
    const alerts = await repo.listAlerts(A, { open: true });
    const deadlineHigh = alerts.filter((a) => a.source === "deadline" && a.severity === "high");
    expect(deadlineHigh).toHaveLength(expectedObligations.severity.high.length);
    expect(alerts.every((a) => a.status === "pending")).toBe(true);
    expect(
      alerts
        .filter((a) => a.source === "recall")
        .map((a) => a.refId)
        .sort(),
    ).toEqual(["26530", "26V332000"]);
  });

  it("indexes the page text with page numbers", async () => {
    const { repo, indexSource } = await seeded();
    const meta = await repo.getChunkMeta(A, "doc-lease");
    expect(meta).toMatchObject({ docId: "doc-lease", indexVersion: 1 });
    expect(meta!.chunkCount).toBeGreaterThan(0);
    const { loadIndex } = await import("core/src/retrieval");
    const index = loadIndex((await indexSource.load(A))!);
    const pages = new Set(
      [...index.chunks.values()].filter((c) => c.docId === "doc-warranty_dishwasher").map((c) => c.page),
    );
    expect([...pages].sort()).toEqual([1, 2, 3]);
  });

  it("is deterministic for a given date and moves its deadlines with the date", async () => {
    const a = await seeded("2026-10-21");
    const b = await seeded("2026-10-21");
    expect(await a.repo.listObligations(A, { from: "2026-01-01", to: "2028-01-01" })).toEqual(
      await b.repo.listObligations(A, { from: "2026-01-01", to: "2028-01-01" }),
    );
    const later = await seeded("2026-11-10");
    const highs = (await later.repo.listAlerts(A, { open: true })).filter(
      (x) => x.source === "deadline" && x.severity === "high",
    );
    expect(highs.every((x) => x.dueDate! >= "2026-11-10")).toBe(true);
  });

  it("can seed a second household under another id without touching the first", async () => {
    const repo = createMemoryRepository();
    const indexSource = createMemoryIndexSource();
    await seedHousehold(repo, { today: ANCHOR, indexSource });
    await seedHousehold(repo, { today: ANCHOR, householdId: B, indexSource });
    expect((await repo.listAssets(A)).length).toBe(3);
    expect((await repo.listAssets(B)).length).toBe(3);
    await repo.deleteHousehold(B);
    expect((await repo.listAssets(A)).length).toBe(3);
    expect(await repo.listAssets(B)).toEqual([]);
  });

  it("puts no phone photo duplicate of the warranty in the household", async () => {
    const { repo } = await seeded();
    const warranties = (await repo.listAgreements(A)).filter((a) => a.kind === "warranty");
    expect(warranties).toHaveLength(1);
  });
});
