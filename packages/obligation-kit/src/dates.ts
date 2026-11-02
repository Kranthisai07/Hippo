// Calendar math on ISO dates (YYYY-MM-DD), done in UTC so a local timezone or DST never shifts a day.

const DAY_MS = 86_400_000;
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Returns UTC midnight in ms, or null when the string is not a real calendar date. */
export function parseIso(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = ISO.exec(value);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1000) return null;
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  const real = back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d;
  return real ? t : null;
}

function need(iso: string): number {
  const t = parseIso(iso);
  if (t === null) throw new RangeError(`not an ISO date: ${String(iso)}`);
  return t;
}

function toIso(t: number): string {
  const s = new Date(t).toISOString();
  // Past year 9999 the string starts with "+" and is not an ISO date, so fail loudly instead.
  if (s[0] === "+" || s[0] === "-") throw new RangeError("date out of range");
  return s.slice(0, 10);
}

export const addDays = (iso: string, n: number): string => toIso(need(iso) + n * DAY_MS);

/** Whole days from a to b; negative when b is earlier. */
export const daysBetween = (a: string, b: string): number => Math.round((need(b) - need(a)) / DAY_MS);

export const daysInMonth = (year: number, month0: number): number =>
  new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();

/** Adds calendar months and clamps to the month end (Jan 31 + 1 month = Feb 28 or 29). */
export function addMonths(iso: string, n: number): string {
  const d = new Date(need(iso));
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + n;
  const year = Math.floor(total / 12);
  const month0 = ((total % 12) + 12) % 12;
  return toIso(Date.UTC(year, month0, Math.min(d.getUTCDate(), daysInMonth(year, month0))));
}

// ---- US federal holidays (for business-day notice clauses) ----

const dow = (y: number, m0: number, d: number): number => new Date(Date.UTC(y, m0, d)).getUTCDay();

function nthWeekday(y: number, m0: number, weekday: number, n: number): number {
  return 1 + ((weekday - dow(y, m0, 1) + 7) % 7) + (n - 1) * 7;
}

function lastWeekday(y: number, m0: number, weekday: number): number {
  const last = daysInMonth(y, m0);
  return last - ((dow(y, m0, last) - weekday + 7) % 7);
}

/** A fixed-date holiday is observed on Friday when it falls on Saturday and Monday when on Sunday. */
function observed(y: number, m0: number, d: number): string {
  const w = dow(y, m0, d);
  return toIso(Date.UTC(y, m0, d) + (w === 6 ? -DAY_MS : w === 0 ? DAY_MS : 0));
}

const cache = new Map<number, Set<string>>();

function holidaySet(y: number): Set<string> {
  const hit = cache.get(y);
  if (hit) return hit;
  const at = (m0: number, d: number) => toIso(Date.UTC(y, m0, d));
  const set = new Set<string>([
    observed(y, 0, 1), // New Year's Day
    at(0, nthWeekday(y, 0, 1, 3)), // Martin Luther King Jr. Day
    at(1, nthWeekday(y, 1, 1, 3)), // Washington's Birthday
    at(4, lastWeekday(y, 4, 1)), // Memorial Day
    observed(y, 6, 4), // Independence Day
    at(8, nthWeekday(y, 8, 1, 1)), // Labor Day
    at(9, nthWeekday(y, 9, 1, 2)), // Columbus Day
    observed(y, 10, 11), // Veterans Day
    at(10, nthWeekday(y, 10, 4, 4)), // Thanksgiving
    observed(y, 11, 25), // Christmas
  ]);
  if (y >= 2021) set.add(observed(y, 5, 19)); // Juneteenth
  cache.set(y, set);
  return set;
}

/** Year y+1 is checked too because New Year's Day observed can land on Dec 31 of year y. */
export function isFederalHoliday(iso: string): boolean {
  const y = new Date(need(iso)).getUTCFullYear();
  return holidaySet(y).has(iso) || holidaySet(y + 1).has(iso);
}

export function isBusinessDay(iso: string): boolean {
  const w = new Date(need(iso)).getUTCDay();
  return w !== 0 && w !== 6 && !isFederalHoliday(iso);
}

/** Steps back n business days. The result is always itself a business day when n > 0. */
export function subtractBusinessDays(iso: string, n: number): string {
  let cur = iso;
  let left = n;
  while (left > 0) {
    cur = addDays(cur, -1);
    if (isBusinessDay(cur)) left--;
  }
  return cur;
}
