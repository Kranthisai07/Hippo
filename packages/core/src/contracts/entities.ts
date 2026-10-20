import type { AgreementKind, DocType, FieldStatus, ObligationType, Severity, SourceRefTree } from "obligation-kit";
import type { DigestAlert } from "../digest";
import type { AssetRecord } from "../linking";
import type { AgreementLike } from "../resolver";

// Entity types for SPEC section 3. Frozen by T1.1: changing a shape needs a Decision in MEMORY.md and a heads up to the
// other dev. Every record lives under one household; the repository takes the household id from the auth token and
// never from tool arguments, so no entity carries its own household id.

export type { AgreementKind, DocType, FieldStatus, ObligationType, Severity, SourceRefTree };

export const ASSET_CATEGORIES = ["appliance", "vehicle", "home", "electronics", "child_safety", "other"] as const;
export type AssetCategory = (typeof ASSET_CATEGORIES)[number];

export interface Household {
  id: string;
  /** Where the daily digest goes. Optional until the person sets it. */
  email?: string;
  /** Daily digest on or off. */
  digestOn: boolean;
  createdAt: string;
}

/** A thing owned or rented. `vehicle.nhtsaMake` and `nhtsaModel` are set by the daily job, never by a tool handler. */
export interface Asset extends AssetRecord {
  category?: AssetCategory;
  purchaseDate?: string | null;
  createdAt: string;
}

export const DOC_STATUSES = ["uploaded", "extracting", "needs_review", "active", "failed"] as const;
export type DocStatus = (typeof DOC_STATUSES)[number];

export interface Doc {
  id: string;
  s3Key: string;
  filename: string;
  docType: DocType;
  status: DocStatus;
  pages?: number;
  uploadedAt: string;
  assetIds: string[];
  /** Why extraction failed, in words the web app can show (for a rejected PDF: print or re-save it). Never document text. */
  failureReason?: string;
}

/** Typed terms from one document, or a voice-added subscription (then there is no docId). */
export interface Agreement extends AgreementLike {
  assetIds: string[];
  docId?: string;
  /** Plain values named as in SPEC section 4. */
  fields: Record<string, unknown>;
  /** One status per top-level field. Anything not listed counts as unconfirmed. */
  fieldStatus: Record<string, FieldStatus>;
  sourceRefs: Record<string, SourceRefTree>;
  createdAt: string;
}

export interface ObligationRecord {
  id: string;
  type: ObligationType;
  /** ISO date YYYY-MM-DD. */
  dueDate: string;
  agreementId?: string;
  assetId?: string;
  label: string;
  /** True only when every source field is confirmed or edited. Unconfirmed never alerts. */
  confirmed: boolean;
  severity: Severity | null;
}

export interface ServiceEvent {
  id: string;
  assetId: string;
  /** ISO timestamp. */
  ts: string;
  action: string;
  note?: string;
  source: "voice" | "web";
}

export const ALERT_STATUSES = ["pending", "announced", "done", "dismissed"] as const;

/** A thing to surface. Extends the digest input shape so the daily job can hand alerts straight to buildDigest. */
export interface Alert extends DigestAlert {
  /** The obligation id or the recall id this alert is about. */
  refId: string;
  assetId?: string;
  announcedAt?: string | null;
  /** Hidden until this ISO timestamp (snooze_7d). */
  snoozedUntil?: string | null;
  /**
   * Set to "stale" when the system closed the alert because its date changed (never when a person did). Such an alert
   * is reopened if the date changes back, a person's own dismissal never is. Optional, added after the contracts froze.
   */
  closedBy?: "stale";
}

/** A recall the person marked "not mine". Stops the same recall coming back for that asset. */
export interface Suppression {
  source: "cpsc" | "nhtsa";
  recallId: string;
  assetId: string;
  createdAt: string;
}

/** Pointer to the clause chunks of one document in S3, and which version of the household index they belong to. */
export interface ChunkMeta {
  docId: string;
  s3Key: string;
  indexVersion: number;
  chunkCount: number;
}

/** What it takes to undo the last voice write. */
export type UndoOp =
  | { type: "delete_asset"; assetId: string }
  | { type: "delete_agreement"; agreementId: string }
  | { type: "delete_event"; assetId: string; eventId: string };

export interface UndoRecord {
  ts: string;
  /** A short phrase to read back: "the gym membership you just added". */
  summary: string;
  inverse: UndoOp;
  /** Unix seconds. Records older than 24 hours are gone (DynamoDB TTL). */
  expiresAt: number;
}
