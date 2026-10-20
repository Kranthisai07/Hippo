import { runDigest } from "./digest";
import { syncDeadlines } from "./deadlines";
import { createRecallRadar } from "./recalls";
import type { DailyDeps, HouseholdReport, RunReport } from "./types";

/** SPEC section 10. `today` is the only date the job reads, and `deps.now` the only clock. */
export async function runDaily(deps: DailyDeps, today: string): Promise<RunReport> {
  const radar = createRecallRadar({ fetch: deps.fetch, sleep: deps.sleep, now: deps.now, config: deps.config });
  const households: HouseholdReport[] = [];
  const ids = [...new Set(await deps.listHouseholdIds())].sort();

  for (const householdId of ids) {
    const report: HouseholdReport = {
      householdId,
      obligationsComputed: 0,
      alertsCreated: 0,
      alertsRefreshed: 0,
      alertsLeftAlone: 0,
      alertsDismissed: 0,
      recallsChecked: 0,
      recallAlertsCreated: 0,
      errors: [],
      email: { status: "skipped", reason: "nothing_to_send" },
    };
    households.push(report);
    // One household failing (bad data, a repository error) never stops the others.
    try {
      const household = await deps.repository.getHousehold(householdId);
      if (!household) {
        report.errors.push({ source: "household", kind: "unexpected", message: "household record not found" });
        continue;
      }
      const d = await syncDeadlines(deps.repository, householdId, today);
      const { errors: deadlineErrors, counts } = d;
      Object.assign(report, counts);
      report.errors.push(...deadlineErrors);

      const r = await radar.run(deps.repository, householdId, today);
      report.recallsChecked = r.recallsChecked;
      report.recallAlertsCreated = r.created;
      report.alertsLeftAlone += r.leftAlone;
      report.errors.push(...r.errors);

      try {
        report.email = await runDigest(deps, householdId, household, today);
        if (report.email.status === "sent" && report.email.markFailed) {
          report.errors.push({
            source: "digest",
            kind: "unexpected",
            message: "digest sent but alerts could not be marked emailed",
          });
        }
      } catch (e) {
        const name = e instanceof Error ? e.name : "unknown";
        report.email = { status: "failed", reason: `digest could not be built (${name})`, alertIds: [] };
        report.errors.push({ source: "digest", kind: "unexpected", message: `digest could not be built (${name})` });
      }
    } catch (e) {
      report.errors.push({
        source: "household",
        kind: "unexpected",
        message: `unexpected error (${e instanceof Error ? e.name : "unknown"})`,
      });
    }
  }
  return { today, households, requests: radar.requests };
}
