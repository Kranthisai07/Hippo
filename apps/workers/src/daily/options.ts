import { parseIso } from "obligation-kit";

/** A mistake in the command line, with a message the operator can read (unlike other errors, which print only a name). */
export class UsageError extends Error {
  override name = "UsageError";
}

/**
 * A whole number between `min` and `max`. Anything else is refused, never turned into NaN: a comparison with NaN is
 * always false, so a bad `--max-nhtsa` would silently switch the cost guard off.
 */
export function wholeNumber(name: string, raw: string | undefined, min: number, max: number): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^[0-9]{1,9}$/.test(raw)) throw new UsageError(`--${name} must be a whole number from ${min} to ${max}.`);
  const n = Number(raw);
  if (n < min || n > max) throw new UsageError(`--${name} must be a whole number from ${min} to ${max}.`);
  return n;
}

/** The date the job runs as of: an ISO date, or the real date when none is given. */
export function parseToday(raw: string | undefined, real: string): string {
  if (raw === undefined) return real;
  if (parseIso(raw) === null) throw new UsageError("--today must be a real date written YYYY-MM-DD.");
  return raw;
}
