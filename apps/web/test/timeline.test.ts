import { describe, expect, it } from "vitest";
import { buildTimeline, groupByWeek } from "../src/lib/timeline";
import type { Alert, ObligationItem } from "../src/lib/types";

const ob = (
  id: string,
  over: Partial<ObligationItem["obligation"]> = {},
  needs = false,
  docId = "doc-1",
): ObligationItem => ({
  obligation: {
    id,
    type: "notice_by",
    dueDate: "2026-11-01",
    label: "Lease notice deadline",
    confirmed: !needs,
    severity: needs ? null : "high",
    ...over,
  },
  needsConfirmation: needs,
  docId,
});
const alert = (over: Partial<Alert>): Alert => ({
  id: "alert-1",
  source: "deadline",
  severity: "high",
  status: "pending",
  label: "x",
  refId: "a:notice_by:2026-11-01",
  ...over,
});

describe("buildTimeline", () => {
  it("puts an unconfirmed date only in the unconfirmed group, with no severity and no alert", () => {
    const t = buildTimeline([ob("a:notice_by:2026-11-01", {}, true)], [alert({ refId: "a:notice_by:2026-11-01" })]);
    expect(t.confirmed).toHaveLength(0);
    expect(t.unconfirmed).toHaveLength(1);
    expect(t.unconfirmed[0]).toMatchObject({ severity: null, confirmed: false });
    expect(t.unconfirmed[0]!.alert).toBeUndefined();
  });

  it("ignores a stored severity when the server says the date needs confirmation", () => {
    const t = buildTimeline([ob("x", { confirmed: true, severity: "high" }, true)], []);
    expect(t.confirmed).toHaveLength(0);
    expect(t.unconfirmed[0]!.severity).toBeNull();
  });

  it("attaches the open alert to a confirmed item and does not duplicate it", () => {
    const t = buildTimeline([ob("a:notice_by:2026-11-01")], [alert({})]);
    expect(t.confirmed).toHaveLength(1);
    expect(t.confirmed[0]!.alert?.id).toBe("alert-1");
  });

  it("shows a recall alert on its own as confirmed, and skips closed alerts", () => {
    const t = buildTimeline(
      [],
      [
        alert({ id: "r1", source: "recall", refId: "cpsc-1", severity: "possible" }),
        alert({ id: "r2", refId: "q", status: "done" }),
      ],
    );
    expect(t.confirmed.map((e) => e.key)).toEqual(["r1"]);
    expect(t.confirmed[0]!.type).toBe("recall");
  });
});

describe("groupByWeek", () => {
  it("groups by week and puts high before possible inside a week", () => {
    const mk = (key: string, date: string, severity: "high" | "possible") => ({
      key,
      date,
      type: "renews" as const,
      label: key,
      severity,
      confirmed: true,
    });
    const g = groupByWeek(
      [mk("p", "2026-10-22", "possible"), mk("h", "2026-10-25", "high"), mk("later", "2026-11-12", "high")],
      "2026-10-21",
    );
    expect(g.map((x) => x.title)).toEqual(["This week", "In 3 weeks"]);
    expect(g[0]!.entries.map((e) => e.key)).toEqual(["h", "p"]);
  });
});
