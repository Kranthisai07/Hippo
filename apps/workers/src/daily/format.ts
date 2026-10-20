import type { RunReport } from "./types";

/** Plain text for the CLI. Everything printed comes from the report, which holds no document text and no tokens. */
export function formatReport(report: RunReport): string {
  const out: string[] = [`Hippo daily run for ${report.today}`];
  const r = report.requests;
  out.push(
    `requests: CPSC ${r.cpsc}, NHTSA ${r.nhtsa} of ${r.nhtsaCap}${r.nhtsaCapReached ? " (CAP REACHED, some vehicles were not checked)" : ""}`,
  );
  for (const h of report.households) {
    out.push("", `household ${h.householdId}`);
    out.push(`  obligations computed: ${h.obligationsComputed}`);
    out.push(
      `  deadline alerts: ${h.alertsCreated} created, ${h.alertsRefreshed} refreshed, ${h.alertsLeftAlone} left alone, ${h.alertsDismissed} dismissed`,
    );
    out.push(`  recalls checked: ${h.recallsChecked}, recall alerts created: ${h.recallAlertsCreated}`);
    for (const e of h.errors)
      out.push(`  error [${e.source}/${e.kind}]${e.assetId ? ` asset ${e.assetId}` : ""}: ${e.message}`);
    const m = h.email;
    out.push(`  email: ${m.status}${m.status === "sent" ? ` (${m.alertIds.length} alerts)` : `, ${m.reason}`}`);
    if (m.status === "skipped" && m.preview)
      out.push("", `  Subject: ${m.preview.subject}`, ...m.preview.text.split("\n").map((l) => `  | ${l}`));
  }
  return out.join("\n");
}
