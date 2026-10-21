import type { Doc, Me } from "./types";

/**
 * The API does not send the server date (friction: docs/WEB_API.md has no field for it). The newest upload time comes
 * from the same server clock, so it is the best stand-in. With no documents at all, the browser date is used.
 */
export function inferToday(me: Me | null, docs: Doc[]): string {
  if (me?.today) return me.today;
  const newest = docs
    .map((d) => d.uploadedAt)
    .sort()
    .at(-1);
  return (newest ?? new Date().toISOString()).slice(0, 10);
}
