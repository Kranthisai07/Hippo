import { describe, expect, it } from "vitest";
import type { Agreement, Alert, ObligationRecord } from "../src/contracts";
import { agreementIdOfRef, derivedFromDoc } from "../src/repository/shared";

const agreement = (id: string, docId: string): Agreement => ({
  id,
  kind: "lease",
  assetIds: [],
  docId,
  fields: {},
  fieldStatus: {},
  sourceRefs: {},
  createdAt: "2026-10-01T00:00:00.000Z",
});
const alert = (id: string, refId: string, source: Alert["source"] = "deadline"): Alert => ({
  id,
  refId,
  source,
  severity: "high",
  status: "pending",
  label: "x",
});
const obligation = (id: string, agreementId: string): ObligationRecord => ({
  id,
  agreementId,
  type: "notice_by",
  dueDate: "2026-11-01",
  label: "x",
  confirmed: true,
  severity: "high",
});

describe("agreementIdOfRef", () => {
  it.each([
    ["ag1:notice_by:2026-11-01", "ag1"],
    ["a:b:renews:2026-12-01", "a:b"],
    ["a:renews:2026-12-01", "a"],
    ["x:y:z:charge:2027-01-05", "x:y:z"],
  ])("%s belongs to %s", (ref, id) => {
    expect(agreementIdOfRef(ref)).toBe(id);
  });

  it.each(["", "nocolons", "one:colon", "cpsc:26530"])("%j has no agreement", (ref) => {
    expect(agreementIdOfRef(ref)).toBeNull();
  });
});

// Round 2 review: deleting a document left behind the alerts of dates that had since changed, because the cascade only
// matched alerts whose obligation still existed.
describe("derivedFromDoc finds every alert of the document's agreements", () => {
  it("includes an alert whose obligation no longer exists (an old date)", () => {
    const got = derivedFromDoc(
      "doc1",
      [agreement("ag1", "doc1")],
      [obligation("ag1:notice_by:2026-11-05", "ag1")],
      [alert("al-new", "ag1:notice_by:2026-11-05"), alert("al-old", "ag1:notice_by:2026-11-01")],
    );
    expect(got.alertIds.sort()).toEqual(["al-new", "al-old"]);
  });

  it("does not take the alerts of another document, of a prefix lookalike, or a recall alert", () => {
    const got = derivedFromDoc(
      "doc1",
      [agreement("a", "doc1"), agreement("a:b", "doc2"), agreement("ag10", "doc3")],
      [],
      [
        alert("mine", "a:renews:2026-12-01"),
        alert("theirs", "a:b:renews:2026-12-01"),
        alert("other", "ag10:renews:2026-12-01"),
        alert("recall", "cpsc:26530:A-baby-bottles", "recall"),
      ],
    );
    expect(got.alertIds).toEqual(["mine"]);
  });
});
