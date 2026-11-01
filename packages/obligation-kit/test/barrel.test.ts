import { describe, expect, it } from "vitest";
import * as kit from "../src";
import * as clients from "../src/recalls/clients";
import * as recallsBarrel from "../src/recalls";

describe("package barrel", () => {
  it("keeps the outbound HTTP clients out, so the voice path cannot import them by accident", () => {
    for (const name of ["fetchCpscRecalls", "fetchNhtsaRecalls", "createNhtsaClient"]) {
      expect(name in clients, `${name} should exist in recalls/clients`).toBe(true);
      expect(name in kit, `${name} must not be exported from the package barrel`).toBe(false);
      expect(name in recallsBarrel, `${name} must not be exported from the recalls barrel`).toBe(false);
    }
  });
  it("still exports the pure parsers and matchers", () => {
    for (const name of [
      "parseCpscResponse",
      "matchCpscRecall",
      "parseNhtsaResponse",
      "matchNhtsaRecall",
      "canonicalizeVehicle",
    ]) {
      expect(name in kit, name).toBe(true);
    }
  });
});
