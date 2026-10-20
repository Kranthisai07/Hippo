import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { recallAlertId } from "../src/daily/recalls";
import { A, ANCHOR, addAsset, addHousehold, days, makeWorld, res } from "./helpers";

const fixture = (p: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../fixtures/recalls/${p}`, import.meta.url), "utf8"));
const cpscError = fixture("cpsc/error_record_http200.json");
const zeroResults = fixture("nhtsa/recallsByVehicle_HONDA_CRV_2021_zero_results.json");

const recallAlerts = async (w: Awaited<ReturnType<typeof makeWorld>>, hh = A) =>
  (await w.repo.listAlerts(hh)).filter((a) => a.source === "recall");
const snapshot = async (w: Awaited<ReturnType<typeof makeWorld>>, hh = A) => JSON.stringify(await recallAlerts(w, hh));

describe("CPSC radar", () => {
  it("makes one request with both date bounds, format=json and no UPC filter", async () => {
    const w = await makeWorld();
    const r = await w.run();
    expect(w.net.cpsc()).toHaveLength(1);
    const u = new URL(w.net.cpsc()[0]!);
    expect(u.searchParams.get("LastPublishDateStart")).toBe(days(-90));
    expect(u.searchParams.get("LastPublishDateEnd")).toBe(ANCHOR);
    expect(u.searchParams.get("format")).toBe("json");
    expect([...u.searchParams.keys()].sort()).toEqual(["LastPublishDateEnd", "LastPublishDateStart", "format"]);
    expect(r.requests.cpsc).toBe(1);
  });

  it("the lookback is configurable", async () => {
    const w = await makeWorld({ config: { lookbackDays: 7 } });
    await w.run();
    expect(new URL(w.net.cpsc()[0]!).searchParams.get("LastPublishDateStart")).toBe(days(-7));
  });

  it("a UPC match is high, with a stable id from source, recall and asset", async () => {
    const w = await makeWorld();
    await w.run();
    const a = await w.repo.getAlert(A, recallAlertId("cpsc", "26530", "A-baby-bottles"));
    expect(a).toMatchObject({
      source: "recall",
      severity: "high",
      status: "pending",
      refId: "26530",
      assetId: "A-baby-bottles",
    });
    expect(a!.id).toBe("alert-recall-cpsc-26530-A-baby-bottles");
  });

  it("brand plus name overlap without a UPC is only possible", async () => {
    const w = await makeWorld({ demo: false });
    await addHousehold(w, "h");
    await addAsset(w.repo, "h", { id: "b", name: "NURSH baby bottles", brand: "Boon" });
    await w.run();
    expect((await w.repo.getAlert("h", recallAlertId("cpsc", "26530", "b")))!.severity).toBe("possible");
  });

  it("a possible recall is created but never emailed", async () => {
    const w = await makeWorld({ demo: false });
    await addHousehold(w, "h");
    await addAsset(w.repo, "h", { id: "b", name: "NURSH baby bottles", brand: "Boon" });
    const r = await w.run();
    expect(r.households[0]!.recallAlertsCreated).toBe(1);
    expect(r.households[0]!.email).toMatchObject({ status: "skipped", reason: "nothing_to_send" });
    expect(w.mail.sent).toEqual([]);
  });

  it("a recall with a wrong Title (26569) matches nothing", async () => {
    const w = await makeWorld();
    await w.run();
    expect((await recallAlerts(w)).filter((a) => a.refId === "26569")).toEqual([]);
  });

  it("a brand with no overlap in name or model gives no alert", async () => {
    const w = await makeWorld({ demo: false });
    await addHousehold(w, "h");
    await addAsset(w.repo, "h", { id: "t", name: "Toaster", brand: "Acme" });
    await w.run();
    expect(await w.repo.listAlerts("h")).toEqual([]);
  });

  it("a vehicle asset is never matched against CPSC", async () => {
    const w = await makeWorld({ demo: false });
    await addHousehold(w, "h");
    await addAsset(w.repo, "h", {
      id: "v",
      name: "Boon bottles car",
      brand: "Boon",
      upc: "669028116546",
      vehicle: { make: "Honda", model: "Civic", modelYear: 2021 },
    });
    await w.run();
    expect((await recallAlerts(w, "h")).filter((a) => a.refId === "26530")).toEqual([]);
  });

  it("no CPSC request when the household has no non-vehicle assets", async () => {
    const w = await makeWorld({ demo: false });
    await addHousehold(w, "h");
    await addAsset(w.repo, "h", {
      id: "v",
      name: "Car",
      brand: "Honda",
      vehicle: { make: "Honda", model: "CR-V", modelYear: 2021, nhtsaMake: "HONDA", nhtsaModel: "CR-V" },
    });
    await w.run();
    expect(w.net.cpsc()).toEqual([]);
  });

  it("many households still cost one CPSC request per run", async () => {
    const w = await makeWorld();
    for (const id of ["h1", "h2", "h3"]) {
      await addHousehold(w, id);
      await addAsset(w.repo, id, { id: "b", name: "Bottles", brand: "Boon", upc: "669028116546" });
    }
    const r = await w.run();
    expect(w.net.cpsc()).toHaveLength(1);
    expect(r.requests.cpsc).toBe(1);
    for (const id of ["h1", "h2", "h3"])
      expect(await w.repo.getAlert(id, recallAlertId("cpsc", "26530", "b"))).not.toBeNull();
  });

  it("a second run does not duplicate or reset a recall alert", async () => {
    const w = await makeWorld();
    await w.run(ANCHOR, { sender: undefined });
    const first = await snapshot(w);
    const r = await w.run(ANCHOR, { sender: undefined });
    expect(await snapshot(w)).toBe(first);
    expect(r.households[0]!.recallAlertsCreated).toBe(0);
  });

  it.each(["announced", "done", "dismissed"] as const)(
    "an existing %s recall alert is left exactly as it is",
    async (status) => {
      const w = await makeWorld();
      await w.run(ANCHOR, { sender: undefined });
      const id = recallAlertId("cpsc", "26530", "A-baby-bottles");
      const a = (await w.repo.getAlert(A, id))!;
      await w.repo.putAlert(A, { ...a, status });
      await w.run(ANCHOR, { sender: undefined });
      expect(await w.repo.getAlert(A, id)).toEqual({ ...a, status });
    },
  );

  describe("suppressions", () => {
    it("a CPSC recall marked not mine never comes back for that asset", async () => {
      const w = await makeWorld();
      await w.repo.addSuppression(A, { source: "cpsc", recallId: "26530", assetId: "A-baby-bottles", createdAt: "x" });
      await w.run();
      expect(await w.repo.getAlert(A, recallAlertId("cpsc", "26530", "A-baby-bottles"))).toBeNull();
    });

    it("an NHTSA campaign marked not mine is skipped, the other campaigns stay", async () => {
      const w = await makeWorld();
      await w.repo.addSuppression(A, { source: "nhtsa", recallId: "26V332000", assetId: "A-car", createdAt: "x" });
      await w.run();
      const ids = (await recallAlerts(w))
        .filter((a) => a.assetId === "A-car")
        .map((a) => a.refId)
        .sort();
      expect(ids).toEqual(["21V900000", "23V858000", "24V064000"]);
    });

    it("a suppression for another asset does not hide this one", async () => {
      const w = await makeWorld();
      await w.repo.addSuppression(A, { source: "cpsc", recallId: "26530", assetId: "A-other", createdAt: "x" });
      await w.run();
      expect(await w.repo.getAlert(A, recallAlertId("cpsc", "26530", "A-baby-bottles"))).not.toBeNull();
    });

    it("a suppression made after the alert dismisses it while it is still pending", async () => {
      const w = await makeWorld();
      await w.run(ANCHOR, { sender: undefined });
      await w.repo.addSuppression(A, { source: "cpsc", recallId: "26530", assetId: "A-baby-bottles", createdAt: "x" });
      await w.run(ANCHOR, { sender: undefined });
      expect((await w.repo.getAlert(A, recallAlertId("cpsc", "26530", "A-baby-bottles")))!.status).toBe("dismissed");
    });

    it("a suppression does not touch an announced alert", async () => {
      const w = await makeWorld();
      await w.run(ANCHOR, { sender: undefined });
      const id = recallAlertId("cpsc", "26530", "A-baby-bottles");
      await w.repo.putAlert(A, { ...(await w.repo.getAlert(A, id))!, status: "announced" });
      await w.repo.addSuppression(A, { source: "cpsc", recallId: "26530", assetId: "A-baby-bottles", createdAt: "x" });
      await w.run(ANCHOR, { sender: undefined });
      expect((await w.repo.getAlert(A, id))!.status).toBe("announced");
    });

    it("a suppression in one household does not affect another", async () => {
      const w = await makeWorld();
      await addHousehold(w, "h2");
      await addAsset(w.repo, "h2", { id: "A-baby-bottles", name: "Bottles", brand: "Boon", upc: "669028116546" });
      await w.repo.addSuppression("h2", {
        source: "cpsc",
        recallId: "26530",
        assetId: "A-baby-bottles",
        createdAt: "x",
      });
      await w.run();
      expect(await w.repo.getAlert("h2", recallAlertId("cpsc", "26530", "A-baby-bottles"))).toBeNull();
      expect(await w.repo.getAlert(A, recallAlertId("cpsc", "26530", "A-baby-bottles"))).not.toBeNull();
    });
  });

  describe("every CPSC failure is an error, never an all-clear", () => {
    const failures: [string, () => Parameters<typeof makeWorld>[0]][] = [
      ["the HTTP 200 fake error record (RecallID 0)", () => ({ net: { cpsc: () => res(cpscError) } })],
      [
        "a result at the ceiling",
        () => ({
          net: {
            cpsc: () => res(Array.from({ length: 2000 }, (_, i) => ({ RecallID: i + 1, RecallNumber: `R${i}` }))),
          },
        }),
      ],
      ["HTTP 500", () => ({ net: { cpsc: () => res({}, 500) } })],
      ["HTTP 429", () => ({ net: { cpsc: () => res({}, 429) } })],
      [
        "a network error",
        () => ({ net: { cpsc: () => Promise.reject(new Error("ECONNRESET to https://secret.example/?token=abc")) } }),
      ],
      [
        "a body that is not JSON",
        () => ({
          net: {
            cpsc: () => ({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError("Unexpected token <")) }),
          },
        }),
      ],
      ["a body that is not a list", () => ({ net: { cpsc: () => res({ message: "maintenance" }) } })],
      ["a record that is not an object", () => ({ net: { cpsc: () => res(["x"]) } })],
    ];

    it.each(failures)("%s", async (_name, make) => {
      const w = await makeWorld(make());
      // Existing recall alerts from an earlier good run.
      const good = await makeWorld();
      await good.run(ANCHOR, { sender: undefined });
      for (const a of await good.repo.listAlerts(A)) await w.repo.putAlert(A, a);
      const before = await snapshot(w);
      const r = await w.run(ANCHOR, { sender: undefined });
      const h = r.households[0]!;
      const cpsc = h.errors.filter((e) => e.source === "cpsc");
      expect(cpsc).toHaveLength(1);
      expect(cpsc[0]!.kind).toBe("api_error");
      expect(h.recallsChecked).toBe(4); // only the NHTSA recalls: CPSC counted nothing
      expect(await snapshot(w)).toBe(before);
      // The report holds no URL, token or body text.
      expect(JSON.stringify(h.errors)).not.toMatch(/https?:|token|Error retrieving|secret/i);
    });

    it("the other steps and households still run when CPSC fails", async () => {
      const w = await makeWorld({ net: { cpsc: () => res(cpscError) } });
      await addHousehold(w, "h2");
      await addAsset(w.repo, "h2", { id: "b", name: "Bottles", brand: "Boon", upc: "669028116546" });
      await w.repo.putAgreement("h2", {
        id: "w",
        kind: "warranty",
        title: "w",
        assetIds: [],
        fields: { endDate: days(3) },
        fieldStatus: { endDate: "confirmed" },
        sourceRefs: {},
        createdAt: "x",
      });
      const r = await w.run();
      expect(r.households.map((h) => h.householdId)).toEqual(["h2", "hh_demo"]);
      const demo = r.households.find((h) => h.householdId === A)!;
      expect(demo.alertsCreated).toBe(7);
      expect(demo.email.status).toBe("sent");
      expect(r.households.find((h) => h.householdId === "h2")!.alertsCreated).toBe(1);
    });

    it("a CPSC failure creates no recall alert and the CPSC request is still only made once", async () => {
      const w = await makeWorld({ net: { cpsc: () => res(cpscError) } });
      await addHousehold(w, "h2");
      await addAsset(w.repo, "h2", { id: "b", name: "Bottles", brand: "Boon", upc: "669028116546" });
      const r = await w.run();
      expect(w.net.cpsc()).toHaveLength(1);
      expect(await recallAlerts(w, "h2")).toEqual([]);
      expect(r.households.every((h) => h.errors.some((e) => e.source === "cpsc"))).toBe(true);
    });

    it("a real empty list is not an error, and it does not erase existing alerts either", async () => {
      const w = await makeWorld({ net: { cpsc: () => res([]) } });
      const good = await makeWorld();
      await good.run(ANCHOR, { sender: undefined });
      for (const a of await good.repo.listAlerts(A)) await w.repo.putAlert(A, a);
      const before = await snapshot(w);
      const r = await w.run(ANCHOR, { sender: undefined });
      expect(r.households[0]!.errors.filter((e) => e.source === "cpsc")).toEqual([]);
      expect(await snapshot(w)).toBe(before);
    });

    it("a failed run followed by a good run raises the alert (nothing was marked as checked)", async () => {
      const w = await makeWorld({ net: { cpsc: () => res(cpscError) } });
      await w.run(ANCHOR, { sender: undefined });
      expect(await w.repo.getAlert(A, recallAlertId("cpsc", "26530", "A-baby-bottles"))).toBeNull();
      const ok = await makeWorld();
      const r = await ok.run(ANCHOR, { sender: undefined });
      expect(r.households[0]!.recallAlertsCreated).toBe(5);
    });
  });
});

describe("NHTSA radar", () => {
  it("canonicalizes the vehicle once and stores nhtsaMake and nhtsaModel on the asset", async () => {
    const w = await makeWorld();
    expect((await w.repo.getAsset(A, "A-car"))!.vehicle).toEqual({ make: "Honda", model: "CR-V", modelYear: 2021 });
    await w.run();
    expect((await w.repo.getAsset(A, "A-car"))!.vehicle).toMatchObject({ nhtsaMake: "HONDA", nhtsaModel: "CR-V" });
    expect(w.net.nhtsa().filter((u) => u.includes("/models"))).toHaveLength(1);
    await w.run();
    expect(w.net.nhtsa().filter((u) => u.includes("/models"))).toHaveLength(1);
  });

  it("the spoken spelling CRV is canonicalized to CR-V before any recall query", async () => {
    const w = await makeWorld({ demo: false });
    await addHousehold(w, "h");
    await addAsset(w.repo, "h", { id: "v", name: "Car", vehicle: { make: "Honda", model: "CRV", modelYear: 2021 } });
    await w.run();
    const q = w.net.nhtsa().filter((u) => u.includes("recallsByVehicle"));
    expect(q).toHaveLength(1);
    expect(new URL(q[0]!).searchParams.get("model")).toBe("CR-V");
    expect(new URL(q[0]!).searchParams.get("make")).toBe("HONDA");
    expect((await recallAlerts(w, "h")).length).toBe(4);
  });

  it("a vehicle NHTSA does not list is reported and never queried by its spoken spelling", async () => {
    const w = await makeWorld({ demo: false });
    await addHousehold(w, "h");
    await addAsset(w.repo, "h", {
      id: "v",
      name: "Car",
      vehicle: { make: "Honda", model: "Zorblax", modelYear: 2021 },
    });
    const r = await w.run();
    expect(w.net.nhtsa().filter((u) => u.includes("recallsByVehicle"))).toEqual([]);
    expect(r.households[0]!.errors).toEqual([
      expect.objectContaining({ source: "nhtsa", kind: "no_canonical_vehicle", assetId: "v" }),
    ]);
    expect((await w.repo.getAsset("h", "v"))!.vehicle).not.toHaveProperty("nhtsaMake");
  });

  it("matches canonical make, model and year: four campaigns for the CR-V, all high", async () => {
    const w = await makeWorld();
    await w.run();
    const car = (await recallAlerts(w)).filter((a) => a.assetId === "A-car");
    expect(car.map((a) => a.refId).sort()).toEqual(["21V900000", "23V858000", "24V064000", "26V332000"]);
    expect(car.every((a) => a.severity === "high")).toBe(true);
    expect(car.every((a) => a.id === recallAlertId("nhtsa", a.refId, "A-car"))).toBe(true);
  });

  it("every NHTSA alert says it may affect the car and points to the VIN", async () => {
    const w = await makeWorld();
    await w.run();
    for (const a of (await recallAlerts(w)).filter((x) => x.assetId === "A-car")) {
      expect(a.detail).toMatch(/may affect your/i);
      expect(a.detail).toMatch(/VIN/);
      expect(a.detail).not.toMatch(/will|is affected|your car is/i);
    }
  });

  it("the digest wording for a vehicle recall says may affect", async () => {
    const w = await makeWorld();
    await w.run();
    expect(w.mail.sent[0]!.text).toMatch(/may affect your car/);
  });

  it("a different model year in the answer is not a match", async () => {
    const w = await makeWorld({ demo: false });
    await addHousehold(w, "h");
    await addAsset(w.repo, "h", {
      id: "v",
      name: "Car",
      vehicle: { make: "Honda", model: "CR-V", modelYear: 2020, nhtsaMake: "HONDA", nhtsaModel: "CR-V" },
    });
    // The recorded body is for 2021, so a 2020 car must not alert on it.
    await w.run();
    expect(await recallAlerts(w, "h")).toEqual([]);
  });

  it("a different model in the answer is not a match", async () => {
    const w = await makeWorld({ demo: false });
    await addHousehold(w, "h");
    await addAsset(w.repo, "h", {
      id: "v",
      name: "Car",
      vehicle: { make: "Honda", model: "Pilot", modelYear: 2021, nhtsaMake: "HONDA", nhtsaModel: "PILOT" },
    });
    await w.run();
    expect(await recallAlerts(w, "h")).toEqual([]);
  });

  it("an honest Count 0 answer is not an error and creates nothing", async () => {
    const w = await makeWorld({ net: { recalls: () => res(zeroResults) } });
    const r = await w.run();
    expect(r.households[0]!.errors.filter((e) => e.source === "nhtsa")).toEqual([]);
    expect((await recallAlerts(w)).filter((a) => a.assetId === "A-car")).toEqual([]);
  });

  it("two households with the same car cost one models and one recalls request", async () => {
    const w = await makeWorld();
    await addHousehold(w, "h2");
    await addAsset(w.repo, "h2", { id: "c2", name: "Car", vehicle: { make: "Honda", model: "CR-V", modelYear: 2021 } });
    await w.run();
    expect(w.net.nhtsa()).toHaveLength(2);
    expect((await recallAlerts(w, "h2")).length).toBe(4);
  });

  describe("every NHTSA failure is an error, never an all-clear", () => {
    const failures: [string, Parameters<typeof makeWorld>[0], string][] = [
      [
        "Count does not match results",
        { net: { recalls: () => res({ Count: 3, Message: "ok", results: [] }) } },
        "Count",
      ],
      ["Count missing", { net: { recalls: () => res({ results: [] }) } }, "Count"],
      ["results missing", { net: { recalls: () => res({ Count: 0 }) } }, "malformed"],
      ["HTTP 400 (final, never retried)", { net: { recalls: () => res({}, 400) } }, "HTTP 400"],
      ["HTTP 500 after three attempts", { net: { recalls: () => res({}, 500) } }, "3 attempts"],
      ["HTTP 429 after three attempts", { net: { recalls: () => res({}, 429) } }, "3 attempts"],
      [
        "a network error",
        { net: { recalls: () => Promise.reject(new Error("ECONNRESET https://api.nhtsa.gov/x")) } },
        "network",
      ],
      [
        "a body that is not JSON",
        { net: { recalls: () => ({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError("x")) }) } },
        "not JSON",
      ],
    ];

    it.each(failures)("%s", async (_n, opts, why) => {
      const w = await makeWorld(opts);
      const good = await makeWorld();
      await good.run(ANCHOR, { sender: undefined });
      for (const a of await good.repo.listAlerts(A)) await w.repo.putAlert(A, a);
      const before = await snapshot(w);
      const r = await w.run(ANCHOR, { sender: undefined });
      const errs = r.households[0]!.errors.filter((e) => e.source === "nhtsa");
      expect(errs).toHaveLength(1);
      expect(errs[0]).toMatchObject({ kind: "api_error", assetId: "A-car" });
      expect(errs[0]!.message).toContain(why);
      expect(await snapshot(w)).toBe(before);
      expect(JSON.stringify(errs)).not.toMatch(/https?:|api\.nhtsa/i);
    });

    it("a 400 is not retried, a 500 is retried with backoff", async () => {
      const a = await makeWorld({ net: { recalls: () => res({}, 400) } });
      await a.run();
      expect(a.net.nhtsa().filter((u) => u.includes("recallsByVehicle"))).toHaveLength(1);
      const b = await makeWorld({ net: { recalls: () => res({}, 500) } });
      await b.run();
      expect(b.net.nhtsa().filter((u) => u.includes("recallsByVehicle"))).toHaveLength(3);
      expect(b.sleeps).toEqual(expect.arrayContaining([500, 1000]));
    });

    it("a failed models lookup is reported, the asset is not changed and no recall query is made", async () => {
      const w = await makeWorld({ net: { models: () => res({}, 500) } });
      const r = await w.run();
      expect(r.households[0]!.errors).toEqual([
        expect.objectContaining({ source: "nhtsa", kind: "api_error", assetId: "A-car" }),
      ]);
      expect((await w.repo.getAsset(A, "A-car"))!.vehicle).not.toHaveProperty("nhtsaMake");
      expect(w.net.nhtsa().filter((u) => u.includes("recallsByVehicle"))).toEqual([]);
    });

    it("a malformed models answer is reported and writes nothing to the asset", async () => {
      const w = await makeWorld({ net: { models: () => res({ nothing: true }) } });
      const r = await w.run();
      expect(r.households[0]!.errors[0]).toMatchObject({ source: "nhtsa", kind: "api_error" });
      expect((await w.repo.getAsset(A, "A-car"))!.vehicle).not.toHaveProperty("nhtsaModel");
    });

    it("an NHTSA failure does not stop CPSC alerts, deadlines or the digest", async () => {
      const w = await makeWorld({ net: { recalls: () => res({}, 400) } });
      const r = await w.run();
      const h = r.households[0]!;
      expect(await w.repo.getAlert(A, recallAlertId("cpsc", "26530", "A-baby-bottles"))).not.toBeNull();
      expect(h.alertsCreated).toBe(7);
      expect(h.email.status).toBe("sent");
    });

    it("the failure repeats on the next run (it is not remembered as a clear)", async () => {
      const w = await makeWorld({ net: { recalls: () => res({}, 400) } });
      await w.run();
      const r = await w.run();
      expect(r.households[0]!.errors.some((e) => e.source === "nhtsa")).toBe(true);
    });
  });

  describe("cost guard and pacing", () => {
    it("reports the default cap of 20", async () => {
      const w = await makeWorld();
      const r = await w.run();
      expect(r.requests).toEqual({ cpsc: 1, nhtsa: 2, nhtsaCap: 20, nhtsaCapReached: false });
    });

    it("stops at the cap, reports it, and checks nothing past it", async () => {
      const w = await makeWorld({ config: { maxNhtsaRequests: 1 } });
      const r = await w.run();
      expect(r.requests.nhtsa).toBe(1);
      expect(r.requests.nhtsaCapReached).toBe(true);
      expect(r.households[0]!.errors).toContainEqual(
        expect.objectContaining({ source: "nhtsa", kind: "request_cap", assetId: "A-car" }),
      );
      expect(w.net.nhtsa()).toHaveLength(1);
    });

    it("a cap of 0 makes no NHTSA request at all", async () => {
      const w = await makeWorld({ config: { maxNhtsaRequests: 0 } });
      const r = await w.run();
      expect(w.net.nhtsa()).toEqual([]);
      expect(r.requests.nhtsaCapReached).toBe(true);
    });

    it("the cap counts retries, so a failing API cannot exceed it", async () => {
      const w = await makeWorld({ net: { recalls: () => res({}, 500) }, config: { maxNhtsaRequests: 2 } });
      const r = await w.run();
      expect(w.net.nhtsa().length).toBeLessThanOrEqual(2);
      expect(r.requests.nhtsa).toBeLessThanOrEqual(2);
      expect(r.requests.nhtsaCapReached).toBe(true);
    });

    it("many cars across households stop at the cap", async () => {
      const w = await makeWorld({ demo: false, config: { maxNhtsaRequests: 3 } });
      for (let i = 0; i < 4; i++) {
        await addHousehold(w, `h${i}`);
        await addAsset(w.repo, `h${i}`, {
          id: "c",
          name: "Car",
          vehicle: { make: "Honda", model: "CR-V", modelYear: 2021, nhtsaMake: "HONDA", nhtsaModel: `CR-V${i}` },
        });
      }
      const r = await w.run();
      expect(r.requests.nhtsa).toBe(3);
      expect(r.requests.nhtsaCapReached).toBe(true);
    });

    it("the injected sleep paces NHTSA calls 250 ms apart", async () => {
      const w = await makeWorld();
      await w.run();
      // The clock is fixed, so the second call must wait one full slot.
      expect(w.sleeps).toContain(250);
    });
  });
});
