import { describe, expect, it } from "vitest";
import * as kit from "../src";
import * as recalls from "../src/recalls";

describe("package barrel", () => {
  it("keeps the outbound HTTP clients out, so the voice path cannot import them by accident", () => {
    for (const name of ["fetchCpscRecalls", "fetchNhtsaRecalls", "createNhtsaClient"]) {
      expect(name in recalls, `${name} should exist in recalls/clients`).toBe(true);
      expect(name in kit, `${name} must not be exported from the barrel`).toBe(false);
    }
  });
  it("still exports the pure parsers and matchers", () => {
    for (const name of ["parseCpscResponse", "matchCpscRecall", "parseNhtsaResponse", "matchNhtsaRecall", "canonicalizeVehicle"]) {
      expect(name in kit, name).toBe(true);
    }
  });
});
