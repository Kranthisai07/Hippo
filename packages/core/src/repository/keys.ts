import type { Alert, ObligationRecord } from "../contracts";
import { SEVERITY_RANK, isOpenAlert } from "./shared";

// Key layout of the single table (SPEC section 3). No AWS imports here, so it is cheap to unit test.
//
//   PK = HH#<householdId>, SK per entity:
//     HOUSEHOLD
//     ASSET#<id>   DOC#<id>   AGREEMENT#<id>   ALERT#<id>   CHUNKMETA#<docId>
//     OBLIGATION#<dueDate>#<id>
//     EVENT#<assetId>#<ts>#<id>           (SPEC says EVENT#assetId#ts; the id is appended so two events in the same
//                                          millisecond do not overwrite each other and deleteEvent can find one)
//     SUPPRESS#<source>#<recallId>#<assetId>
//     UNDO#<ts>                           (numeric `ttl` attribute = UndoRecord.expiresAt, Unix seconds)
//
// Every id is escaped (see `enc`) before it goes into a key, so an id holding "#" or "HH#" cannot add or move a key
// segment. Every read is an exact PK match, so one household id can never be a prefix of another.
//
// GSI1 (sparse, projection ALL) serves the two "per household, ordered" reads:
//   obligations:  GSI1PK = HH#<hh>#OBLIGATION    GSI1SK = <dueDate>#<id>
//   open alerts:  GSI1PK = HH#<hh>#ALERT_OPEN    GSI1SK = <severityRank>#<dueDate or ~>#<id>   (rank 0 = high)
// An alert that is done or dismissed has no GSI1 attributes, so it drops out of the index when it is rewritten.

export const GSI1 = "GSI1";
export const TTL_ATTRIBUTE = "ttl";

/** Escape the two characters the key format uses: "%" first, then "#". Reversible and never produces "#". */
export const enc = (part: string): string => part.replaceAll("%", "%25").replaceAll("#", "%23");

export const pk = (householdId: string): string => `HH#${enc(householdId)}`;

export const HOUSEHOLD_SK = "HOUSEHOLD";
export const PREFIX = {
  asset: "ASSET#",
  doc: "DOC#",
  agreement: "AGREEMENT#",
  obligation: "OBLIGATION#",
  event: "EVENT#",
  alert: "ALERT#",
  suppress: "SUPPRESS#",
  chunkMeta: "CHUNKMETA#",
  undo: "UNDO#",
} as const;

export const sk = {
  asset: (id: string) => `${PREFIX.asset}${enc(id)}`,
  doc: (id: string) => `${PREFIX.doc}${enc(id)}`,
  agreement: (id: string) => `${PREFIX.agreement}${enc(id)}`,
  obligation: (dueDate: string, id: string) => `${PREFIX.obligation}${enc(dueDate)}#${enc(id)}`,
  event: (assetId: string, ts: string, id: string) => `${PREFIX.event}${enc(assetId)}#${enc(ts)}#${enc(id)}`,
  eventPrefix: (assetId: string) => `${PREFIX.event}${enc(assetId)}#`,
  alert: (id: string) => `${PREFIX.alert}${enc(id)}`,
  suppress: (source: string, recallId: string, assetId: string) =>
    `${PREFIX.suppress}${enc(source)}#${enc(recallId)}#${enc(assetId)}`,
  chunkMeta: (docId: string) => `${PREFIX.chunkMeta}${enc(docId)}`,
  undo: (ts: string) => `${PREFIX.undo}${enc(ts)}`,
};

/**
 * Inclusive sort-key bounds for obligations due from `from` to `to`. "#" (0x23) ends the date part of a key, so the
 * lowest key of day `from` is `...<from>#` and every key of day `to` is below `...<to>$` ("$" is the next character).
 */
export function obligationRange(from: string, to: string): { lo: string; hi: string } {
  return { lo: `${PREFIX.obligation}${enc(from)}#`, hi: `${PREFIX.obligation}${enc(to)}$` };
}

export function obligationGsi(householdId: string, o: ObligationRecord): { GSI1PK: string; GSI1SK: string } {
  return { GSI1PK: `${pk(householdId)}#OBLIGATION`, GSI1SK: `${o.dueDate}#${enc(o.id)}` };
}

export const openAlertsGsiPk = (householdId: string): string => `${pk(householdId)}#ALERT_OPEN`;

/** Only open alerts (pending or announced) get GSI1 attributes. */
export function alertGsi(householdId: string, a: Alert): { GSI1PK: string; GSI1SK: string } | null {
  if (!isOpenAlert(a)) return null;
  return {
    GSI1PK: openAlertsGsiPk(householdId),
    GSI1SK: `${SEVERITY_RANK[a.severity]}#${a.dueDate ?? "~"}#${enc(a.id)}`,
  };
}
