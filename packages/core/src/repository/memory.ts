import type {
  Agreement,
  Alert,
  Asset,
  ChunkMeta,
  Doc,
  Household,
  ObligationRecord,
  Repository,
  ServiceEvent,
  Suppression,
  UndoRecord,
} from "../contracts";
import {
  assertHouseholdId,
  byAlertOrder,
  byCreatedThenId,
  byDueThenId,
  byNameThenId,
  byTsDescThenId,
  byUploadedDescThenId,
  derivedFromDoc,
  isOpenAlert,
  s3KeysForDoc,
} from "./shared";

// Plain Maps keyed by household, then id. Used by tests and by the voice path when no table is configured. It imports
// nothing from the AWS SDK. Every value is copied on the way in and on the way out so a caller cannot change stored state.

interface Store {
  household: Household | null;
  assets: Map<string, Asset>;
  docs: Map<string, Doc>;
  agreements: Map<string, Agreement>;
  obligations: Map<string, ObligationRecord>;
  events: Map<string, ServiceEvent>;
  alerts: Map<string, Alert>;
  suppressions: Map<string, Suppression>;
  chunkMetas: Map<string, ChunkMeta>;
  undo: Map<string, UndoRecord>;
}

const emptyStore = (): Store => ({
  household: null,
  assets: new Map(),
  docs: new Map(),
  agreements: new Map(),
  obligations: new Map(),
  events: new Map(),
  alerts: new Map(),
  suppressions: new Map(),
  chunkMetas: new Map(),
  undo: new Map(),
});

const copy = <T>(value: T): T => structuredClone(value);
const copies = <T>(values: Iterable<T>): T[] => [...values].map(copy);
// JSON arrays make composite keys that cannot collide whatever characters the parts contain.
const compositeKey = (...parts: string[]): string => JSON.stringify(parts);

export function createMemoryRepository(): Repository {
  const households = new Map<string, Store>();

  const read = (householdId: string): Store => {
    assertHouseholdId(householdId);
    return households.get(householdId) ?? emptyStore();
  };
  const write = (householdId: string): Store => {
    assertHouseholdId(householdId);
    let store = households.get(householdId);
    if (!store) {
      store = emptyStore();
      households.set(householdId, store);
    }
    return store;
  };

  return {
    async getHousehold(householdId) {
      const h = read(householdId).household;
      return h ? copy(h) : null;
    },
    async putHousehold(householdId, household) {
      write(householdId).household = copy(household);
    },

    async putAsset(householdId, asset) {
      write(householdId).assets.set(asset.id, copy(asset));
    },
    async getAsset(householdId, assetId) {
      const a = read(householdId).assets.get(assetId);
      return a ? copy(a) : null;
    },
    async listAssets(householdId) {
      return copies([...read(householdId).assets.values()].sort(byNameThenId));
    },
    async deleteAsset(householdId, assetId) {
      read(householdId).assets.delete(assetId);
    },

    async putDoc(householdId, doc) {
      write(householdId).docs.set(doc.id, copy(doc));
    },
    async getDoc(householdId, docId) {
      const d = read(householdId).docs.get(docId);
      return d ? copy(d) : null;
    },
    async listDocs(householdId, filter) {
      const docs = [...read(householdId).docs.values()].filter((d) => !filter?.status || d.status === filter.status);
      return copies(docs.sort(byUploadedDescThenId));
    },

    async putAgreement(householdId, agreement) {
      write(householdId).agreements.set(agreement.id, copy(agreement));
    },
    async getAgreement(householdId, agreementId) {
      const a = read(householdId).agreements.get(agreementId);
      return a ? copy(a) : null;
    },
    async listAgreements(householdId, filter) {
      const list = [...read(householdId).agreements.values()].filter(
        (a) =>
          (filter?.docId === undefined || a.docId === filter.docId) &&
          (filter?.assetId === undefined || a.assetIds.includes(filter.assetId)),
      );
      return copies(list.sort(byCreatedThenId));
    },
    async deleteAgreement(householdId, agreementId) {
      read(householdId).agreements.delete(agreementId);
    },

    async replaceObligations(householdId, agreementId, obligations) {
      const store = write(householdId);
      for (const [key, o] of store.obligations) {
        if ((o.agreementId ?? null) === agreementId) store.obligations.delete(key);
      }
      for (const o of obligations) store.obligations.set(compositeKey(o.dueDate, o.id), copy(o));
    },
    async listObligations(householdId, range) {
      const list = [...read(householdId).obligations.values()].filter(
        (o) => o.dueDate >= range.from && o.dueDate <= range.to,
      );
      return copies(list.sort(byDueThenId));
    },

    async addEvent(householdId, event) {
      write(householdId).events.set(compositeKey(event.assetId, event.ts, event.id), copy(event));
    },
    async deleteEvent(householdId, assetId, eventId) {
      const events = read(householdId).events;
      for (const [key, e] of events) if (e.assetId === assetId && e.id === eventId) events.delete(key);
    },
    async listEvents(householdId, assetId, limit) {
      const list = [...read(householdId).events.values()].filter((e) => e.assetId === assetId);
      return copies(list.sort(byTsDescThenId).slice(0, Math.max(0, limit)));
    },

    async putAlert(householdId, alert) {
      write(householdId).alerts.set(alert.id, copy(alert));
    },
    async getAlert(householdId, alertId) {
      const a = read(householdId).alerts.get(alertId);
      return a ? copy(a) : null;
    },
    async listAlerts(householdId, filter) {
      const list = [...read(householdId).alerts.values()].filter((a) => !filter?.open || isOpenAlert(a));
      return copies(list.sort(byAlertOrder));
    },

    async addSuppression(householdId, s) {
      write(householdId).suppressions.set(compositeKey(s.source, s.recallId, s.assetId), copy(s));
    },
    async listSuppressions(householdId) {
      return copies(read(householdId).suppressions.values());
    },

    async putChunkMeta(householdId, meta) {
      write(householdId).chunkMetas.set(meta.docId, copy(meta));
    },
    async getChunkMeta(householdId, docId) {
      const m = read(householdId).chunkMetas.get(docId);
      return m ? copy(m) : null;
    },

    async pushUndo(householdId, record) {
      write(householdId).undo.set(record.ts, copy(record));
    },
    async popUndo(householdId, nowSeconds) {
      const undo = read(householdId).undo;
      const newest = [...undo.values()]
        .filter((r) => r.expiresAt > nowSeconds)
        .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))[0];
      if (!newest) return null;
      undo.delete(newest.ts);
      return copy(newest);
    },

    async deleteDocumentCascade(householdId, docId) {
      const store = read(householdId);
      const doc = store.docs.get(docId);
      if (!doc) return { s3Keys: [] };
      const derived = derivedFromDoc(
        docId,
        [...store.agreements.values()],
        [...store.obligations.values()],
        [...store.alerts.values()],
      );
      const s3Keys = s3KeysForDoc(householdId, doc, store.chunkMetas.get(docId)?.s3Key);
      for (const id of derived.alertIds) store.alerts.delete(id);
      const gone = new Set(derived.obligationIds);
      for (const [key, o] of store.obligations) if (gone.has(o.id)) store.obligations.delete(key);
      for (const id of derived.agreementIds) store.agreements.delete(id);
      store.chunkMetas.delete(docId);
      store.docs.delete(docId);
      return { s3Keys };
    },

    async deleteHousehold(householdId) {
      const store = read(householdId);
      const keys = new Set<string>();
      for (const doc of store.docs.values()) {
        for (const k of s3KeysForDoc(householdId, doc, store.chunkMetas.get(doc.id)?.s3Key)) keys.add(k);
      }
      for (const meta of store.chunkMetas.values()) keys.add(meta.s3Key);
      households.delete(householdId);
      return { s3Keys: [...keys].sort() };
    },
  };
}
