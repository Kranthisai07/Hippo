import { beforeEach, describe, expect, it } from "vitest";
import type {
  Agreement,
  Alert,
  Asset,
  ChunkMeta,
  Doc,
  DocStatus,
  ObligationRecord,
  Repository,
  ServiceEvent,
  Suppression,
  UndoRecord,
} from "../src";
import { pageTextKey } from "../src/repository/shared";

// One contract suite for every Repository implementation. Each test uses fresh household ids, so a shared table is fine.

let counter = 0;
const fresh = (label: string): string => `${label}-${Date.now().toString(36)}-${counter++}`;

const asset = (id: string, over: Partial<Asset> = {}): Asset => ({
  id,
  name: `Thing ${id}`,
  category: "appliance",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});
const doc = (id: string, over: Partial<Doc> = {}): Doc => ({
  id,
  s3Key: `uploads/h/${id}/file.pdf`,
  filename: `${id}.pdf`,
  docType: "warranty",
  status: "active",
  pages: 3,
  uploadedAt: "2026-02-01T00:00:00.000Z",
  assetIds: [],
  ...over,
});
const agreement = (id: string, over: Partial<Agreement> = {}): Agreement => ({
  id,
  kind: "warranty",
  party: "Northwind",
  assetIds: [],
  fields: { endDate: "2027-01-01" },
  fieldStatus: { endDate: "confirmed" },
  sourceRefs: {},
  createdAt: "2026-03-01T00:00:00.000Z",
  ...over,
});
const obligation = (id: string, dueDate: string, over: Partial<ObligationRecord> = {}): ObligationRecord => ({
  id,
  type: "expires",
  dueDate,
  label: `Thing ${id}`,
  confirmed: true,
  severity: "high",
  ...over,
});
const event = (id: string, assetId: string, ts: string, over: Partial<ServiceEvent> = {}): ServiceEvent => ({
  id,
  assetId,
  ts,
  action: "serviced",
  source: "voice",
  ...over,
});
const alert = (id: string, over: Partial<Alert> = {}): Alert => ({
  id,
  source: "deadline",
  severity: "high",
  status: "pending",
  label: `Alert ${id}`,
  dueDate: "2026-11-01",
  refId: `ob-${id}`,
  ...over,
});
const suppression = (recallId: string, assetId: string, over: Partial<Suppression> = {}): Suppression => ({
  source: "cpsc",
  recallId,
  assetId,
  createdAt: "2026-04-01T00:00:00.000Z",
  ...over,
});
const chunk = (docId: string, over: Partial<ChunkMeta> = {}): ChunkMeta => ({
  docId,
  s3Key: `chunks/h/${docId}.json`,
  indexVersion: 1,
  chunkCount: 12,
  ...over,
});
const undo = (ts: string, expiresAt: number, over: Partial<UndoRecord> = {}): UndoRecord => ({
  ts,
  summary: `undo ${ts}`,
  inverse: { type: "delete_asset", assetId: `a-${ts}` },
  expiresAt,
  ...over,
});

const HOSTILE_IDS = [
  "x#y",
  "HH#other",
  "ASSET#victim",
  "#",
  "a##b",
  "%23",
  "a%b",
  "with space",
  "line\nbreak",
  "ünï-çødé",
  "../../etc",
  "DOC#1#2",
];

export function runRepositorySuite(name: string, create: () => Repository | Promise<Repository>): void {
  describe(`Repository contract: ${name}`, () => {
    let repo: Repository;
    let hh: string;
    beforeEach(async () => {
      repo = await create();
      hh = fresh("hh");
    });

    describe("household", () => {
      it("returns null before anything is stored", async () => {
        expect(await repo.getHousehold(hh)).toBeNull();
      });
      it("stores and returns the household settings", async () => {
        const h = { id: hh, email: "a@example.com", digestOn: true, createdAt: "2026-01-01T00:00:00.000Z" };
        await repo.putHousehold(hh, h);
        expect(await repo.getHousehold(hh)).toEqual(h);
      });
      it("replaces on a second put", async () => {
        await repo.putHousehold(hh, { id: hh, email: "a@example.com", digestOn: true, createdAt: "t" });
        await repo.putHousehold(hh, { id: hh, digestOn: false, createdAt: "t" });
        const got = await repo.getHousehold(hh);
        expect(got?.digestOn).toBe(false);
        expect(got?.email).toBeUndefined();
      });
      it("rejects an empty household id", async () => {
        await expect(repo.listAssets("")).rejects.toThrow();
      });
    });

    describe("assets", () => {
      it("returns null for a missing id", async () => {
        expect(await repo.getAsset(hh, "nope")).toBeNull();
      });
      it("puts and gets with every field intact", async () => {
        const a = asset("a1", {
          aliases: ["fridge"],
          brand: "Northwind",
          location: "kitchen",
          modelNumber: "NW-1",
          serialLast4: "1234",
          upc: null,
          purchaseDate: "2025-05-05",
          vehicle: { make: "Honda", model: "Civic", modelYear: 2020, nhtsaMake: "HONDA", nhtsaModel: "CIVIC" },
        });
        await repo.putAsset(hh, a);
        expect(await repo.getAsset(hh, "a1")).toEqual(a);
      });
      it("replaces by id", async () => {
        await repo.putAsset(hh, asset("a1", { name: "Old", brand: "X" }));
        await repo.putAsset(hh, asset("a1", { name: "New" }));
        const got = await repo.getAsset(hh, "a1");
        expect(got?.name).toBe("New");
        expect(got?.brand).toBeUndefined();
        expect(await repo.listAssets(hh)).toHaveLength(1);
      });
      it("deletes by id and leaves the others", async () => {
        await repo.putAsset(hh, asset("a1"));
        await repo.putAsset(hh, asset("a2"));
        await repo.deleteAsset(hh, "a1");
        expect(await repo.getAsset(hh, "a1")).toBeNull();
        expect(await repo.getAsset(hh, "a2")).not.toBeNull();
      });
      it("deleting a missing id does not throw", async () => {
        await expect(repo.deleteAsset(hh, "ghost")).resolves.toBeUndefined();
      });
      it("lists nothing for an empty household", async () => {
        expect(await repo.listAssets(hh)).toEqual([]);
      });
      it.each([
        {
          label: "by name",
          given: [
            ["b", "Zed"],
            ["a", "Alpha"],
            ["c", "Mid"],
          ],
          want: ["a", "c", "b"],
        },
        {
          label: "then by id on a name tie",
          given: [
            ["z", "Same"],
            ["a", "Same"],
            ["m", "Same"],
          ],
          want: ["a", "m", "z"],
        },
        {
          label: "uppercase before lowercase (code point order)",
          given: [
            ["1", "b"],
            ["2", "B"],
          ],
          want: ["2", "1"],
        },
        { label: "a single asset", given: [["only", "One"]], want: ["only"] },
      ])("lists ordered $label", async ({ given, want }) => {
        for (const [id, name] of given as [string, string][]) await repo.putAsset(hh, asset(id, { name }));
        expect((await repo.listAssets(hh)).map((a) => a.id)).toEqual(want);
      });
    });

    describe("documents", () => {
      it("returns null for a missing id", async () => {
        expect(await repo.getDoc(hh, "nope")).toBeNull();
      });
      it("puts and gets", async () => {
        const d = doc("d1", { assetIds: ["a1"], failureReason: undefined });
        await repo.putDoc(hh, d);
        expect(await repo.getDoc(hh, "d1")).toEqual(d);
      });
      it("replaces by id", async () => {
        await repo.putDoc(hh, doc("d1", { status: "uploaded" }));
        await repo.putDoc(hh, doc("d1", { status: "active" }));
        expect((await repo.getDoc(hh, "d1"))?.status).toBe("active");
        expect(await repo.listDocs(hh)).toHaveLength(1);
      });
      it("lists newest upload first, then id", async () => {
        await repo.putDoc(hh, doc("b", { uploadedAt: "2026-01-01T00:00:00.000Z" }));
        await repo.putDoc(hh, doc("d", { uploadedAt: "2026-03-01T00:00:00.000Z" }));
        await repo.putDoc(hh, doc("c", { uploadedAt: "2026-03-01T00:00:00.000Z" }));
        await repo.putDoc(hh, doc("a", { uploadedAt: "2026-02-01T00:00:00.000Z" }));
        expect((await repo.listDocs(hh)).map((d) => d.id)).toEqual(["c", "d", "a", "b"]);
      });
      const statuses: DocStatus[] = ["uploaded", "extracting", "needs_review", "active", "failed"];
      it.each(statuses)("filters by status %s", async (status) => {
        for (const [i, s] of statuses.entries()) await repo.putDoc(hh, doc(`d${i}`, { status: s }));
        const got = await repo.listDocs(hh, { status });
        expect(got).toHaveLength(1);
        expect(got[0]?.status).toBe(status);
      });
      it("an empty filter returns everything", async () => {
        await repo.putDoc(hh, doc("d1"));
        expect(await repo.listDocs(hh, {})).toHaveLength(1);
      });
      it("a status filter with no match returns an empty list", async () => {
        await repo.putDoc(hh, doc("d1", { status: "active" }));
        expect(await repo.listDocs(hh, { status: "failed" })).toEqual([]);
      });
    });

    describe("agreements", () => {
      it("returns null for a missing id", async () => {
        expect(await repo.getAgreement(hh, "nope")).toBeNull();
      });
      it("puts and gets nested fields intact", async () => {
        const a = agreement("g1", {
          docId: "d1",
          assetIds: ["a1", "a2"],
          fields: { endDate: "2027-01-01", terms: { months: 12, list: [1, 2, { x: null }] } },
          fieldStatus: { endDate: "edited", terms: "extracted" },
        });
        await repo.putAgreement(hh, a);
        expect(await repo.getAgreement(hh, "g1")).toEqual(a);
      });
      it("replaces by id", async () => {
        await repo.putAgreement(hh, agreement("g1", { party: "Old" }));
        await repo.putAgreement(hh, agreement("g1", { party: "New" }));
        expect((await repo.getAgreement(hh, "g1"))?.party).toBe("New");
        expect(await repo.listAgreements(hh)).toHaveLength(1);
      });
      it("deletes by id", async () => {
        await repo.putAgreement(hh, agreement("g1"));
        await repo.putAgreement(hh, agreement("g2"));
        await repo.deleteAgreement(hh, "g1");
        expect(await repo.getAgreement(hh, "g1")).toBeNull();
        expect(await repo.getAgreement(hh, "g2")).not.toBeNull();
      });
      it("deleting a missing id does not throw", async () => {
        await expect(repo.deleteAgreement(hh, "ghost")).resolves.toBeUndefined();
      });
      it("lists by creation time, then id", async () => {
        await repo.putAgreement(hh, agreement("b", { createdAt: "2026-01-02T00:00:00.000Z" }));
        await repo.putAgreement(hh, agreement("z", { createdAt: "2026-01-01T00:00:00.000Z" }));
        await repo.putAgreement(hh, agreement("a", { createdAt: "2026-01-02T00:00:00.000Z" }));
        expect((await repo.listAgreements(hh)).map((a) => a.id)).toEqual(["z", "a", "b"]);
      });
      it("filters by docId", async () => {
        await repo.putAgreement(hh, agreement("g1", { docId: "d1" }));
        await repo.putAgreement(hh, agreement("g2", { docId: "d2" }));
        await repo.putAgreement(hh, agreement("g3"));
        expect((await repo.listAgreements(hh, { docId: "d1" })).map((a) => a.id)).toEqual(["g1"]);
      });
      it("filters by assetId when the agreement lists it among several", async () => {
        await repo.putAgreement(hh, agreement("g1", { assetIds: ["a1", "a2"] }));
        await repo.putAgreement(hh, agreement("g2", { assetIds: ["a3"] }));
        await repo.putAgreement(hh, agreement("g3", { assetIds: [] }));
        expect((await repo.listAgreements(hh, { assetId: "a2" })).map((a) => a.id)).toEqual(["g1"]);
      });
      it("combines both filters", async () => {
        await repo.putAgreement(hh, agreement("g1", { docId: "d1", assetIds: ["a1"] }));
        await repo.putAgreement(hh, agreement("g2", { docId: "d1", assetIds: ["a2"] }));
        expect((await repo.listAgreements(hh, { docId: "d1", assetId: "a2" })).map((a) => a.id)).toEqual(["g2"]);
      });
      it("a filter that matches nothing returns an empty list", async () => {
        await repo.putAgreement(hh, agreement("g1"));
        expect(await repo.listAgreements(hh, { docId: "none" })).toEqual([]);
      });
    });

    describe("obligations", () => {
      const ids = async (from: string, to: string) => (await repo.listObligations(hh, { from, to })).map((o) => o.id);

      it("lists nothing when empty", async () => {
        expect(await ids("2000-01-01", "2999-12-31")).toEqual([]);
      });
      it("stores every field", async () => {
        const o = obligation("o1", "2026-12-01", {
          agreementId: "g1",
          assetId: "a1",
          severity: null,
          confirmed: false,
        });
        await repo.replaceObligations(hh, "g1", [o]);
        expect(await repo.listObligations(hh, { from: "2026-12-01", to: "2026-12-01" })).toEqual([o]);
      });
      it.each([
        { label: "start day is included", from: "2026-06-10", to: "2026-06-12", want: ["on-from"] },
        { label: "end day is included", from: "2026-06-20", to: "2026-06-30", want: ["on-to"] },
        {
          label: "everything between and both ends",
          from: "2026-06-10",
          to: "2026-06-30",
          want: ["on-from", "mid", "on-to"],
        },
        { label: "a single-day range", from: "2026-06-15", to: "2026-06-15", want: ["mid"] },
        { label: "the day before the start is excluded", from: "2026-06-11", to: "2026-06-30", want: ["mid", "on-to"] },
        { label: "the day after the end is excluded", from: "2026-06-01", to: "2026-06-29", want: ["on-from", "mid"] },
        { label: "a range before everything is empty", from: "2026-06-01", to: "2026-06-09", want: [] },
        { label: "an inverted range is empty", from: "2026-07-01", to: "2026-06-01", want: [] },
        { label: "a range across a year end", from: "2025-12-31", to: "2026-06-10", want: ["on-from"] },
      ])("date range: $label", async ({ from, to, want }) => {
        await repo.replaceObligations(hh, "g1", [
          obligation("on-from", "2026-06-10", { agreementId: "g1" }),
          obligation("mid", "2026-06-15", { agreementId: "g1" }),
          obligation("on-to", "2026-06-30", { agreementId: "g1" }),
        ]);
        expect(await ids(from, to)).toEqual(want);
      });
      it("orders by due date, then id", async () => {
        await repo.replaceObligations(hh, "g1", [
          obligation("c", "2026-02-01", { agreementId: "g1" }),
          obligation("b", "2026-01-01", { agreementId: "g1" }),
          obligation("a", "2026-02-01", { agreementId: "g1" }),
          obligation("d", "2026-01-01", { agreementId: "g1" }),
        ]);
        expect(await ids("2026-01-01", "2026-12-31")).toEqual(["b", "d", "a", "c"]);
      });
      it("orders across agreements", async () => {
        await repo.replaceObligations(hh, "g1", [obligation("x", "2026-03-01", { agreementId: "g1" })]);
        await repo.replaceObligations(hh, "g2", [obligation("y", "2026-02-01", { agreementId: "g2" })]);
        expect(await ids("2026-01-01", "2026-12-31")).toEqual(["y", "x"]);
      });
      it("replaces the whole set for that agreement", async () => {
        await repo.replaceObligations(hh, "g1", [
          obligation("o1", "2026-01-01", { agreementId: "g1" }),
          obligation("o2", "2026-02-01", { agreementId: "g1" }),
        ]);
        await repo.replaceObligations(hh, "g1", [obligation("o3", "2026-03-01", { agreementId: "g1" })]);
        expect(await ids("2026-01-01", "2026-12-31")).toEqual(["o3"]);
      });
      it("replacing with an empty list clears that agreement", async () => {
        await repo.replaceObligations(hh, "g1", [obligation("o1", "2026-01-01", { agreementId: "g1" })]);
        await repo.replaceObligations(hh, "g1", []);
        expect(await ids("2026-01-01", "2026-12-31")).toEqual([]);
      });
      it("does not touch another agreement's obligations", async () => {
        await repo.replaceObligations(hh, "g1", [obligation("o1", "2026-01-01", { agreementId: "g1" })]);
        await repo.replaceObligations(hh, "g2", [obligation("o2", "2026-01-02", { agreementId: "g2" })]);
        await repo.replaceObligations(hh, "g2", []);
        expect(await ids("2026-01-01", "2026-12-31")).toEqual(["o1"]);
      });
      it("does not touch obligations that have no agreement", async () => {
        await repo.replaceObligations(hh, null, [obligation("free", "2026-01-05", { assetId: "a1" })]);
        await repo.replaceObligations(hh, "g1", [obligation("o1", "2026-01-01", { agreementId: "g1" })]);
        await repo.replaceObligations(hh, "g1", []);
        expect(await ids("2026-01-01", "2026-12-31")).toEqual(["free"]);
      });
      it("null replaces only the obligations with no agreement", async () => {
        await repo.replaceObligations(hh, null, [obligation("free1", "2026-01-05", { assetId: "a1" })]);
        await repo.replaceObligations(hh, "g1", [obligation("o1", "2026-01-01", { agreementId: "g1" })]);
        await repo.replaceObligations(hh, null, [obligation("free2", "2026-01-06", { assetId: "a1" })]);
        expect(await ids("2026-01-01", "2026-12-31")).toEqual(["o1", "free2"]);
      });
      it("null with an empty list clears the agreement-less ones only", async () => {
        await repo.replaceObligations(hh, null, [obligation("free1", "2026-01-05")]);
        await repo.replaceObligations(hh, "g1", [obligation("o1", "2026-01-01", { agreementId: "g1" })]);
        await repo.replaceObligations(hh, null, []);
        expect(await ids("2026-01-01", "2026-12-31")).toEqual(["o1"]);
      });
      it("keeps two obligations on the same day with different ids", async () => {
        await repo.replaceObligations(hh, "g1", [
          obligation("p", "2026-05-05", { agreementId: "g1", type: "renews" }),
          obligation("q", "2026-05-05", { agreementId: "g1", type: "cancel_by" }),
        ]);
        expect(await ids("2026-05-05", "2026-05-05")).toEqual(["p", "q"]);
      });
      it("handles more than one page of obligations", async () => {
        const many = Array.from({ length: 60 }, (_, i) =>
          obligation(`o${String(i).padStart(3, "0")}`, `2026-01-${String((i % 28) + 1).padStart(2, "0")}`, {
            agreementId: "g1",
          }),
        );
        await repo.replaceObligations(hh, "g1", many);
        const got = await repo.listObligations(hh, { from: "2026-01-01", to: "2026-01-31" });
        expect(got).toHaveLength(60);
        const sorted = [...got].sort((x, y) => (x.dueDate + x.id < y.dueDate + y.id ? -1 : 1));
        expect(got.map((o) => o.id)).toEqual(sorted.map((o) => o.id));
      });
    });

    describe("service events", () => {
      it("lists nothing for an asset with no events", async () => {
        expect(await repo.listEvents(hh, "a1", 10)).toEqual([]);
      });
      it("adds and lists with every field", async () => {
        const e = event("e1", "a1", "2026-01-01T10:00:00.000Z", { note: "new filter", source: "web" });
        await repo.addEvent(hh, e);
        expect(await repo.listEvents(hh, "a1", 10)).toEqual([e]);
      });
      it("lists newest first", async () => {
        await repo.addEvent(hh, event("e1", "a1", "2026-01-01T00:00:00.000Z"));
        await repo.addEvent(hh, event("e3", "a1", "2026-03-01T00:00:00.000Z"));
        await repo.addEvent(hh, event("e2", "a1", "2026-02-01T00:00:00.000Z"));
        expect((await repo.listEvents(hh, "a1", 10)).map((e) => e.id)).toEqual(["e3", "e2", "e1"]);
      });
      it("keeps two events with the same timestamp, ordered by id", async () => {
        await repo.addEvent(hh, event("b", "a1", "2026-01-01T00:00:00.000Z"));
        await repo.addEvent(hh, event("a", "a1", "2026-01-01T00:00:00.000Z"));
        expect((await repo.listEvents(hh, "a1", 10)).map((e) => e.id)).toEqual(["a", "b"]);
      });
      it.each([
        { limit: 1, want: ["e5"] },
        { limit: 2, want: ["e5", "e4"] },
        { limit: 5, want: ["e5", "e4", "e3", "e2", "e1"] },
        { limit: 50, want: ["e5", "e4", "e3", "e2", "e1"] },
        { limit: 0, want: [] },
      ])("limit $limit returns the newest $want.length", async ({ limit, want }) => {
        for (let i = 1; i <= 5; i++) await repo.addEvent(hh, event(`e${i}`, "a1", `2026-01-0${i}T00:00:00.000Z`));
        expect((await repo.listEvents(hh, "a1", limit)).map((e) => e.id)).toEqual(want);
      });
      it("keeps assets apart", async () => {
        await repo.addEvent(hh, event("e1", "a1", "2026-01-01T00:00:00.000Z"));
        await repo.addEvent(hh, event("e2", "a2", "2026-01-02T00:00:00.000Z"));
        expect((await repo.listEvents(hh, "a1", 10)).map((e) => e.id)).toEqual(["e1"]);
      });
      it("deletes one event by id", async () => {
        await repo.addEvent(hh, event("e1", "a1", "2026-01-01T00:00:00.000Z"));
        await repo.addEvent(hh, event("e2", "a1", "2026-01-02T00:00:00.000Z"));
        await repo.deleteEvent(hh, "a1", "e1");
        expect((await repo.listEvents(hh, "a1", 10)).map((e) => e.id)).toEqual(["e2"]);
      });
      it("deleting an event from the wrong asset changes nothing", async () => {
        await repo.addEvent(hh, event("e1", "a1", "2026-01-01T00:00:00.000Z"));
        await repo.deleteEvent(hh, "a2", "e1");
        expect(await repo.listEvents(hh, "a1", 10)).toHaveLength(1);
      });
      it("deleting a missing event does not throw", async () => {
        await expect(repo.deleteEvent(hh, "a1", "ghost")).resolves.toBeUndefined();
      });
      it("an asset id that is a prefix of another does not leak events", async () => {
        await repo.addEvent(hh, event("e1", "a", "2026-01-01T00:00:00.000Z"));
        await repo.addEvent(hh, event("e2", "a#b", "2026-01-02T00:00:00.000Z"));
        await repo.addEvent(hh, event("e3", "ab", "2026-01-03T00:00:00.000Z"));
        expect((await repo.listEvents(hh, "a", 10)).map((e) => e.id)).toEqual(["e1"]);
        expect((await repo.listEvents(hh, "a#b", 10)).map((e) => e.id)).toEqual(["e2"]);
      });
    });

    describe("alerts", () => {
      it("returns null for a missing id", async () => {
        expect(await repo.getAlert(hh, "nope")).toBeNull();
      });
      it("puts and gets with every field", async () => {
        const a = alert("al1", {
          assetId: "a1",
          detail: "details",
          emailedAt: "2026-10-01T00:00:00.000Z",
          announcedAt: null,
          snoozedUntil: "2026-10-09T00:00:00.000Z",
        });
        await repo.putAlert(hh, a);
        expect(await repo.getAlert(hh, "al1")).toEqual(a);
      });
      it("replaces by id", async () => {
        await repo.putAlert(hh, alert("al1", { label: "old" }));
        await repo.putAlert(hh, alert("al1", { label: "new" }));
        expect((await repo.getAlert(hh, "al1"))?.label).toBe("new");
        expect(await repo.listAlerts(hh)).toHaveLength(1);
      });
      it.each([
        { status: "pending", open: true },
        { status: "announced", open: true },
        { status: "done", open: false },
        { status: "dismissed", open: false },
      ] as const)("status $status is open: $open", async ({ status, open }) => {
        await repo.putAlert(hh, alert("al1", { status }));
        expect(await repo.listAlerts(hh, { open: true })).toHaveLength(open ? 1 : 0);
        expect(await repo.listAlerts(hh)).toHaveLength(1);
        expect(await repo.listAlerts(hh, { open: false })).toHaveLength(1);
      });
      it("an open alert leaves the open list once it is done, and stays in the full list", async () => {
        await repo.putAlert(hh, alert("al1", { status: "pending" }));
        await repo.putAlert(hh, alert("al1", { status: "done" }));
        expect(await repo.listAlerts(hh, { open: true })).toEqual([]);
        expect(await repo.listAlerts(hh)).toHaveLength(1);
      });
      it("a done alert comes back to the open list when reopened", async () => {
        await repo.putAlert(hh, alert("al1", { status: "done" }));
        await repo.putAlert(hh, alert("al1", { status: "pending" }));
        expect((await repo.listAlerts(hh, { open: true })).map((a) => a.id)).toEqual(["al1"]);
      });
      it("orders high severity first, then due date, then id", async () => {
        await repo.putAlert(hh, alert("p1", { severity: "possible", dueDate: "2026-01-01" }));
        await repo.putAlert(hh, alert("h2", { severity: "high", dueDate: "2026-02-01" }));
        await repo.putAlert(hh, alert("h1b", { severity: "high", dueDate: "2026-01-01" }));
        await repo.putAlert(hh, alert("h1a", { severity: "high", dueDate: "2026-01-01" }));
        await repo.putAlert(hh, alert("p0", { severity: "possible", dueDate: "2025-12-01" }));
        const want = ["h1a", "h1b", "h2", "p0", "p1"];
        expect((await repo.listAlerts(hh)).map((a) => a.id)).toEqual(want);
        expect((await repo.listAlerts(hh, { open: true })).map((a) => a.id)).toEqual(want);
      });
      it("puts alerts with no due date after dated ones of the same severity", async () => {
        await repo.putAlert(hh, alert("none", { dueDate: null }));
        await repo.putAlert(hh, alert("missing", { dueDate: undefined }));
        await repo.putAlert(hh, alert("dated", { dueDate: "2030-01-01" }));
        expect((await repo.listAlerts(hh, { open: true })).map((a) => a.id)).toEqual(["dated", "missing", "none"]);
      });
      it("open: false lists everything, same as no filter", async () => {
        await repo.putAlert(hh, alert("a", { status: "done" }));
        await repo.putAlert(hh, alert("b", { status: "pending" }));
        expect(await repo.listAlerts(hh, { open: false })).toEqual(await repo.listAlerts(hh));
      });
      it("an empty filter returns everything", async () => {
        await repo.putAlert(hh, alert("a", { status: "done" }));
        expect(await repo.listAlerts(hh, {})).toHaveLength(1);
      });
    });

    describe("suppressions", () => {
      it("lists nothing at first", async () => {
        expect(await repo.listSuppressions(hh)).toEqual([]);
      });
      it("adds and lists", async () => {
        const s = suppression("R1", "a1", { source: "nhtsa" });
        await repo.addSuppression(hh, s);
        expect(await repo.listSuppressions(hh)).toEqual([s]);
      });
      it("is idempotent for the same source, recall and asset", async () => {
        await repo.addSuppression(hh, suppression("R1", "a1"));
        await repo.addSuppression(hh, suppression("R1", "a1"));
        expect(await repo.listSuppressions(hh)).toHaveLength(1);
      });
      it.each([
        ["another asset", suppression("R1", "a2")],
        ["another recall", suppression("R2", "a1")],
        ["another source", suppression("R1", "a1", { source: "nhtsa" })],
      ])("keeps a separate suppression for %s", async (_label, other) => {
        await repo.addSuppression(hh, suppression("R1", "a1"));
        await repo.addSuppression(hh, other);
        expect(await repo.listSuppressions(hh)).toHaveLength(2);
      });
      it("does not merge ids that only differ by where the # falls", async () => {
        await repo.addSuppression(hh, suppression("a#b", "c"));
        await repo.addSuppression(hh, suppression("a", "b#c"));
        expect(await repo.listSuppressions(hh)).toHaveLength(2);
      });
    });

    describe("chunk pointers", () => {
      it("returns null for a missing doc", async () => {
        expect(await repo.getChunkMeta(hh, "nope")).toBeNull();
      });
      it("puts and gets", async () => {
        const m = chunk("d1");
        await repo.putChunkMeta(hh, m);
        expect(await repo.getChunkMeta(hh, "d1")).toEqual(m);
      });
      it("replaces by doc id", async () => {
        await repo.putChunkMeta(hh, chunk("d1", { indexVersion: 1 }));
        await repo.putChunkMeta(hh, chunk("d1", { indexVersion: 2 }));
        expect((await repo.getChunkMeta(hh, "d1"))?.indexVersion).toBe(2);
      });
      it("keeps documents apart", async () => {
        await repo.putChunkMeta(hh, chunk("d1"));
        expect(await repo.getChunkMeta(hh, "d2")).toBeNull();
      });
    });

    describe("undo", () => {
      const NOW = 1_800_000_000;
      it("returns null when nothing was pushed", async () => {
        expect(await repo.popUndo(hh, NOW)).toBeNull();
      });
      it("pops the record it was given", async () => {
        const u = undo("2026-10-18T10:00:00.000Z", NOW + 100);
        await repo.pushUndo(hh, u);
        expect(await repo.popUndo(hh, NOW)).toEqual(u);
      });
      it("pops the newest first and removes each", async () => {
        await repo.pushUndo(hh, undo("2026-10-18T10:00:00.000Z", NOW + 100));
        await repo.pushUndo(hh, undo("2026-10-18T12:00:00.000Z", NOW + 100));
        await repo.pushUndo(hh, undo("2026-10-18T11:00:00.000Z", NOW + 100));
        const order: string[] = [];
        for (;;) {
          const r = await repo.popUndo(hh, NOW);
          if (!r) break;
          order.push(r.ts);
        }
        expect(order).toEqual(["2026-10-18T12:00:00.000Z", "2026-10-18T11:00:00.000Z", "2026-10-18T10:00:00.000Z"]);
      });
      it("a popped record cannot be popped again", async () => {
        await repo.pushUndo(hh, undo("2026-10-18T10:00:00.000Z", NOW + 100));
        await repo.popUndo(hh, NOW);
        expect(await repo.popUndo(hh, NOW)).toBeNull();
      });
      it.each([
        { label: "a record that expires after now", expiresAt: NOW + 1, found: true },
        { label: "a record that expires exactly now", expiresAt: NOW, found: false },
        { label: "a record that expired a second ago", expiresAt: NOW - 1, found: false },
        { label: "a record that expired long ago", expiresAt: 1, found: false },
      ])("$label", async ({ expiresAt, found }) => {
        await repo.pushUndo(hh, undo("2026-10-18T10:00:00.000Z", expiresAt));
        expect((await repo.popUndo(hh, NOW)) !== null).toBe(found);
      });
      it("skips an expired newest record and returns the newest live one", async () => {
        await repo.pushUndo(hh, undo("2026-10-18T10:00:00.000Z", NOW + 100));
        await repo.pushUndo(hh, undo("2026-10-18T12:00:00.000Z", NOW - 5));
        expect((await repo.popUndo(hh, NOW))?.ts).toBe("2026-10-18T10:00:00.000Z");
      });
      it("returns null when every record has expired", async () => {
        await repo.pushUndo(hh, undo("2026-10-18T10:00:00.000Z", NOW - 1));
        await repo.pushUndo(hh, undo("2026-10-18T11:00:00.000Z", NOW - 2));
        expect(await repo.popUndo(hh, NOW)).toBeNull();
      });
      it("expiry is judged by the time given, not the wall clock", async () => {
        await repo.pushUndo(hh, undo("2026-10-18T10:00:00.000Z", 2_000_000_000));
        expect(await repo.popUndo(hh, 2_000_000_001)).toBeNull();
        expect(await repo.popUndo(hh, 1_999_999_999)).not.toBeNull();
      });
      it.each([
        { type: "delete_asset", assetId: "a1" },
        { type: "delete_agreement", agreementId: "g1" },
        { type: "delete_event", assetId: "a1", eventId: "e1" },
      ] as const)("round-trips the $type inverse", async (inverse) => {
        await repo.pushUndo(hh, undo("2026-10-18T10:00:00.000Z", NOW + 10, { inverse }));
        expect((await repo.popUndo(hh, NOW))?.inverse).toEqual(inverse);
      });
    });

    describe("deleteDocumentCascade", () => {
      async function seed(h: string): Promise<void> {
        await repo.putDoc(h, doc("d1", { s3Key: "uploads/h/d1/lease.pdf" }));
        await repo.putDoc(h, doc("d2", { s3Key: "uploads/h/d2/other.pdf" }));
        await repo.putChunkMeta(h, chunk("d1", { s3Key: "chunks/h/d1.json" }));
        await repo.putChunkMeta(h, chunk("d2", { s3Key: "chunks/h/d2.json" }));
        await repo.putAgreement(h, agreement("g1", { docId: "d1" }));
        await repo.putAgreement(h, agreement("g1b", { docId: "d1" }));
        await repo.putAgreement(h, agreement("g2", { docId: "d2" }));
        await repo.putAgreement(h, agreement("g3"));
        await repo.replaceObligations(h, "g1", [obligation("o1", "2026-12-01", { agreementId: "g1" })]);
        await repo.replaceObligations(h, "g1b", [obligation("o1b", "2026-12-02", { agreementId: "g1b" })]);
        await repo.replaceObligations(h, "g2", [obligation("o2", "2026-12-03", { agreementId: "g2" })]);
        await repo.replaceObligations(h, null, [obligation("free", "2026-12-04")]);
        await repo.putAlert(h, alert("al-o1", { refId: "o1" }));
        await repo.putAlert(h, alert("al-o1b", { refId: "o1b", status: "done" }));
        await repo.putAlert(h, alert("al-o2", { refId: "o2" }));
        await repo.putAlert(h, alert("al-recall", { source: "recall", refId: "o1" }));
        await repo.putAsset(h, asset("a1"));
      }
      const range = { from: "2000-01-01", to: "2999-12-31" };

      it("returns the doc, page text and chunk keys", async () => {
        await seed(hh);
        const { s3Keys } = await repo.deleteDocumentCascade(hh, "d1");
        expect([...s3Keys].sort()).toEqual(
          ["uploads/h/d1/lease.pdf", pageTextKey(hh, "d1"), "chunks/h/d1.json"].sort(),
        );
      });
      it("returns just the doc and page text keys when there is no chunk pointer", async () => {
        await repo.putDoc(hh, doc("d1", { s3Key: "uploads/h/d1/lease.pdf" }));
        const { s3Keys } = await repo.deleteDocumentCascade(hh, "d1");
        expect([...s3Keys].sort()).toEqual(["uploads/h/d1/lease.pdf", pageTextKey(hh, "d1")].sort());
      });
      it("never returns the same key twice", async () => {
        await repo.putDoc(hh, doc("d1", { s3Key: "same/key" }));
        await repo.putChunkMeta(hh, chunk("d1", { s3Key: "same/key" }));
        const { s3Keys } = await repo.deleteDocumentCascade(hh, "d1");
        expect(new Set(s3Keys).size).toBe(s3Keys.length);
      });
      it("removes the doc and its chunk pointer", async () => {
        await seed(hh);
        await repo.deleteDocumentCascade(hh, "d1");
        expect(await repo.getDoc(hh, "d1")).toBeNull();
        expect(await repo.getChunkMeta(hh, "d1")).toBeNull();
      });
      it("removes every agreement of that doc", async () => {
        await seed(hh);
        await repo.deleteDocumentCascade(hh, "d1");
        expect(await repo.getAgreement(hh, "g1")).toBeNull();
        expect(await repo.getAgreement(hh, "g1b")).toBeNull();
      });
      it("removes the obligations derived from that doc", async () => {
        await seed(hh);
        await repo.deleteDocumentCascade(hh, "d1");
        expect((await repo.listObligations(hh, range)).map((o) => o.id)).toEqual(["o2", "free"]);
      });
      it("removes the deadline alerts about those obligations, open or not", async () => {
        await seed(hh);
        await repo.deleteDocumentCascade(hh, "d1");
        expect(await repo.getAlert(hh, "al-o1")).toBeNull();
        expect(await repo.getAlert(hh, "al-o1b")).toBeNull();
        expect((await repo.listAlerts(hh, { open: true })).map((a) => a.id).sort()).toEqual(["al-o2", "al-recall"]);
      });
      it("keeps a recall alert that happens to share a ref id", async () => {
        await seed(hh);
        await repo.deleteDocumentCascade(hh, "d1");
        expect(await repo.getAlert(hh, "al-recall")).not.toBeNull();
      });
      it("leaves other documents and everything derived from them", async () => {
        await seed(hh);
        await repo.deleteDocumentCascade(hh, "d1");
        expect(await repo.getDoc(hh, "d2")).not.toBeNull();
        expect(await repo.getChunkMeta(hh, "d2")).not.toBeNull();
        expect(await repo.getAgreement(hh, "g2")).not.toBeNull();
        expect(await repo.getAlert(hh, "al-o2")).not.toBeNull();
      });
      it("leaves agreements with no doc, free obligations and assets", async () => {
        await seed(hh);
        await repo.deleteDocumentCascade(hh, "d1");
        expect(await repo.getAgreement(hh, "g3")).not.toBeNull();
        expect(await repo.getAsset(hh, "a1")).not.toBeNull();
      });
      it("returns no keys and changes nothing for an unknown doc", async () => {
        await seed(hh);
        expect(await repo.deleteDocumentCascade(hh, "ghost")).toEqual({ s3Keys: [] });
        expect(await repo.listDocs(hh)).toHaveLength(2);
        expect(await repo.listObligations(hh, range)).toHaveLength(4);
      });
      it("returns no keys for an unknown doc even if a chunk pointer is orphaned", async () => {
        await repo.putChunkMeta(hh, chunk("orphan"));
        expect(await repo.deleteDocumentCascade(hh, "orphan")).toEqual({ s3Keys: [] });
      });
      it("is safe to repeat", async () => {
        await seed(hh);
        await repo.deleteDocumentCascade(hh, "d1");
        expect(await repo.deleteDocumentCascade(hh, "d1")).toEqual({ s3Keys: [] });
      });
    });

    describe("deleteHousehold", () => {
      it("returns no keys for a household with nothing", async () => {
        expect(await repo.deleteHousehold(hh)).toEqual({ s3Keys: [] });
      });
      it("removes every kind of data", async () => {
        await repo.putHousehold(hh, { id: hh, digestOn: true, createdAt: "t" });
        await repo.putAsset(hh, asset("a1"));
        await repo.putDoc(hh, doc("d1"));
        await repo.putAgreement(hh, agreement("g1", { docId: "d1" }));
        await repo.replaceObligations(hh, "g1", [obligation("o1", "2026-12-01", { agreementId: "g1" })]);
        await repo.addEvent(hh, event("e1", "a1", "2026-01-01T00:00:00.000Z"));
        await repo.putAlert(hh, alert("al1"));
        await repo.addSuppression(hh, suppression("R1", "a1"));
        await repo.putChunkMeta(hh, chunk("d1"));
        await repo.pushUndo(hh, undo("2026-10-18T10:00:00.000Z", 2_000_000_000));
        await repo.deleteHousehold(hh);
        expect(await repo.getHousehold(hh)).toBeNull();
        expect(await repo.listAssets(hh)).toEqual([]);
        expect(await repo.listDocs(hh)).toEqual([]);
        expect(await repo.listAgreements(hh)).toEqual([]);
        expect(await repo.listObligations(hh, { from: "2000-01-01", to: "2999-12-31" })).toEqual([]);
        expect(await repo.listEvents(hh, "a1", 10)).toEqual([]);
        expect(await repo.listAlerts(hh)).toEqual([]);
        expect(await repo.listAlerts(hh, { open: true })).toEqual([]);
        expect(await repo.listSuppressions(hh)).toEqual([]);
        expect(await repo.getChunkMeta(hh, "d1")).toBeNull();
        expect(await repo.popUndo(hh, 0)).toBeNull();
      });
      it("returns the keys of every document, its page text and its chunks", async () => {
        await repo.putDoc(hh, doc("d1", { s3Key: "u/d1.pdf" }));
        await repo.putDoc(hh, doc("d2", { s3Key: "u/d2.pdf" }));
        await repo.putChunkMeta(hh, chunk("d1", { s3Key: "c/d1.json" }));
        const { s3Keys } = await repo.deleteHousehold(hh);
        expect([...s3Keys].sort()).toEqual(
          ["u/d1.pdf", "u/d2.pdf", "c/d1.json", pageTextKey(hh, "d1"), pageTextKey(hh, "d2")].sort(),
        );
      });
      it("includes the key of an orphaned chunk pointer", async () => {
        await repo.putChunkMeta(hh, chunk("gone", { s3Key: "c/gone.json" }));
        expect((await repo.deleteHousehold(hh)).s3Keys).toContain("c/gone.json");
      });
      it("removes more than one batch of items", async () => {
        for (let i = 0; i < 60; i++) await repo.putAsset(hh, asset(`a${i}`));
        await repo.deleteHousehold(hh);
        expect(await repo.listAssets(hh)).toEqual([]);
      });
      it("can be used again afterwards", async () => {
        await repo.putAsset(hh, asset("a1"));
        await repo.deleteHousehold(hh);
        await repo.putAsset(hh, asset("a2"));
        expect((await repo.listAssets(hh)).map((a) => a.id)).toEqual(["a2"]);
      });
    });

    describe("copies", () => {
      it("a stored asset is not changed by editing the object that was put", async () => {
        const a = asset("a1", { aliases: ["x"] });
        await repo.putAsset(hh, a);
        a.name = "mutated";
        a.aliases?.push("y");
        const got = await repo.getAsset(hh, "a1");
        expect(got?.name).toBe("Thing a1");
        expect(got?.aliases).toEqual(["x"]);
      });
      it("editing a returned asset does not change the stored one", async () => {
        await repo.putAsset(hh, asset("a1", { aliases: ["x"] }));
        const got = await repo.getAsset(hh, "a1");
        if (got) {
          got.name = "mutated";
          got.aliases?.push("y");
        }
        expect(await repo.getAsset(hh, "a1")).toEqual(asset("a1", { aliases: ["x"] }));
      });
      it("editing a listed agreement does not change the stored one", async () => {
        await repo.putAgreement(hh, agreement("g1"));
        const [first] = await repo.listAgreements(hh);
        if (first) first.fields.endDate = "1999-01-01";
        expect((await repo.getAgreement(hh, "g1"))?.fields.endDate).toBe("2027-01-01");
      });
      it("editing a list of obligations does not change the stored ones", async () => {
        const list = [obligation("o1", "2026-01-01", { agreementId: "g1" })];
        await repo.replaceObligations(hh, "g1", list);
        list[0]!.label = "mutated";
        const got = await repo.listObligations(hh, { from: "2026-01-01", to: "2026-01-01" });
        expect(got[0]?.label).toBe("Thing o1");
      });
    });

    describe("isolation between households", () => {
      let a: string;
      let b: string;
      beforeEach(() => {
        a = fresh("hhA");
        b = fresh("hhB");
      });
      const range = { from: "2000-01-01", to: "2999-12-31" };

      it.each(["household", "asset", "doc", "agreement", "alert", "chunk pointer"])(
        "A cannot read B's %s by guessing its id",
        async (entity) => {
          const reads: Record<string, [() => Promise<unknown>, () => Promise<unknown>]> = {
            household: [
              () => repo.putHousehold(b, { id: "x", digestOn: true, createdAt: "t" }),
              () => repo.getHousehold(a),
            ],
            asset: [() => repo.putAsset(b, asset("shared")), () => repo.getAsset(a, "shared")],
            doc: [() => repo.putDoc(b, doc("shared")), () => repo.getDoc(a, "shared")],
            agreement: [() => repo.putAgreement(b, agreement("shared")), () => repo.getAgreement(a, "shared")],
            alert: [() => repo.putAlert(b, alert("shared")), () => repo.getAlert(a, "shared")],
            "chunk pointer": [() => repo.putChunkMeta(b, chunk("shared")), () => repo.getChunkMeta(a, "shared")],
          };
          const [seedB, readA] = reads[entity]!;
          await seedB();
          expect(await readA()).toBeNull();
        },
      );

      it("A's lists never contain B's data", async () => {
        await repo.putAsset(b, asset("shared"));
        await repo.putDoc(b, doc("shared"));
        await repo.putAgreement(b, agreement("shared", { docId: "shared", assetIds: ["shared"] }));
        await repo.replaceObligations(b, "shared", [obligation("o", "2026-01-01", { agreementId: "shared" })]);
        await repo.addEvent(b, event("e", "shared", "2026-01-01T00:00:00.000Z"));
        await repo.putAlert(b, alert("shared"));
        await repo.addSuppression(b, suppression("R", "shared"));
        expect(await repo.listAssets(a)).toEqual([]);
        expect(await repo.listDocs(a)).toEqual([]);
        expect(await repo.listAgreements(a)).toEqual([]);
        expect(await repo.listAgreements(a, { docId: "shared" })).toEqual([]);
        expect(await repo.listAgreements(a, { assetId: "shared" })).toEqual([]);
        expect(await repo.listObligations(a, range)).toEqual([]);
        expect(await repo.listEvents(a, "shared", 10)).toEqual([]);
        expect(await repo.listAlerts(a)).toEqual([]);
        expect(await repo.listAlerts(a, { open: true })).toEqual([]);
        expect(await repo.listSuppressions(a)).toEqual([]);
      });

      it("A writing the same id does not overwrite B's item", async () => {
        await repo.putAsset(b, asset("shared", { name: "B asset" }));
        await repo.putDoc(b, doc("shared", { filename: "B.pdf" }));
        await repo.putAgreement(b, agreement("shared", { party: "B party" }));
        await repo.putAlert(b, alert("shared", { label: "B alert" }));
        await repo.putChunkMeta(b, chunk("shared", { chunkCount: 99 }));
        await repo.putAsset(a, asset("shared", { name: "A asset" }));
        await repo.putDoc(a, doc("shared", { filename: "A.pdf" }));
        await repo.putAgreement(a, agreement("shared", { party: "A party" }));
        await repo.putAlert(a, alert("shared", { label: "A alert" }));
        await repo.putChunkMeta(a, chunk("shared", { chunkCount: 1 }));
        expect((await repo.getAsset(b, "shared"))?.name).toBe("B asset");
        expect((await repo.getDoc(b, "shared"))?.filename).toBe("B.pdf");
        expect((await repo.getAgreement(b, "shared"))?.party).toBe("B party");
        expect((await repo.getAlert(b, "shared"))?.label).toBe("B alert");
        expect((await repo.getChunkMeta(b, "shared"))?.chunkCount).toBe(99);
      });

      it("A deleting by B's ids deletes nothing of B's", async () => {
        await repo.putAsset(b, asset("shared"));
        await repo.putAgreement(b, agreement("shared"));
        await repo.addEvent(b, event("e", "shared", "2026-01-01T00:00:00.000Z"));
        await repo.deleteAsset(a, "shared");
        await repo.deleteAgreement(a, "shared");
        await repo.deleteEvent(a, "shared", "e");
        expect(await repo.getAsset(b, "shared")).not.toBeNull();
        expect(await repo.getAgreement(b, "shared")).not.toBeNull();
        expect(await repo.listEvents(b, "shared", 10)).toHaveLength(1);
      });

      it("A replacing obligations for B's agreement id leaves B's obligations alone", async () => {
        await repo.replaceObligations(b, "g", [obligation("ob", "2026-01-01", { agreementId: "g" })]);
        await repo.replaceObligations(a, "g", []);
        await repo.replaceObligations(a, null, []);
        expect((await repo.listObligations(b, range)).map((o) => o.id)).toEqual(["ob"]);
      });

      it("A running the cascade for B's doc id returns nothing and deletes nothing", async () => {
        await repo.putDoc(b, doc("d", { s3Key: "b/secret.pdf" }));
        await repo.putChunkMeta(b, chunk("d"));
        await repo.putAgreement(b, agreement("g", { docId: "d" }));
        await repo.replaceObligations(b, "g", [obligation("o", "2026-01-01", { agreementId: "g" })]);
        await repo.putAlert(b, alert("al", { refId: "o" }));
        expect(await repo.deleteDocumentCascade(a, "d")).toEqual({ s3Keys: [] });
        expect(await repo.getDoc(b, "d")).not.toBeNull();
        expect(await repo.getChunkMeta(b, "d")).not.toBeNull();
        expect(await repo.getAgreement(b, "g")).not.toBeNull();
        expect(await repo.listObligations(b, range)).toHaveLength(1);
        expect(await repo.getAlert(b, "al")).not.toBeNull();
      });

      it("deleting all of A's data leaves B whole", async () => {
        for (const h of [a, b]) {
          await repo.putAsset(h, asset("x"));
          await repo.putDoc(h, doc("d"));
          await repo.addEvent(h, event("e", "x", "2026-01-01T00:00:00.000Z"));
          await repo.pushUndo(h, undo("2026-10-18T10:00:00.000Z", 2_000_000_000));
        }
        await repo.deleteHousehold(a);
        expect(await repo.getAsset(b, "x")).not.toBeNull();
        expect(await repo.getDoc(b, "d")).not.toBeNull();
        expect(await repo.listEvents(b, "x", 10)).toHaveLength(1);
        expect(await repo.popUndo(b, 0)).not.toBeNull();
      });

      it("A cannot pop B's undo record", async () => {
        await repo.pushUndo(b, undo("2026-10-18T10:00:00.000Z", 2_000_000_000));
        expect(await repo.popUndo(a, 0)).toBeNull();
        expect(await repo.popUndo(b, 0)).not.toBeNull();
      });

      it("a household id that extends another does not see its data", async () => {
        const longer = `${a}#extra`;
        await repo.putAsset(longer, asset("x"));
        await repo.putAsset(a, asset("y"));
        expect((await repo.listAssets(a)).map((v) => v.id)).toEqual(["y"]);
        expect((await repo.listAssets(longer)).map((v) => v.id)).toEqual(["x"]);
        await repo.deleteHousehold(a);
        expect((await repo.listAssets(longer)).map((v) => v.id)).toEqual(["x"]);
      });

      it.each(["HH#", "HH#x", "#", "a#b", "%", "%23"])(
        "a hostile household id suffix %j is its own household",
        async (weird) => {
          const h = `${a}${weird}`;
          await repo.putAsset(a, asset("mine"));
          await repo.putAsset(h, asset("theirs"));
          expect((await repo.listAssets(a)).map((v) => v.id)).toEqual(["mine"]);
          expect((await repo.listAssets(h)).map((v) => v.id)).toEqual(["theirs"]);
          await repo.deleteHousehold(h);
          expect((await repo.listAssets(a)).map((v) => v.id)).toEqual(["mine"]);
        },
      );

      describe("hostile ids", () => {
        it.each(HOSTILE_IDS)("asset id %j round-trips and stays in its household", async (id) => {
          await repo.putAsset(a, asset(id));
          await repo.putAsset(b, asset("other"));
          expect((await repo.getAsset(a, id))?.id).toBe(id);
          expect((await repo.listAssets(a)).map((v) => v.id)).toEqual([id]);
          expect(await repo.getAsset(b, id)).toBeNull();
          expect((await repo.listAssets(b)).map((v) => v.id)).toEqual(["other"]);
        });
        it.each(HOSTILE_IDS)("doc id %j round-trips and is not a prefix match for others", async (id) => {
          await repo.putDoc(a, doc(id));
          await repo.putDoc(a, doc("plain"));
          expect((await repo.getDoc(a, id))?.id).toBe(id);
          expect(await repo.getDoc(a, `${id}x`)).toBeNull();
          expect(await repo.listDocs(a)).toHaveLength(2);
          expect(await repo.listDocs(b)).toEqual([]);
        });
        it.each(HOSTILE_IDS)("agreement id %j round-trips", async (id) => {
          await repo.putAgreement(a, agreement(id));
          expect((await repo.getAgreement(a, id))?.id).toBe(id);
          expect(await repo.getAgreement(b, id)).toBeNull();
          await repo.deleteAgreement(b, id);
          expect(await repo.getAgreement(a, id)).not.toBeNull();
        });
        it.each(HOSTILE_IDS)("alert id %j round-trips", async (id) => {
          await repo.putAlert(a, alert(id));
          expect((await repo.getAlert(a, id))?.id).toBe(id);
          expect(await repo.getAlert(b, id)).toBeNull();
          expect((await repo.listAlerts(a, { open: true })).map((v) => v.id)).toEqual([id]);
        });
        it.each(HOSTILE_IDS)("obligation id %j is listed once, in range, only for its household", async (id) => {
          await repo.replaceObligations(a, "g", [obligation(id, "2026-05-05", { agreementId: "g" })]);
          expect((await repo.listObligations(a, range)).map((o) => o.id)).toEqual([id]);
          expect(await repo.listObligations(b, range)).toEqual([]);
        });
        it.each(HOSTILE_IDS)("agreement id %j used for replaceObligations only touches that agreement", async (gid) => {
          await repo.replaceObligations(a, gid, [obligation("o1", "2026-05-05", { agreementId: gid })]);
          await repo.replaceObligations(a, "plain", [obligation("o2", "2026-05-06", { agreementId: "plain" })]);
          await repo.replaceObligations(a, gid, []);
          expect((await repo.listObligations(a, range)).map((o) => o.id)).toEqual(["o2"]);
        });
        it.each(HOSTILE_IDS)("asset id %j keeps its events apart from other assets", async (assetId) => {
          await repo.addEvent(a, event("e1", assetId, "2026-01-01T00:00:00.000Z"));
          await repo.addEvent(a, event("e2", "plain", "2026-01-02T00:00:00.000Z"));
          expect((await repo.listEvents(a, assetId, 10)).map((e) => e.id)).toEqual(["e1"]);
          await repo.deleteEvent(a, assetId, "e1");
          expect((await repo.listEvents(a, "plain", 10)).map((e) => e.id)).toEqual(["e2"]);
        });
        it.each(HOSTILE_IDS)("chunk pointer for doc %j round-trips", async (id) => {
          await repo.putChunkMeta(a, chunk(id));
          expect((await repo.getChunkMeta(a, id))?.docId).toBe(id);
          expect(await repo.getChunkMeta(b, id)).toBeNull();
        });
        it.each(HOSTILE_IDS)("doc id %j cascades without touching a neighbour", async (id) => {
          await repo.putDoc(a, doc(id, { s3Key: "k/hostile" }));
          await repo.putDoc(a, doc("plain", { s3Key: "k/plain" }));
          await repo.putAgreement(a, agreement("g-h", { docId: id }));
          await repo.putAgreement(a, agreement("g-p", { docId: "plain" }));
          const { s3Keys } = await repo.deleteDocumentCascade(a, id);
          expect(s3Keys).toContain("k/hostile");
          expect(s3Keys).not.toContain("k/plain");
          expect(await repo.getDoc(a, "plain")).not.toBeNull();
          expect(await repo.getAgreement(a, "g-p")).not.toBeNull();
          expect(await repo.getAgreement(a, "g-h")).toBeNull();
        });
        it.each(HOSTILE_IDS)("suppression ids %j round-trip", async (id) => {
          await repo.addSuppression(a, suppression(id, id));
          expect(await repo.listSuppressions(a)).toEqual([suppression(id, id)]);
          expect(await repo.listSuppressions(b)).toEqual([]);
        });
      });
    });
  });
}
