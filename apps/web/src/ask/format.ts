const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-26" to { mon: "Oct", day: "26", year: "2026" }. Plain string work, so no time zone can shift the day. */
export function parts(iso: string | null | undefined): { mon: string; day: string; year: string } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  if (!m) return null;
  return { mon: MONTHS[Number(m[2]) - 1] ?? "", day: String(Number(m[3])), year: m[1]! };
}

export function fmtDate(iso: string | null | undefined, withYear = false): string {
  const p = parts(iso);
  if (!p) return "no date";
  return withYear ? `${p.mon} ${p.day}, ${p.year}` : `${p.mon} ${p.day}`;
}

export function daysAwayText(d: number | null): string {
  if (d === null) return "";
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  if (d === -1) return "yesterday";
  return d > 0 ? `in ${d} days` : `${-d} days ago`;
}

/** Recall detail arrives as "Hazard: ... Remedy: ..." (sometimes with a lead sentence). It is data, shown as text. */
export function splitRecall(detail: string | null): { hazard: string | null; remedy: string | null } {
  const m = /Hazard:\s*([\s\S]*?)\s*Remedy:\s*([\s\S]*)$/.exec(detail ?? "");
  if (m) return { hazard: m[1]!.trim() || null, remedy: m[2]!.trim() || null };
  return { hazard: detail?.trim() || null, remedy: null };
}

/** Which argument holds "the thing" for a tool, used when a question back is answered. */
export const THING_KEY: Record<string, string> = {
  check_coverage: "asset",
  log_service: "asset",
  get_history: "asset",
  ask_documents: "about",
  get_agreement: "about",
};
