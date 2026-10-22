import { describe, expect, it } from "vitest";
import { createMemoryRepository } from "core/src/repository";
import { DEMO_EMAIL, DEMO_HOUSEHOLD, seedDemoHousehold } from "../src/daily/demo";

describe("seedDemoHousehold digest address", () => {
  it("uses the placeholder address by default", async () => {
    const repo = createMemoryRepository();
    await seedDemoHousehold(repo, "2026-10-21");
    expect((await repo.getHousehold(DEMO_HOUSEHOLD))?.email).toBe(DEMO_EMAIL);
  });

  it("uses the address it is given, so a live send can reach a verified inbox", async () => {
    const repo = createMemoryRepository();
    await seedDemoHousehold(repo, "2026-10-21", DEMO_HOUSEHOLD, "me@example.org");
    expect((await repo.getHousehold(DEMO_HOUSEHOLD))?.email).toBe("me@example.org");
  });
});
