import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { linkAssetHint, linkVehicleHint, type AssetRecord, type Link } from "../src";

const dir = fileURLToPath(new URL("../../../fixtures/expected/", import.meta.url));
const load = (name: string) => JSON.parse(readFileSync(`${dir}${name}.json`, "utf8"));
const unwrap = (v: any) => (v && typeof v === "object" && "sourceRef" in v ? v.value : v);
const seeded = load("assets") as AssetRecord[];

const matchId = (l: Link) => (l.status === "match" ? l.asset.id : l.status);
const askIds = (l: Link) => (l.status === "ambiguous" ? l.candidates.map((c) => c.id) : []);

const dw: AssetRecord = {
  id: "dw",
  name: "Dishwasher",
  brand: "Northwind",
  modelNumber: "NW-DW500",
  serialLast4: "7731",
};

describe("linkAssetHint: model number is the evidence", () => {
  it("links the seeded dishwasher from the warranty fixture's own hint", () => {
    const hint = load("warranty_dishwasher").fields.assetHint;
    const l = linkAssetHint(
      { brand: unwrap(hint.brand), model: unwrap(hint.model), serial: unwrap(hint.serial) },
      seeded,
    );
    expect(matchId(l)).toBe("A-dishwasher");
  });
  it.each(["NW-DW500", "nw dw 500", "NWDW500", "nw_dw-500 "])("matches the model written as %s", (model) => {
    expect(matchId(linkAssetHint({ brand: "Northwind", model }, [dw]))).toBe("dw");
  });
  it("matches when the hint has no brand", () => {
    expect(matchId(linkAssetHint({ model: "NW-DW500" }, [dw]))).toBe("dw");
  });
  it("matches when the asset has no brand recorded", () => {
    expect(
      matchId(
        linkAssetHint({ brand: "Northwind", model: "NW-DW500" }, [
          { id: "x", name: "Dishwasher", modelNumber: "NW-DW500" },
        ]),
      ),
    ).toBe("x");
  });
  it("does not match when the brand contradicts", () => {
    const l = linkAssetHint({ brand: "Acme", model: "NW-DW500" }, [dw]);
    expect(l.status).toBe("propose");
  });
  it("does not match a different model", () => {
    expect(linkAssetHint({ brand: "Northwind", model: "NW-DW900" }, [dw]).status).toBe("propose");
  });
  it("ignores a model too short to tell products apart", () => {
    const l = linkAssetHint({ brand: "Northwind", model: "A1" }, [{ ...dw, modelNumber: "A1" }]);
    expect(l.status).toBe("ambiguous");
  });
});

describe("linkAssetHint: serial number", () => {
  it("matches when the last 4 agree", () => {
    expect(matchId(linkAssetHint({ brand: "Northwind", model: "NW-DW500", serial: "7731" }, [dw]))).toBe("dw");
  });
  it("uses only the last 4 of a longer serial", () => {
    expect(matchId(linkAssetHint({ model: "NW-DW500", serial: "SN-12347731" }, [dw]))).toBe("dw");
  });
  it("treats a different serial as a second unit, so it is a new asset", () => {
    const l = linkAssetHint({ brand: "Northwind", model: "NW-DW500", serial: "1111" }, [dw]);
    expect(l.status).toBe("propose");
  });
  it("still matches when either side has no serial", () => {
    expect(matchId(linkAssetHint({ model: "NW-DW500" }, [dw]))).toBe("dw");
    expect(matchId(linkAssetHint({ model: "NW-DW500", serial: "7731" }, [{ ...dw, serialLast4: null }]))).toBe("dw");
  });
  it("uses the serial to pick between two units of one model", () => {
    const two = [
      { ...dw, id: "a", serialLast4: "1111" },
      { ...dw, id: "b", serialLast4: "2222" },
    ];
    expect(matchId(linkAssetHint({ model: "NW-DW500", serial: "2222" }, two))).toBe("b");
  });
  it("is ambiguous between two units of one model with no serial", () => {
    const two = [
      { ...dw, id: "b", serialLast4: "2222" },
      { ...dw, id: "a", serialLast4: "1111" },
    ];
    expect(askIds(linkAssetHint({ model: "NW-DW500" }, two))).toEqual(["a", "b"]);
  });
  it("ignores a serial of fewer than 4 characters", () => {
    expect(matchId(linkAssetHint({ model: "NW-DW500", serial: "77" }, [dw]))).toBe("dw");
    const l = linkAssetHint({ brand: "Acme", model: "X100", serial: "77" }, []);
    expect(l.status === "propose" && l.draft.serialLast4).toBeUndefined();
  });
});

describe("linkAssetHint: weak evidence is only a question", () => {
  it("never matches on brand alone", () => {
    const l = linkAssetHint({ brand: "Northwind" }, [dw]);
    expect(l.status).toBe("ambiguous");
    expect(askIds(l)).toEqual(["dw"]);
  });
  it("asks about a same-brand asset that has no model recorded", () => {
    const voiceAdded: AssetRecord = { id: "v", name: "Dishwasher", brand: "Northwind" };
    expect(askIds(linkAssetHint({ brand: "Northwind", model: "NW-DW500" }, [voiceAdded]))).toEqual(["v"]);
  });
  it("asks about the seeded Boon bottles, which have a brand but no model", () => {
    expect(askIds(linkAssetHint({ brand: "Boon", model: "B11654" }, seeded))).toEqual(["A-baby-bottles"]);
  });
  it("proposes a new asset when nothing in the household fits", () => {
    const l = linkAssetHint({ brand: "Acme", model: "X-100", serial: "SN9876" }, [dw]);
    expect(l).toEqual({
      status: "propose",
      draft: { name: "Acme X-100", brand: "Acme", modelNumber: "X-100", serialLast4: "9876" },
    });
  });
  it("proposes from a brand alone when no asset has that brand", () => {
    expect(linkAssetHint({ brand: "Acme" }, [dw])).toEqual({
      status: "propose",
      draft: { name: "Acme", brand: "Acme" },
    });
  });
  it("trims text in the draft", () => {
    const l = linkAssetHint({ brand: "  Acme ", model: " X-100 " }, []);
    expect(l.status === "propose" && l.draft.name).toBe("Acme X-100");
  });
  it("offers at most 3 options, sorted by name then id", () => {
    const many = ["e", "d", "c", "b", "a"].map((id): AssetRecord => ({ id, name: "Plug", brand: "Acme" }));
    expect(askIds(linkAssetHint({ brand: "Acme" }, many))).toEqual(["a", "b", "c"]);
  });
});

describe("linkAssetHint: nothing to go on", () => {
  it.each([
    {},
    { brand: null, model: null, serial: null },
    { serial: "7731" },
    { model: "A1" },
    { brand: " ", model: "" },
  ])("returns none for %j", (hint) => {
    expect(linkAssetHint(hint, [dw]).status).toBe("none");
  });
  it("does not change its input and does not depend on asset order", () => {
    const list = [
      { ...dw, id: "b", serialLast4: "2222" },
      { ...dw, id: "a", serialLast4: "1111" },
    ];
    const copy = JSON.parse(JSON.stringify(list));
    const fwd = linkAssetHint({ model: "NW-DW500" }, list);
    expect(list).toEqual(copy);
    expect(linkAssetHint({ model: "NW-DW500" }, [...list].reverse())).toEqual(fwd);
  });
});

describe("linkAssetHint: text the key must not flatten", () => {
  it("does not ignore a brand written in another script", () => {
    const l = linkAssetHint({ brand: "サムスン", model: "XYZ123" }, [
      { id: "lg", name: "TV", brand: "LG", modelNumber: "XYZ123" },
    ]);
    expect(l.status).toBe("propose");
  });
  it("does not match two models that differ only in non-Latin letters", () => {
    const l = linkAssetHint({ model: "ΑΒΓ-100" }, [{ id: "a", name: "Lamp", modelNumber: "ΔΕΖ-100" }]);
    expect(l.status).toBe("propose");
  });
  it("does not throw on a numeric model", () => {
    expect(
      matchId(linkAssetHint({ model: 500 as unknown as string }, [{ id: "n", name: "Fan", modelNumber: "500" }])),
    ).toBe("n");
  });
  it("finds the asset when the hint's model repeats the brand", () => {
    const owned: AssetRecord = { id: "a", name: "Dishwasher", brand: "Acme", modelNumber: "DW500" };
    expect(matchId(linkAssetHint({ brand: "Acme", model: "Acme DW500" }, [owned]))).toBe("a");
  });
  it("does not write the brand twice in a proposal", () => {
    expect(linkAssetHint({ brand: "Acme", model: "Acme DW500" }, [])).toEqual({
      status: "propose",
      draft: { name: "Acme DW500", brand: "Acme", modelNumber: "DW500" },
    });
  });
});

describe("linkAssetHint: an exact serial beats a unit with no serial", () => {
  const x: AssetRecord = { ...dw, id: "x", serialLast4: "2345" };
  const y: AssetRecord = { ...dw, id: "y", serialLast4: null };
  it("picks the unit whose serial matches over one that has none", () => {
    expect(matchId(linkAssetHint({ model: "NW-DW500", serial: "2345" }, [y, x]))).toBe("x");
  });
  it("still treats a stated serial that matches nobody as the unit with no serial", () => {
    expect(matchId(linkAssetHint({ model: "NW-DW500", serial: "9999" }, [x, y]))).toBe("y");
  });
});

describe("linkVehicleHint: a year must be a real year", () => {
  const rav: AssetRecord = { id: "r", name: "Car", vehicle: { make: "Toyota", model: "RAV4", modelYear: 2020 } };
  it.each([Number.NaN, Number.POSITIVE_INFINITY, 20200, 2020.5, 0, -2020])(
    "treats %s as no year, so it asks about the owned car",
    (year) => {
      expect(askIds(linkVehicleHint({ make: "Toyota", model: "RAV4", year }, [rav]))).toEqual(["r"]);
    },
  );
  it("drafts a car without a year when the year is nonsense", () => {
    const l = linkVehicleHint({ make: "Toyota", model: "RAV4", year: Number.NaN }, []);
    expect(l.status === "propose" && l.draft).toEqual({
      name: "Toyota RAV4",
      category: "vehicle",
      vehicle: { make: "Toyota", model: "RAV4" },
    });
  });
  it("still treats a sane year as a year", () => {
    expect(matchId(linkVehicleHint({ make: "Toyota", model: "RAV4", year: 2020 }, [rav]))).toBe("r");
  });
});

describe("linkVehicleHint", () => {
  it("links the seeded Honda from the insurance fixture's own hint", () => {
    const hint = unwrap(load("insurance_auto").fields.coveredAssetHints[0]);
    expect(matchId(linkVehicleHint(hint, seeded))).toBe("A-car");
  });
  it.each([
    ["honda", "cr-v"],
    ["HONDA", "CR V"],
    ["Honda", "crv"],
  ])("matches %s %s", (make, model) => {
    expect(matchId(linkVehicleHint({ make, model, year: 2021 }, seeded))).toBe("A-car");
  });
  it("accepts the NHTSA spelling on the asset", () => {
    const car: AssetRecord = {
      id: "c",
      name: "Car",
      vehicle: { make: "Honda", model: "CR-V", modelYear: 2021, nhtsaMake: "HONDA", nhtsaModel: "CR-V" },
    };
    expect(matchId(linkVehicleHint({ make: "HONDA", model: "CR-V", year: 2021 }, [car]))).toBe("c");
  });
  it("treats another model year as another car", () => {
    const l = linkVehicleHint({ make: "Honda", model: "CR-V", year: 2022 }, seeded);
    expect(l).toEqual({
      status: "propose",
      draft: {
        name: "2022 Honda CR-V",
        category: "vehicle",
        vehicle: { make: "Honda", model: "CR-V", modelYear: 2022 },
      },
    });
  });
  it("asks when the policy gives no year", () => {
    expect(askIds(linkVehicleHint({ make: "Honda", model: "CR-V" }, seeded))).toEqual(["A-car"]);
  });
  it("asks when two cars agree on make, model and year", () => {
    const cars = ["x", "y"].map((id): AssetRecord => ({
      id,
      name: `Car ${id}`,
      vehicle: { make: "Honda", model: "CR-V", modelYear: 2021 },
    }));
    expect(askIds(linkVehicleHint({ make: "Honda", model: "CR-V", year: 2021 }, cars))).toEqual(["x", "y"]);
  });
  it("proposes a vehicle for a car the household does not have", () => {
    const l = linkVehicleHint({ make: "Toyota", model: "RAV4", year: 2020 }, seeded);
    expect(l.status === "propose" && l.draft).toEqual({
      name: "2020 Toyota RAV4",
      category: "vehicle",
      vehicle: { make: "Toyota", model: "RAV4", modelYear: 2020 },
    });
  });
  it("proposes without a year when the policy has none", () => {
    const l = linkVehicleHint({ make: "Toyota", model: "RAV4" }, []);
    expect(l.status === "propose" && l.draft).toEqual({
      name: "Toyota RAV4",
      category: "vehicle",
      vehicle: { make: "Toyota", model: "RAV4" },
    });
  });
  it("ignores assets that are not vehicles", () => {
    expect(linkVehicleHint({ make: "Northwind", model: "NW-DW500", year: 2025 }, [dw]).status).toBe("propose");
  });
  it.each([{}, { make: "Honda" }, { model: "CR-V", year: 2021 }, { make: null, model: null }])(
    "returns none for %j",
    (hint) => {
      expect(linkVehicleHint(hint, seeded).status).toBe("none");
    },
  );
  it("does not change its input", () => {
    const copy = JSON.parse(JSON.stringify(seeded));
    linkVehicleHint({ make: "Honda", model: "CR-V", year: 2021 }, seeded);
    expect(seeded).toEqual(copy);
  });
});
