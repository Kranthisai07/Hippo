import { describe, expect, it } from "vitest";
import type { AuthStore, CodeRecord, RefreshRecord, SessionRecord } from "../src/store";

// One contract suite for every AuthStore: the memory store and the D1 store (apps/edge). Each test builds a fresh store.
// `yieldy` stores are run by a test database that lets statements of different requests interleave, which is the worst
// case for D1, so the concurrency tests below mean something there.

const FAR = 9e15;
const code = (over: Partial<CodeRecord> = {}): CodeRecord => ({
  clientId: "c",
  redirectUri: "https://x.example/cb",
  codeChallenge: "ch",
  resource: "r",
  scope: "mcp:tools",
  sub: "u1",
  householdId: "h1",
  familyId: "f1",
  expiresAt: FAR,
  ...over,
});
const refresh = (over: Partial<RefreshRecord> = {}): RefreshRecord => ({
  clientId: "c",
  resource: "r",
  scope: "mcp:tools",
  sub: "u1",
  householdId: "h1",
  familyId: "f1",
  expiresAt: FAR,
  ...over,
});
const session = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  email: "a@x.example",
  sub: "u1",
  householdId: "h1",
  expiresAt: FAR,
  ...over,
});

export function runAuthStoreSuite(name: string, make: () => AuthStore): void {
  describe(`AuthStore: ${name}`, () => {
    describe("authorization codes", () => {
      it("are consumed once, then reported used with their record, and unknown when never stored", async () => {
        const s = make();
        await s.putCode("k", code());
        const first = await s.consumeCode("k");
        expect(first).toMatchObject({ status: "ok", record: { sub: "u1", familyId: "f1" } });
        expect(await s.consumeCode("k")).toMatchObject({ status: "used", record: { sub: "u1" } });
        expect(await s.consumeCode("missing")).toEqual({ status: "unknown" });
      });
      it("20 parallel consumers: exactly one wins", async () => {
        const s = make();
        await s.putCode("k", code());
        const all = await Promise.all(Array.from({ length: 20 }, () => s.consumeCode("k")));
        expect(all.filter((r) => r.status === "ok")).toHaveLength(1);
        expect(all.filter((r) => r.status === "used")).toHaveLength(19);
      });
    });

    describe("refresh tokens", () => {
      it("are consumed once, then reported used with their record", async () => {
        const s = make();
        await s.putRefresh("k", refresh());
        expect((await s.consumeRefresh("k")).status).toBe("ok");
        expect(await s.consumeRefresh("k")).toMatchObject({ status: "used", record: { familyId: "f1" } });
        expect(await s.consumeRefresh("missing")).toEqual({ status: "unknown" });
      });
      it("putting the same key again replaces the record and makes it usable again", async () => {
        const s = make();
        await s.putRefresh("k", refresh());
        await s.consumeRefresh("k");
        await s.putRefresh("k", refresh({ scope: "mcp:resources" }));
        expect(await s.consumeRefresh("k")).toMatchObject({ status: "ok", record: { scope: "mcp:resources" } });
      });
      it("20 parallel consumers: exactly one wins", async () => {
        const s = make();
        await s.putRefresh("k", refresh());
        const all = await Promise.all(Array.from({ length: 20 }, () => s.consumeRefresh("k")));
        expect(all.filter((r) => r.status === "ok")).toHaveLength(1);
      });
    });

    describe("revoking a family", () => {
      it("uses up every record of the family, codes and refresh tokens, and no other family", async () => {
        const s = make();
        await s.putCode("c1", code());
        await s.putRefresh("r1", refresh());
        await s.putRefresh("r2", refresh());
        await s.putRefresh("other", refresh({ familyId: "f2" }));
        await s.revokeFamily("f1");
        expect((await s.consumeCode("c1")).status).toBe("used");
        expect((await s.consumeRefresh("r1")).status).toBe("used");
        expect((await s.consumeRefresh("r2")).status).toBe("used");
        expect((await s.consumeRefresh("other")).status).toBe("ok");
      });
      it("keeps the family dead: a record put into it afterwards is born used", async () => {
        const s = make();
        await s.revokeFamily("f1");
        await s.putRefresh("late", refresh());
        await s.putCode("latecode", code());
        expect(await s.consumeRefresh("late")).toMatchObject({ status: "used", record: { familyId: "f1" } });
        expect((await s.consumeCode("latecode")).status).toBe("used");
      });
      it("revoking twice, or a family that never existed, is harmless", async () => {
        const s = make();
        await s.revokeFamily("nope");
        await s.revokeFamily("nope");
        await s.putRefresh("r", refresh({ familyId: "f9" }));
        expect((await s.consumeRefresh("r")).status).toBe("ok");
      });
      it("a rotation that straddles a revoke never leaves a live token (put and revoke in either order)", async () => {
        for (let i = 0; i < 60; i++) {
          const s = make();
          const family = `fam-${i}`;
          await s.putRefresh("old", refresh({ familyId: family }));
          // The rotation: consume the old token, then store the new one. A revoke lands somewhere in between.
          const rotate = (async () => {
            const got = await s.consumeRefresh("old");
            if (got.status === "ok") await s.putRefresh("new", refresh({ familyId: family }));
          })();
          const revoke = (async () => {
            for (let y = 0; y < i % 4; y++) await Promise.resolve();
            await s.revokeFamily(family);
          })();
          await Promise.all([rotate, revoke]);
          expect((await s.consumeRefresh("new")).status).not.toBe("ok");
        }
      });
    });

    describe("revoking a user", () => {
      it("ends that user's sessions and refresh families and no one else's", async () => {
        const s = make();
        await s.putSession("s1", session());
        await s.putSession("s2", session({ sub: "u2" }));
        await s.putRefresh("r1", refresh());
        await s.putCode("c1", code());
        await s.putRefresh("r2", refresh({ sub: "u2", familyId: "f2" }));
        await s.revokeUser("u1");
        expect(await s.getSession("s1")).toBeUndefined();
        expect(await s.getSession("s2")).toBeDefined();
        expect((await s.consumeRefresh("r1")).status).toBe("used");
        expect((await s.consumeCode("c1")).status).toBe("used");
        expect((await s.consumeRefresh("r2")).status).toBe("ok");
      });
      it("a rotation that straddles it never leaves a live token", async () => {
        for (let i = 0; i < 40; i++) {
          const s = make();
          await s.putRefresh("old", refresh({ familyId: `fam-${i}` }));
          const rotate = (async () => {
            const got = await s.consumeRefresh("old");
            if (got.status === "ok") await s.putRefresh("new", refresh({ familyId: `fam-${i}` }));
          })();
          const revoke = (async () => {
            for (let y = 0; y < i % 4; y++) await Promise.resolve();
            await s.revokeUser("u1");
          })();
          await Promise.all([rotate, revoke]);
          expect((await s.consumeRefresh("new")).status).not.toBe("ok");
        }
      });
    });

    describe("sessions and magic codes", () => {
      it("sessions are stored, read, replaced and deleted by key", async () => {
        const s = make();
        expect(await s.getSession("s")).toBeUndefined();
        await s.putSession("s", session());
        expect(await s.getSession("s")).toEqual(session());
        await s.putSession("s", session({ email: "b@x.example" }));
        expect((await s.getSession("s"))?.email).toBe("b@x.example");
        await s.deleteSession("s");
        expect(await s.getSession("s")).toBeUndefined();
        await s.deleteSession("s");
      });
      it("magic records are stored, read, replaced and deleted by key", async () => {
        const s = make();
        expect(await s.getMagic("e")).toBeUndefined();
        await s.putMagic("e", { codeHash: "h", expiresAt: 5, attempts: 0 });
        expect(await s.getMagic("e")).toEqual({ codeHash: "h", expiresAt: 5, attempts: 0 });
        await s.putMagic("e", { codeHash: "h2", expiresAt: 6, attempts: 3 });
        expect(await s.getMagic("e")).toEqual({ codeHash: "h2", expiresAt: 6, attempts: 3 });
        await s.deleteMagic("e");
        expect(await s.getMagic("e")).toBeUndefined();
      });
    });

    describe("rate counters (tryHit)", () => {
      const T0 = 1_000_000;
      it("allows max hits in the window, then refuses with the exact wait, and the refusal records nothing", async () => {
        const s = make();
        for (let i = 0; i < 3; i++) expect(await s.tryHit("k", 60_000, 3, 0, T0 + i * 1000)).toEqual({ ok: true });
        expect(await s.tryHit("k", 60_000, 3, 0, T0 + 3000)).toEqual({ ok: false, retryAfterMs: 57_000 });
        expect(await s.tryHit("k", 60_000, 3, 0, T0 + 3000)).toEqual({ ok: false, retryAfterMs: 57_000 });
        // The first hit leaves the window at T0 + 60,000, so one slot opens then and the refusals took none.
        expect(await s.tryHit("k", 60_000, 3, 0, T0 + 60_001)).toEqual({ ok: true });
        expect((await s.tryHit("k", 60_000, 3, 0, T0 + 60_002)).ok).toBe(false);
      });
      it("keeps a minimum gap between hits", async () => {
        const s = make();
        expect(await s.tryHit("g", 3_600_000, 5, 60_000, T0)).toEqual({ ok: true });
        expect(await s.tryHit("g", 3_600_000, 5, 60_000, T0 + 10_000)).toEqual({ ok: false, retryAfterMs: 50_000 });
        expect(await s.tryHit("g", 3_600_000, 5, 60_000, T0 + 60_000)).toEqual({ ok: true });
      });
      it("without a minimum gap, a caller whose clock is a little behind another's is still admitted while there is room", async () => {
        // Callers on different machines read slightly different clocks, and their requests reach the store in any order.
        const s = make();
        expect(await s.tryHit("skew", 60_000, 5, 0, T0 + 900)).toEqual({ ok: true });
        expect(await s.tryHit("skew", 60_000, 5, 0, T0 + 100)).toEqual({ ok: true });
        expect(await s.tryHit("skew", 60_000, 5, 0, T0 + 500)).toEqual({ ok: true });
        expect(await s.tryHit("skew", 60_000, 5, 0, T0)).toEqual({ ok: true });
        expect(await s.tryHit("skew", 60_000, 5, 0, T0 + 300)).toEqual({ ok: true });
        expect((await s.tryHit("skew", 60_000, 5, 0, T0 + 200)).ok).toBe(false);
      });
      it("counts each key on its own, and clearCounter forgets one key only", async () => {
        const s = make();
        await s.tryHit("a", 60_000, 1, 0, T0);
        expect((await s.tryHit("a", 60_000, 1, 0, T0 + 1)).ok).toBe(false);
        expect((await s.tryHit("b", 60_000, 1, 0, T0 + 1)).ok).toBe(true);
        await s.clearCounter("a");
        expect((await s.tryHit("a", 60_000, 1, 0, T0 + 2)).ok).toBe(true);
        expect((await s.tryHit("b", 60_000, 1, 0, T0 + 3)).ok).toBe(false);
      });
      it("30 parallel hits against a limit of 5: exactly 5 pass", async () => {
        const s = make();
        const all = await Promise.all(Array.from({ length: 30 }, (_, i) => s.tryHit("p", 60_000, 5, 0, T0 + i)));
        expect(all.filter((r) => r.ok)).toHaveLength(5);
      });
      it("keys with quotes and SQL in them are plain text", async () => {
        const s = make();
        const evil = "x'; DROP TABLE auth_hits; --";
        expect(await s.tryHit(evil, 60_000, 1, 0, T0)).toEqual({ ok: true });
        expect((await s.tryHit(evil, 60_000, 1, 0, T0 + 1)).ok).toBe(false);
        expect((await s.tryHit("safe", 60_000, 1, 0, T0)).ok).toBe(true);
      });
    });
  });
}
