import { describe, expect, it } from "vitest";
import { alertIdFor, obligationId } from "../src/daily/deadlines";
import { A, ANCHOR, addAsset, addWarranty, days, makeWorld } from "./helpers";

const aid = (agreement: string, due: string) => alertIdFor(obligationId(agreement, "expires", due));

describe("step 1: obligations", () => {
  it("recomputes and stores every agreement's obligations", async () => {
    const w = await makeWorld();
    const r = await w.run();
    expect(r.households[0]!.obligationsComputed).toBe(9);
    const stored = await w.repo.listObligations(A, { from: "2026-01-01", to: "2027-12-31" });
    expect(stored).toHaveLength(9);
  });

  it("replaces the stored set when a date changes, so the old obligation is gone", async () => {
    const w = await makeWorld({ demo: false });
    await w.repo.putHousehold("h", { id: "h", digestOn: false, createdAt: "x" });
    w.ids.push("h");
    await addWarranty(w.repo, "h", "w1", days(10));
    await w.run();
    await addWarranty(w.repo, "h", "w1", days(12));
    await w.run();
    const stored = await w.repo.listObligations("h", { from: "2026-01-01", to: "2027-12-31" });
    expect(stored.map((o) => o.dueDate)).toEqual([days(12)]);
  });

  it("matches fixtures/expected/obligations.json for the demo household at the anchor date", async () => {
    const { readFileSync } = await import("node:fs");
    const exp = JSON.parse(
      readFileSync(new URL("../../../fixtures/expected/obligations.json", import.meta.url), "utf8"),
    ) as {
      anchorDate: string;
      obligations: { from: string; type: string; dueDate: string }[];
    };
    expect(exp.anchorDate).toBe(ANCHOR);
    const w = await makeWorld();
    await w.run();
    const stored = await w.repo.listObligations(A, { from: "2026-01-01", to: "2027-12-31" });
    const keys = new Set(stored.map((o) => `${o.agreementId}|${o.type}|${o.dueDate}`));
    for (const o of exp.obligations)
      expect(keys.has(`agr-${o.from}|${o.type}|${o.dueDate}`), `${o.from} ${o.type}`).toBe(true);
  });

  it("one agreement with bad data is reported and does not stop the others or dismiss alerts", async () => {
    const w = await makeWorld({ demo: false });
    await w.repo.putHousehold("h", { id: "h", digestOn: false, createdAt: "x" });
    w.ids.push("h");
    await addWarranty(w.repo, "h", "good", days(5));
    await w.run();
    // Not an object: computeObligations reads fields.endDate and throws on a null fields value.
    await w.repo.putAgreement("h", {
      id: "bad",
      kind: "warranty",
      title: "bad",
      assetIds: [],
      fields: null as never,
      fieldStatus: {},
      sourceRefs: {},
      createdAt: "x",
    });
    const r = await w.run();
    expect(r.households[0]!.errors.map((e) => e.source)).toEqual(["obligations"]);
    expect((await w.repo.getAlert("h", aid("good", days(5))))!.status).toBe("pending");
  });
});

describe("step 2: deadline alerts", () => {
  it("creates one pending alert per alertable obligation with a stable id", async () => {
    const w = await makeWorld();
    const r = await w.run();
    expect(r.households[0]!.alertsCreated).toBe(7);
    const alerts = await w.repo.listAlerts(A);
    const deadline = alerts.filter((a) => a.source === "deadline");
    expect(deadline).toHaveLength(7);
    expect(deadline.every((a) => a.status === "pending" && a.id === alertIdFor(a.refId))).toBe(true);
    expect(deadline.filter((a) => a.severity === "high")).toHaveLength(5);
    expect(deadline.filter((a) => a.severity === "possible")).toHaveLength(2);
  });

  it("two runs leave identical state (idempotence)", async () => {
    const w = await makeWorld({ demo: false });
    await w.repo.putHousehold("h", { id: "h", digestOn: false, createdAt: "x" });
    w.ids.push("h");
    await addWarranty(w.repo, "h", "w1", days(10));
    await addWarranty(w.repo, "h", "w2", days(25));
    await w.run();
    const first = JSON.stringify(await w.repo.listAlerts("h"));
    const r2 = await w.run();
    expect(JSON.stringify(await w.repo.listAlerts("h"))).toBe(first);
    expect(r2.households[0]!.alertsCreated).toBe(0);
    expect(r2.households[0]!.alertsLeftAlone).toBe(2);
  });

  it("two runs on the demo household leave identical alerts and obligations", async () => {
    const w = await makeWorld();
    const dry = { sender: undefined }; // a sent digest marks alerts emailed, which is the digest tests' business
    await w.run(ANCHOR, dry);
    const alerts = JSON.stringify(await w.repo.listAlerts(A));
    const obs = JSON.stringify(await w.repo.listObligations(A, { from: "2000-01-01", to: "2100-01-01" }));
    await w.run(ANCHOR, dry);
    expect(JSON.stringify(await w.repo.listAlerts(A))).toBe(alerts);
    expect(JSON.stringify(await w.repo.listObligations(A, { from: "2000-01-01", to: "2100-01-01" }))).toBe(obs);
  });

  describe("D-006: an unconfirmed field never creates or raises an alert", () => {
    it.each(["extracted", undefined] as const)("status %s", async (status) => {
      const w = await makeWorld({ demo: false });
      await w.repo.putHousehold("h", { id: "h", digestOn: true, email: "h@example.com", createdAt: "x" });
      w.ids.push("h");
      await addWarranty(w.repo, "h", "w1", days(3), status ?? "extracted");
      if (status === undefined)
        await w.repo.putAgreement("h", { ...(await w.repo.getAgreement("h", "w1"))!, fieldStatus: {} });
      const r = await w.run();
      const obs = await w.repo.listObligations("h", { from: "2000-01-01", to: "2100-01-01" });
      expect(obs).toHaveLength(1);
      expect(obs[0]).toMatchObject({ confirmed: false, severity: null });
      expect(await w.repo.listAlerts("h")).toEqual([]);
      expect(r.households[0]!.alertsCreated).toBe(0);
      expect(w.mail.sent).toEqual([]);
    });

    it("an unconfirmed insurance renewal, subscription and lease date all stay silent", async () => {
      const w = await makeWorld({ demo: false });
      await w.repo.putHousehold("h", { id: "h", digestOn: true, email: "h@example.com", createdAt: "x" });
      w.ids.push("h");
      const base = { title: "t", assetIds: [], sourceRefs: {}, createdAt: "x" };
      await w.repo.putAgreement("h", {
        ...base,
        id: "i",
        kind: "insurance",
        fields: { expirationDate: days(5), renewal: "auto" },
        fieldStatus: { expirationDate: "confirmed", renewal: "extracted" },
      });
      await w.repo.putAgreement("h", {
        ...base,
        id: "s",
        kind: "subscription",
        fields: { nextChargeDate: days(4), cancelNoticeDays: 1, cycle: "monthly" },
        fieldStatus: { nextChargeDate: "extracted", cancelNoticeDays: "extracted", cycle: "extracted" },
      });
      await w.repo.putAgreement("h", {
        ...base,
        id: "l",
        kind: "lease",
        fields: { endDate: days(60), noticeDaysToVacate: 50 },
        fieldStatus: { endDate: "confirmed", noticeDaysToVacate: "extracted" },
      });
      await w.run();
      expect(await w.repo.listAlerts("h")).toEqual([]);
    });

    it("a field that was confirmed and later becomes unconfirmed loses its pending alert", async () => {
      const w = await makeWorld({ demo: false });
      await w.repo.putHousehold("h", { id: "h", digestOn: false, createdAt: "x" });
      w.ids.push("h");
      await addWarranty(w.repo, "h", "w1", days(5));
      await w.run();
      await addWarranty(w.repo, "h", "w1", days(5), "extracted");
      const r = await w.run();
      expect(r.households[0]!.alertsDismissed).toBe(1);
      expect((await w.repo.getAlert("h", aid("w1", days(5))))!.status).toBe("dismissed");
    });

    it("an edited field counts as confirmed", async () => {
      const w = await makeWorld({ demo: false });
      await w.repo.putHousehold("h", { id: "h", digestOn: false, createdAt: "x" });
      w.ids.push("h");
      await addWarranty(w.repo, "h", "w1", days(5), "edited");
      await w.run();
      expect(await w.repo.getAlert("h", aid("w1", days(5)))).not.toBeNull();
    });
  });

  describe("window edges (SPEC section 5, D-015)", () => {
    it.each([
      [0, "high"],
      [14, "high"],
      [15, "possible"],
      [29, "possible"],
      [30, "possible"],
      [31, null],
      [60, null],
      [-1, null],
    ] as const)("an `expires` obligation %i days away gives %s", async (n, expected) => {
      const w = await makeWorld({ demo: false });
      await w.repo.putHousehold("h", { id: "h", digestOn: false, createdAt: "x" });
      w.ids.push("h");
      await addWarranty(w.repo, "h", "w1", days(n));
      await w.run();
      const a = await w.repo.getAlert("h", aid("w1", days(n)));
      if (expected === null) expect(a).toBeNull();
      else expect(a?.severity).toBe(expected);
    });
  });

  describe("D-020: lease rent never alerts", () => {
    it("rent due in 2 days is on the timeline with no severity and no alert", async () => {
      const w = await makeWorld({ demo: false });
      await w.repo.putHousehold("h", { id: "h", digestOn: true, email: "h@example.com", createdAt: "x" });
      w.ids.push("h");
      await w.repo.putAgreement("h", {
        id: "lease",
        kind: "lease",
        title: "lease",
        assetIds: [],
        fields: { rentDueDay: 23, endDate: "2028-01-01" },
        fieldStatus: { rentDueDay: "confirmed", endDate: "confirmed" },
        sourceRefs: {},
        createdAt: "x",
      });
      await w.run();
      const obs = await w.repo.listObligations("h", { from: "2000-01-01", to: "2100-01-01" });
      expect(obs.find((o) => o.type === "charge")).toMatchObject({ dueDate: "2026-10-23", severity: null });
      expect(await w.repo.listAlerts("h")).toEqual([]);
    });
  });

  describe("done, dismissed and announced alerts", () => {
    async function seeded(status: "done" | "dismissed" | "announced") {
      const w = await makeWorld({ demo: false });
      await w.repo.putHousehold("h", { id: "h", digestOn: false, createdAt: "x" });
      w.ids.push("h");
      await addWarranty(w.repo, "h", "w1", days(20));
      await w.run();
      const id = aid("w1", days(20));
      const a = (await w.repo.getAlert("h", id))!;
      await w.repo.putAlert("h", {
        ...a,
        status,
        announcedAt: status === "announced" ? "2026-10-20T10:00:00.000Z" : null,
      });
      return { w, id };
    }

    it.each(["done", "dismissed"] as const)(
      "%s stays closed when the same obligation is still due, even if it turns high",
      async (status) => {
        const { w, id } = await seeded(status);
        await w.run(days(10)); // 10 days left: now high
        const a = (await w.repo.getAlert("h", id))!;
        expect(a.status).toBe(status);
        expect(a.severity).toBe("possible");
      },
    );

    it.each(["done", "dismissed"] as const)(
      "%s is not reopened or recreated after the obligation leaves the window",
      async (status) => {
        const { w, id } = await seeded(status);
        await w.run(days(40));
        expect((await w.repo.getAlert("h", id))!.status).toBe(status);
      },
    );

    it("announced stays announced (never re-announced as pending) and keeps announcedAt", async () => {
      const { w, id } = await seeded("announced");
      await w.run(days(1));
      const a = (await w.repo.getAlert("h", id))!;
      expect(a.status).toBe("announced");
      expect(a.announcedAt).toBe("2026-10-20T10:00:00.000Z");
    });

    it("an announced possible alert rises to high as the date nears, still announced", async () => {
      const { w, id } = await seeded("announced");
      const r = await w.run(days(10));
      expect((await w.repo.getAlert("h", id))!).toMatchObject({ status: "announced", severity: "high" });
      expect(r.households[0]!.alertsRefreshed).toBe(1);
    });

    it("a pending possible alert rises to high and stays pending", async () => {
      const w = await makeWorld({ demo: false });
      await w.repo.putHousehold("h", { id: "h", digestOn: false, createdAt: "x" });
      w.ids.push("h");
      await addWarranty(w.repo, "h", "w1", days(20));
      await w.run();
      await w.run(days(10));
      expect((await w.repo.getAlert("h", aid("w1", days(20))))!).toMatchObject({ status: "pending", severity: "high" });
    });

    it("an announced alert is never dismissed by the cleanup, even when its obligation is gone", async () => {
      const { w, id } = await seeded("announced");
      await w.repo.deleteAgreement("h", "w1");
      await w.run();
      expect((await w.repo.getAlert("h", id))!.status).toBe("announced");
    });

    it("keeps emailedAt and snoozedUntil on refresh", async () => {
      const { w, id } = await seeded("announced");
      const a = (await w.repo.getAlert("h", id))!;
      await w.repo.putAlert("h", {
        ...a,
        emailedAt: "2026-10-20T08:00:00.000Z",
        snoozedUntil: "2026-10-30T00:00:00.000Z",
      });
      await w.run(days(10));
      expect(await w.repo.getAlert("h", id)).toMatchObject({
        severity: "high",
        emailedAt: "2026-10-20T08:00:00.000Z",
        snoozedUntil: "2026-10-30T00:00:00.000Z",
      });
    });
  });

  describe("cleanup of pending alerts", () => {
    it("dismisses a pending alert whose obligation disappeared", async () => {
      const w = await makeWorld({ demo: false });
      await w.repo.putHousehold("h", { id: "h", digestOn: false, createdAt: "x" });
      w.ids.push("h");
      await addWarranty(w.repo, "h", "w1", days(5));
      await w.run();
      await w.repo.deleteAgreement("h", "w1");
      const r = await w.run();
      expect(r.households[0]!.alertsDismissed).toBe(1);
      expect((await w.repo.getAlert("h", aid("w1", days(5))))!.status).toBe("dismissed");
    });

    it("dismisses a pending alert once its date has passed", async () => {
      const w = await makeWorld({ demo: false });
      await w.repo.putHousehold("h", { id: "h", digestOn: false, createdAt: "x" });
      w.ids.push("h");
      await addWarranty(w.repo, "h", "w1", days(2));
      await w.run();
      await w.run(days(3));
      expect((await w.repo.getAlert("h", aid("w1", days(2))))!.status).toBe("dismissed");
    });

    it("a changed due date makes a new alert and dismisses the old pending one", async () => {
      const w = await makeWorld({ demo: false });
      await w.repo.putHousehold("h", { id: "h", digestOn: false, createdAt: "x" });
      w.ids.push("h");
      await addWarranty(w.repo, "h", "w1", days(5));
      await w.run();
      await addWarranty(w.repo, "h", "w1", days(8));
      await w.run();
      expect((await w.repo.getAlert("h", aid("w1", days(5))))!.status).toBe("dismissed");
      expect((await w.repo.getAlert("h", aid("w1", days(8))))!.status).toBe("pending");
    });

    it("does not dismiss recall alerts", async () => {
      const w = await makeWorld();
      await w.run();
      const before = (await w.repo.listAlerts(A)).filter((a) => a.source === "recall");
      expect(before.length).toBeGreaterThan(0);
      await w.run();
      expect((await w.repo.listAlerts(A)).filter((a) => a.source === "recall" && a.status === "dismissed")).toEqual([]);
    });
  });

  it("labels an alert with the asset name", async () => {
    const w = await makeWorld({ demo: false });
    await w.repo.putHousehold("h", { id: "h", digestOn: false, createdAt: "x" });
    w.ids.push("h");
    await addAsset(w.repo, "h", { id: "a1", name: "Fridge" });
    await addWarranty(w.repo, "h", "w1", days(5), "confirmed", { assetIds: ["a1"] });
    await w.run();
    expect(await w.repo.getAlert("h", aid("w1", days(5)))).toMatchObject({
      label: "Fridge warranty expires",
      assetId: "a1",
    });
  });
});
