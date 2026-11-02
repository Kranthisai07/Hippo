import { createMemoryRepository } from "core/src/repository";
import { describe, expect, it } from "vitest";
import { ensureHousehold } from "../src/household";

const now = () => Date.UTC(2026, 10, 2, 12, 0, 0);

describe("ensureHousehold", () => {
  it("creates the record with the sign in address and the daily email on", async () => {
    const repo = createMemoryRepository();
    await ensureHousehold(repo, { householdId: "hh_a", email: "a@example.com" }, now);
    expect(await repo.getHousehold("hh_a")).toEqual({
      id: "hh_a",
      email: "a@example.com",
      digestOn: true,
      createdAt: "2026-11-02T12:00:00.000Z",
    });
  });

  it("brings only the address of a record that is already there in line with the sign in address, and leaves the setting", async () => {
    const repo = createMemoryRepository();
    await repo.putHousehold("hh_a", {
      id: "hh_a",
      email: "home@example.com",
      digestOn: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await ensureHousehold(repo, { householdId: "hh_a", email: "a@example.com" }, now);
    expect(await repo.getHousehold("hh_a")).toMatchObject({
      email: "a@example.com",
      digestOn: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("keeps households apart", async () => {
    const repo = createMemoryRepository();
    await ensureHousehold(repo, { householdId: "hh_a", email: "a@example.com" }, now);
    expect(await repo.getHousehold("hh_b")).toBeNull();
  });
});
