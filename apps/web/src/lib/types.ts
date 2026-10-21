// Shapes of docs/WEB_API.md. Written out here (type only) so the browser bundle never imports server packages.
// Every string that came from a document is untrusted text: render it as text only.

export type DocStatus = "uploaded" | "extracting" | "needs_review" | "active" | "failed";
export type FieldStatus = "extracted" | "confirmed" | "edited";
export type AgreementKind = "warranty" | "insurance" | "lease" | "subscription" | "service_plan";
export type ObligationType =
  "expires" | "renews" | "notice_by" | "charge" | "cancel_by" | "trial_end" | "service_due" | "claim_by";

export interface Doc {
  id: string;
  filename: string;
  docType: string;
  status: DocStatus;
  pages?: number;
  uploadedAt: string;
  assetIds: string[];
  failureReason?: string;
}

export interface SourceRef {
  page: number;
  quote: string;
}
export type SourceRefTree = SourceRef | SourceRef[] | { [part: string]: SourceRef };

export interface FieldView {
  name: string;
  value: unknown;
  status: FieldStatus;
  sourceRef: SourceRefTree | null;
  isDate: boolean;
}

export interface AgreementView {
  id: string;
  kind: AgreementKind;
  fields: FieldView[];
}

export interface DocDetail {
  doc: Doc;
  agreement: AgreementView | null;
}

export interface ObligationRecord {
  id: string;
  type: ObligationType;
  dueDate: string;
  agreementId?: string;
  assetId?: string;
  label: string;
  confirmed: boolean;
  severity: "high" | "possible" | null;
}

export interface ObligationItem {
  obligation: ObligationRecord;
  needsConfirmation: boolean;
  docId?: string;
  assetId?: string;
}

export type AlertAction = "done" | "dismiss" | "not_mine" | "snooze_7d";

export interface Alert {
  id: string;
  source: "deadline" | "recall";
  severity: "high" | "possible";
  status: "pending" | "announced" | "done" | "dismissed";
  label: string;
  dueDate?: string | null;
  detail?: string;
  refId: string;
  assetId?: string;
  snoozedUntil?: string | null;
}

export interface Asset {
  id: string;
  name: string;
  brand?: string;
  category?: string;
  location?: string;
  modelNumber?: string | null;
  serialLast4?: string | null;
  vehicle?: { make: string; model: string; modelYear: number } | null;
  purchaseDate?: string | null;
}

export interface ServiceEvent {
  id: string;
  assetId: string;
  ts: string;
  action: string;
  note?: string;
  source: "voice" | "web";
}

export interface UploadTicket {
  docId: string;
  upload: { method: "PUT"; url: string; headers: Record<string, string>; expiresInSeconds: number };
}

export interface Me {
  email: string;
  digestOn: boolean;
  /** Not sent by the API today. Used when it is (docs/WEB_API.md has no server date). */
  today?: string;
}
