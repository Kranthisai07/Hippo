import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveAgreement, resolveAsset, tokens, type AgreementLike, type AssetLike } from "../src";

const home: AssetLike[] = [
  { id: "dw", name: "Dishwasher", aliases: ["dish washer"], category: "appliance", brand: "Northwind", location: "kitchen" },
  { id: "fr", name: "Refrigerator", aliases: ["fridge"], category: "appliance", brand: "Coolmax", location: "kitchen" },
  { id: "wf1", name: "Kitchen water filter", category: "appliance", location: "kitchen" },
  { id: "wf2", name: "Fridge water filter", category: "appliance", location: "kitchen" },
  { id: "tv", name: "Living room TV", aliases: ["television"], category: "electronics", brand: "Vista", location: "living room" },
  { id: "car", name: "Car", aliases: ["Honda", "CR-V", "my car"], category: "vehicle", brand: "Honda", location: "garage" },
  { id: "wh", name: "Water heater", category: "appliance", location: "basement" },
  { id: "bb", name: "Boon NURSH baby bottles", aliases: ["baby bottles"], category: "child_safety", brand: "Boon" },
];

const id = (r: ReturnType<typeof resolveAsset>) => (r.status === "match" ? r.item.id : r.status);
const ids = (r: ReturnType<typeof resolveAsset>) => (r.status === "ambiguous" ? r.candidates.map((c) => c.id).sort() : []);

describe("tokens", () => {
  it("lowercases and strips punctuation", () => {
    expect(tokens("Dish-Washer!!")).toEqual(["dishwasher"]);
  });
  it("drops filler words", () => {
    expect(tokens("my dishwasher please")).toEqual(["dishwasher"]);
  });
  it("folds a plural into its singular", () => {
    expect(tokens("water filters")).toEqual(["water", "filter"]);
    expect(tokens("batteries")).toEqual(["battery"]);
  });
  it("leaves double s and short words alone", () => {
    expect(tokens("glass gas")).toEqual(["glass", "gas"]);
  });
  it.each([
    ["dish washer", "dishwasher"],
    ["refrigerator", "fridge"],
    ["icebox", "fridge"],
    ["television", "tv"],
    ["air conditioner", "ac"],
    ["A/C", "ac"],
    ["cell phone", "phone"],
    ["automobile", "car"],
    ["hot water tank", "waterheater"],
    ["smoke alarm", "smokedetector"],
    ["sofa", "couch"],
    ["washing machine", "washer"],
  ])("maps %s to %s", (input, canon) => {
    expect(tokens(input)).toEqual([canon]);
  });
  it("joins hyphenated model names but not ordinary hyphenated words", () => {
    expect(tokens("CR-V")).toEqual(["crv"]);
    expect(tokens("F-150")).toEqual(["f150"]);
    expect(tokens("water-filter")).toEqual(["water", "filter"]);
  });
  it("keeps water heater and furnace apart", () => {
    expect(tokens("water heater")).toEqual(["waterheater"]);
    expect(tokens("heater")).toEqual(["furnace"]);
  });
  it("drops problem words but keeps can as a noun", () => {
    expect(tokens("my dishwasher is leaking")).toEqual(["dishwasher"]);
    expect(tokens("trash can")).toEqual(["trash", "can"]);
  });
  it("drops apostrophes inside words", () => {
    expect(tokens("what's the landlord's number")).toEqual(["landlord", "number"]);
  });
  it("returns nothing for empty or filler-only text", () => {
    expect(tokens("")).toEqual([]);
    expect(tokens("my the of")).toEqual([]);
  });
});

describe("resolveAsset: matching", () => {
  it("matches by name", () => {
    expect(id(resolveAsset("dishwasher", home))).toBe("dw");
  });
  it("is case and punctuation insensitive", () => {
    expect(id(resolveAsset("DISH-WASHER!", home))).toBe("dw");
  });
  it("matches by alias", () => {
    expect(id(resolveAsset("fridge", home))).toBe("fr");
  });
  it("matches by synonym with no alias stored", () => {
    expect(id(resolveAsset("icebox", home))).toBe("fr");
    expect(id(resolveAsset("television", home))).toBe("tv");
  });
  it("ignores filler and the problem words around the name", () => {
    expect(id(resolveAsset("my dishwasher is leaking", home))).toBe("dw");
  });
  it("matches a plural", () => {
    expect(id(resolveAsset("baby bottles", home))).toBe("bb");
  });
  it("matches by brand", () => {
    expect(id(resolveAsset("the Northwind", home))).toBe("dw");
  });
  it("matches by location when it is the only clue", () => {
    expect(id(resolveAsset("living room tv", home))).toBe("tv");
  });
  it("matches a vehicle through its make", () => {
    expect(id(resolveAsset("my honda", home))).toBe("car");
    expect(id(resolveAsset("the crv", home))).toBe("car");
  });
  it("treats vehicle and automobile as car", () => {
    expect(id(resolveAsset("vehicle", home))).toBe("car");
  });
  it("prefers the asset whose name is exactly what was said", () => {
    expect(id(resolveAsset("water heater", home))).toBe("wh");
  });
  it("matches a hot water tank to the water heater", () => {
    expect(id(resolveAsset("hot water tank", home))).toBe("wh");
  });
});

describe("resolveAsset: words that are part of a name", () => {
  const laptops: AssetLike[] = [
    { id: "work", name: "Work laptop" },
    { id: "home", name: "Personal laptop" },
  ];
  it("keeps work, cover and show in the words", () => {
    expect(tokens("work laptop")).toEqual(["work", "laptop"]);
    expect(tokens("Pool cover")).toEqual(["pool", "cover"]);
    expect(tokens("show projector")).toEqual(["show", "projector"]);
  });
  it("asks which laptop when the user just says laptop", () => {
    const r = resolveAsset("my laptop", laptops);
    expect(r.status).toBe("ambiguous");
    expect(ids(r)).toEqual(["home", "work"]);
  });
  it("finds each laptop by its full name", () => {
    expect(id(resolveAsset("work laptop", laptops))).toBe("work");
    expect(id(resolveAsset("personal laptop", laptops))).toBe("home");
  });
  it("tells a pool cover from the pool", () => {
    const pool: AssetLike[] = [
      { id: "pool", name: "Pool" },
      { id: "cover", name: "Pool cover" },
    ];
    expect(id(resolveAsset("pool cover", pool))).toBe("cover");
    expect(id(resolveAsset("pool", pool))).toBe("pool");
  });
  it("still strips problem words so a whole sentence finds the dishwasher", () => {
    expect(id(resolveAsset("my dishwasher is leaking", home))).toBe("dw");
  });
});

describe("resolveAsset: never guess", () => {
  it("is ambiguous for two water filters", () => {
    const r = resolveAsset("water filter", home);
    expect(r.status).toBe("ambiguous");
    expect(ids(r)).toEqual(["wf1", "wf2"]);
  });
  it("is resolved once a clue separates the two filters", () => {
    expect(id(resolveAsset("fridge water filter", home))).toBe("wf2");
    expect(id(resolveAsset("kitchen water filter", home))).toBe("wf1");
  });
  it("is ambiguous when one word fits several things", () => {
    expect(resolveAsset("water", home).status).toBe("ambiguous");
  });
  it("offers at most 3 options", () => {
    const many = ["a", "b", "c", "d", "e"].map((x): AssetLike => ({ id: x, name: "Smart plug", location: x }));
    const r = resolveAsset("smart plug", many);
    expect(r.status).toBe("ambiguous");
    expect(ids(r).length).toBeLessThanOrEqual(3);
  });
  it("returns none for something not in the household", () => {
    expect(resolveAsset("espresso machine", home).status).toBe("none");
    expect(resolveAsset("boat", home).status).toBe("none");
  });
  it("does not match on a weak single overlap", () => {
    expect(resolveAsset("kitchen island", home).status).not.toBe("match");
  });
  it("returns none for an empty query or an empty household", () => {
    expect(resolveAsset("", home).status).toBe("none");
    expect(resolveAsset("my the", home).status).toBe("none");
    expect(resolveAsset("dishwasher", []).status).toBe("none");
  });
  it("does not mutate its inputs", () => {
    const copy = JSON.parse(JSON.stringify(home));
    resolveAsset("water filter", home);
    expect(home).toEqual(copy);
  });
  it("is deterministic regardless of asset order", () => {
    const reversed = [...home].reverse();
    expect(ids(resolveAsset("water filter", reversed))).toEqual(ids(resolveAsset("water filter", home)));
    expect(id(resolveAsset("fridge", reversed))).toBe("fr");
  });
});

describe("resolveAsset: a name that merely contains the words is a question, not an answer", () => {
  const as = (...names: string[]): AssetLike[] => names.map((name, i) => ({ id: `a${i}`, name }));
  it("does not answer 'fridge' with the fridge water filter", () => {
    const r = resolveAsset("fridge", [
      { id: "fridge", name: "Samsung RF28", category: "fridge" },
      { id: "filter", name: "Fridge water filter" },
    ]);
    expect(id(r)).toBe("fridge");
  });
  it("asks about the TV stand instead of calling it a TV", () => {
    const r = resolveAsset("tv", as("TV stand"));
    expect(r.status).toBe("ambiguous");
    expect(ids(r)).toEqual(["a0"]);
  });
  it.each([
    ["my car", "Car seat"],
    ["phone", "Phone charger"],
    ["dryer", "Dryer vent"],
  ])("asks about the %s look-alike %s", (query, name) => {
    expect(resolveAsset(query, as(name)).status).toBe("ambiguous");
  });
  it("still finds a shortened name when the head word is said", () => {
    expect(id(resolveAsset("filter", as("Water filter")))).toBe("a0");
    expect(id(resolveAsset("dishwasher", as("Kitchen dishwasher")))).toBe("a0");
  });
  it("treats a model number as not the head: iPhone 15 is a phone", () => {
    expect(id(resolveAsset("phone", as("iPhone 15")))).toBe("a0");
  });
  it("matches by category or brand when the name is a model number", () => {
    expect(id(resolveAsset("dishwasher", [{ id: "dw", name: "Bosch SHX878", category: "dishwasher" }]))).toBe("dw");
    expect(id(resolveAsset("samsung fridge", [{ id: "f", name: "RF28", brand: "Samsung", category: "fridge" }]))).toBe("f");
    expect(id(resolveAsset("kitchen dishwasher", [{ id: "dw", name: "SHX878", category: "dishwasher", location: "kitchen" }]))).toBe("dw");
  });
  it("is ruled out by one different word", () => {
    expect(resolveAsset("upstairs bathroom fan", as("Downstairs bathroom fan")).status).toBe("none");
  });
  it("is ruled out by a different number", () => {
    expect(resolveAsset("bedroom 2 tv", as("Bedroom 1 TV", "Living room TV")).status).toBe("none");
    expect(id(resolveAsset("bedroom 1 tv", as("Bedroom 1 TV", "Living room TV")))).toBe("a0");
  });
  it("asks which lamp when both end in lamp, and finds each by full name", () => {
    const lamps = as("Work lamp", "Desk lamp");
    expect(resolveAsset("lamp", lamps).status).toBe("ambiguous");
    expect(id(resolveAsset("work lamp", lamps))).toBe("a0");
    expect(resolveAsset("work lamp", as("Desk lamp")).status).toBe("none");
  });
  it("finds an asset whose whole name is a stopword-like word", () => {
    expect(id(resolveAsset("work", as("Work")))).toBe("a0");
  });
  it("finds a projector called Show projector", () => {
    expect(resolveAsset("projector", as("Show projector", "Home projector")).status).toBe("ambiguous");
    expect(id(resolveAsset("show projector", as("Show projector", "Home projector")))).toBe("a0");
  });
  it("gives the same candidates whatever the input order", () => {
    const lamps = ["1", "2", "3", "4", "5"].map((n): AssetLike => ({ id: `l${n}`, name: `Lamp ${n}` }));
    const fwd = resolveAsset("lamp", lamps);
    const rev = resolveAsset("lamp", [...lamps].reverse());
    expect(fwd).toEqual(rev);
    expect(ids(fwd).length).toBe(3);
  });
  it("finds a hyphenated name from a spoken phrase and the other way round", () => {
    expect(id(resolveAsset("tv room speaker", as("TV-room speaker", "Bedroom speaker")))).toBe("a0");
    expect(id(resolveAsset("tv-room speaker", as("TV room speaker", "Bedroom speaker")))).toBe("a0");
  });
  it("keeps model names like CR-V and F-150 joined", () => {
    expect(id(resolveAsset("f150", [{ id: "t", name: "Truck", aliases: ["F-150"] }]))).toBe("t");
    expect(id(resolveAsset("f-150", [{ id: "t", name: "Truck", aliases: ["F150"] }]))).toBe("t");
  });
  it("matches accents both ways", () => {
    expect(id(resolveAsset("cafe machine", as("Café machine")))).toBe("a0");
    expect(id(resolveAsset("café machine", as("Cafe machine")))).toBe("a0");
  });
  it("matches an accent in the middle of a word, which must not split it in two", () => {
    expect(id(resolveAsset("creme brulee torch", as("Crème brûlée torch")))).toBe("a0");
    expect(tokens("naïve")).toEqual(["naive"]);
  });
});

const agreements: AgreementLike[] = [
  { id: "w1", kind: "warranty", party: "Northwind Appliances", title: "Dishwasher warranty", assetIds: ["dw"] },
  { id: "i1", kind: "insurance", party: "Harbor Mutual Insurance", title: "Auto policy", assetIds: ["car"] },
  { id: "l1", kind: "lease", party: "Maple Court Apartments", title: "Residential lease" },
  { id: "s1", kind: "subscription", party: "Fernwood Streaming" },
  { id: "s2", kind: "subscription", party: "Kestrel Learning" },
];
const aid = (r: ReturnType<typeof resolveAgreement>) => (r.status === "match" ? r.item.id : r.status);

describe("resolveAgreement", () => {
  it("finds a lease from just the word", () => {
    expect(aid(resolveAgreement("my lease", agreements, home))).toBe("l1");
  });
  it("finds a lease from a synonym", () => {
    expect(aid(resolveAgreement("rental agreement", agreements, home))).toBe("l1");
    expect(aid(resolveAgreement("what does my landlord say", agreements, home))).toBe("l1");
  });
  it("finds car insurance through the linked car", () => {
    expect(aid(resolveAgreement("car insurance", agreements, home))).toBe("i1");
    expect(aid(resolveAgreement("auto insurance", agreements, home))).toBe("i1");
  });
  it("finds a policy by insurer name", () => {
    expect(aid(resolveAgreement("harbor mutual", agreements, home))).toBe("i1");
  });
  it("finds a warranty through the linked asset", () => {
    expect(aid(resolveAgreement("dishwasher warranty", agreements, home))).toBe("w1");
    expect(aid(resolveAgreement("dish washer warranty", agreements, home))).toBe("w1");
  });
  it("finds a warranty by provider", () => {
    expect(aid(resolveAgreement("the Northwind warranty", agreements, home))).toBe("w1");
  });
  it("finds a subscription by vendor", () => {
    expect(aid(resolveAgreement("my fernwood subscription", agreements, home))).toBe("s1");
    expect(aid(resolveAgreement("kestrel trial", agreements, home))).toBe("s2");
  });
  it("is ambiguous for a bare kind word when several exist", () => {
    const r = resolveAgreement("my subscriptions", agreements, home);
    expect(r.status).toBe("ambiguous");
    expect(r.status === "ambiguous" && r.candidates.map((c) => c.id).sort()).toEqual(["s1", "s2"]);
  });
  it("returns none for a kind the household has none of", () => {
    expect(resolveAgreement("service plan", agreements, home).status).toBe("none");
  });
  it("does not hand back the car policy for a boat", () => {
    expect(resolveAgreement("boat insurance", agreements, home).status).toBe("none");
  });
  it("does not cross kinds: a dishwasher lease is not the dishwasher warranty", () => {
    expect(resolveAgreement("dishwasher lease", agreements, home).status).toBe("none");
  });
  it("finds an agreement with no kind word, by what it covers", () => {
    expect(aid(resolveAgreement("northwind", agreements, home))).toBe("w1");
  });
  it("returns none for an empty query or no agreements", () => {
    expect(resolveAgreement("", agreements, home).status).toBe("none");
    expect(resolveAgreement("my lease", [], home).status).toBe("none");
  });
  it("works without an asset list", () => {
    expect(aid(resolveAgreement("harbor mutual insurance", agreements))).toBe("i1");
  });
});

describe("the seeded fixture household", () => {
  const dir = fileURLToPath(new URL("../../../fixtures/expected/", import.meta.url));
  const seeded = JSON.parse(readFileSync(`${dir}assets.json`, "utf8")) as AssetLike[];
  it.each([
    ["my dishwasher is leaking", "A-dishwasher"],
    ["the honda", "A-car"],
    ["my car", "A-car"],
    ["baby bottles", "A-baby-bottles"],
    ["boon bottles", "A-baby-bottles"],
  ])("%s resolves to %s", (query, want) => {
    expect(id(resolveAsset(query, seeded))).toBe(want);
  });
});
