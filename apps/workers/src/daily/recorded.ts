import { readFileSync } from "node:fs";
import type { FetchLike } from "obligation-kit/src/recalls/clients";

// Recorded CPSC and NHTSA answers from fixtures/recalls, served by URL, so the demo and the tests never touch the network.
const FIXTURES = new URL("../../../../fixtures/", import.meta.url);
const read = (path: string): unknown => JSON.parse(readFileSync(new URL(path, FIXTURES), "utf8"));

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

export function recordedFetch(): FetchLike {
  return async (url) => {
    const u = new URL(url);
    if (u.hostname === "www.saferproducts.gov") {
      // The second record is the title mismatch control (26569): it must not match any demo asset.
      return ok([
        ...(read("recalls/cpsc/recall_26530_boon_nursh_bottles.json") as unknown[]),
        ...(read("recalls/cpsc/recall_26569_title_mismatch_record.json") as unknown[]),
      ]);
    }
    if (u.pathname === "/products/vehicle/models") return ok(read("recalls/nhtsa/models_HONDA_2021_issueType-r.json"));
    if (u.pathname === "/recalls/recallsByVehicle") {
      const file =
        u.searchParams.get("model") === "CR-V"
          ? "recallsByVehicle_HONDA_CR-V_2021.json"
          : "recallsByVehicle_HONDA_CRV_2021_zero_results.json";
      return ok(read(`recalls/nhtsa/${file}`));
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}
