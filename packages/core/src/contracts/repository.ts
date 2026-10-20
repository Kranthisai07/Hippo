import type {
  Agreement,
  Alert,
  Asset,
  ChunkMeta,
  Doc,
  DocStatus,
  Household,
  ObligationRecord,
  ServiceEvent,
  Suppression,
  UndoRecord,
} from "./entities";

/**
 * Every method takes the household id first. It comes from the verified auth token, never from a tool argument or a
 * request body (INTENT principle 7, CLAUDE.md hard rule). An implementation must make household A unable to read,
 * list, change or delete anything of household B, including by guessing an id.
 *
 * Writes replace by id (put). Reads of a missing id return null, never throw. Lists are ordered as documented.
 */
export interface Repository {
  // Household settings
  getHousehold(householdId: string): Promise<Household | null>;
  putHousehold(householdId: string, household: Household): Promise<void>;

  // Assets
  putAsset(householdId: string, asset: Asset): Promise<void>;
  getAsset(householdId: string, assetId: string): Promise<Asset | null>;
  /** Ordered by name, then id. */
  listAssets(householdId: string): Promise<Asset[]>;
  deleteAsset(householdId: string, assetId: string): Promise<void>;

  // Documents
  putDoc(householdId: string, doc: Doc): Promise<void>;
  getDoc(householdId: string, docId: string): Promise<Doc | null>;
  /** Newest upload first, then id. */
  listDocs(householdId: string, filter?: { status?: DocStatus }): Promise<Doc[]>;

  // Agreements
  putAgreement(householdId: string, agreement: Agreement): Promise<void>;
  getAgreement(householdId: string, agreementId: string): Promise<Agreement | null>;
  /** Ordered by creation time, then id. */
  listAgreements(householdId: string, filter?: { docId?: string; assetId?: string }): Promise<Agreement[]>;
  deleteAgreement(householdId: string, agreementId: string): Promise<void>;

  // Obligations (recomputed by the daily job, so replaced as a set)
  /** Replaces every obligation of the given agreement, or every obligation with no agreement when `agreementId` is null. */
  replaceObligations(householdId: string, agreementId: string | null, obligations: ObligationRecord[]): Promise<void>;
  /** Due between `from` and `to` inclusive (ISO dates), ordered by due date then id. */
  listObligations(householdId: string, range: { from: string; to: string }): Promise<ObligationRecord[]>;

  // Service history
  addEvent(householdId: string, event: ServiceEvent): Promise<void>;
  deleteEvent(householdId: string, assetId: string, eventId: string): Promise<void>;
  /** Newest first, at most `limit`. */
  listEvents(householdId: string, assetId: string, limit: number): Promise<ServiceEvent[]>;

  // Alerts
  putAlert(householdId: string, alert: Alert): Promise<void>;
  getAlert(householdId: string, alertId: string): Promise<Alert | null>;
  /** Open alerts are pending or announced. Ordered by severity (high first), then due date, then id. */
  listAlerts(householdId: string, filter?: { open?: boolean }): Promise<Alert[]>;

  // Recall suppressions
  addSuppression(householdId: string, suppression: Suppression): Promise<void>;
  listSuppressions(householdId: string): Promise<Suppression[]>;

  // Clause index pointers
  putChunkMeta(householdId: string, meta: ChunkMeta): Promise<void>;
  getChunkMeta(householdId: string, docId: string): Promise<ChunkMeta | null>;

  // Undo of the last voice write
  pushUndo(householdId: string, record: UndoRecord): Promise<void>;
  /** Removes and returns the newest record that has not expired as of `nowSeconds`, or null. */
  popUndo(householdId: string, nowSeconds: number): Promise<UndoRecord | null>;

  /**
   * Delete document: removes the doc, its agreement, the obligations and alerts derived from it and its chunk pointer,
   * then returns the S3 keys the caller must delete (original file, page text, chunks). The caller rebuilds the index.
   * Returns no keys when the document does not exist in this household.
   */
  deleteDocumentCascade(householdId: string, docId: string): Promise<{ s3Keys: string[] }>;

  /** Delete all data: everything under the household. Returns the S3 keys to delete. */
  deleteHousehold(householdId: string): Promise<{ s3Keys: string[] }>;
}
