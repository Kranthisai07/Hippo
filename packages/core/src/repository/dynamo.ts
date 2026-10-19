import type { CreateTableCommandInput, TimeToLiveSpecification } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
  type QueryCommandInput,
} from "@aws-sdk/lib-dynamodb";
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
  GSI1,
  HOUSEHOLD_SK,
  PREFIX,
  TTL_ATTRIBUTE,
  alertGsi,
  obligationGsi,
  obligationRange,
  openAlertsGsiPk,
  pk,
  sk,
} from "./keys";
import {
  assertHouseholdId,
  byAlertOrder,
  byCreatedThenId,
  byDueThenId,
  byNameThenId,
  byTsDescThenId,
  byUploadedDescThenId,
  derivedFromDoc,
  s3KeysForDoc,
} from "./shared";

export { GSI1, TTL_ATTRIBUTE };

/** For CreateTable (add `TableName`) in tests and for the CDK table later. Pair it with `TTL_SPECIFICATION`. */
export const TABLE_DEFINITION: Omit<CreateTableCommandInput, "TableName"> = {
  AttributeDefinitions: [
    { AttributeName: "PK", AttributeType: "S" },
    { AttributeName: "SK", AttributeType: "S" },
    { AttributeName: "GSI1PK", AttributeType: "S" },
    { AttributeName: "GSI1SK", AttributeType: "S" },
  ],
  KeySchema: [
    { AttributeName: "PK", KeyType: "HASH" },
    { AttributeName: "SK", KeyType: "RANGE" },
  ],
  GlobalSecondaryIndexes: [
    {
      IndexName: GSI1,
      KeySchema: [
        { AttributeName: "GSI1PK", KeyType: "HASH" },
        { AttributeName: "GSI1SK", KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "ALL" },
    },
  ],
  BillingMode: "PAY_PER_REQUEST",
};

/** For UpdateTimeToLive (or the CDK `timeToLiveAttribute`). Undo records carry their expiry in this attribute. */
export const TTL_SPECIFICATION: TimeToLiveSpecification = { Enabled: true, AttributeName: TTL_ATTRIBUTE };

export interface DynamoRepositoryOptions {
  client: DynamoDBDocumentClient;
  tableName: string;
}

type Entity =
  "HOUSEHOLD" | "ASSET" | "DOC" | "AGREEMENT" | "OBLIGATION" | "EVENT" | "ALERT" | "SUPPRESS" | "CHUNKMETA" | "UNDO";

// The record is stored under `data`, so nothing the caller sends can overwrite a key attribute, and the household is
// only ever taken from the PK built from the first argument.
export interface Item {
  PK: string;
  SK: string;
  entity: Entity;
  data: unknown;
  GSI1PK?: string;
  GSI1SK?: string;
  ttl?: number;
}

type Key = { PK: string; SK: string };
type WriteRequest = { PutRequest: { Item: Item } } | { DeleteRequest: { Key: Key } };

/** DynamoDB rejects `undefined`. Drops it the way JSON would and keeps `null`. */
export function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripUndefined) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = stripUndefined(v);
    return out as T;
  }
  return value;
}

const BATCH = 25;
const MAX_RETRIES = 8;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createDynamoRepository({ client, tableName }: DynamoRepositoryOptions): Repository {
  const item = (
    householdId: string,
    entity: Entity,
    skValue: string,
    data: unknown,
    extra: Partial<Item> = {},
  ): Item => ({
    PK: pk(householdId),
    SK: skValue,
    entity,
    data: stripUndefined(data),
    ...extra,
  });

  const put = async (i: Item): Promise<void> => {
    await client.send(new PutCommand({ TableName: tableName, Item: i }));
  };

  const get = async <T>(householdId: string, skValue: string): Promise<T | null> => {
    assertHouseholdId(householdId);
    const out = await client.send(
      new GetCommand({ TableName: tableName, Key: { PK: pk(householdId), SK: skValue }, ConsistentRead: true }),
    );
    return out.Item ? (out.Item.data as T) : null;
  };

  const remove = async (householdId: string, skValue: string): Promise<void> => {
    assertHouseholdId(householdId);
    await client.send(new DeleteCommand({ TableName: tableName, Key: { PK: pk(householdId), SK: skValue } }));
  };

  async function queryAll(input: Omit<QueryCommandInput, "TableName">): Promise<Item[]> {
    const items: Item[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const out = await client.send(new QueryCommand({ TableName: tableName, ExclusiveStartKey: start, ...input }));
      items.push(...((out.Items ?? []) as Item[]));
      start = out.LastEvaluatedKey;
    } while (start);
    return items;
  }

  /** Everything of one kind in the household partition. Base-table reads are strongly consistent. */
  const listPrefix = async (householdId: string, prefix: string): Promise<Item[]> => {
    assertHouseholdId(householdId);
    return queryAll({
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :p)",
      ExpressionAttributeValues: { ":pk": pk(householdId), ":p": prefix },
      ConsistentRead: true,
    });
  };

  const listData = async <T>(householdId: string, prefix: string): Promise<T[]> =>
    (await listPrefix(householdId, prefix)).map((i) => i.data as T);

  const puts = (items: Item[]): WriteRequest[] => items.map((Item) => ({ PutRequest: { Item } }));
  const deletes = (keys: Key[]): WriteRequest[] =>
    keys.map((k) => ({ DeleteRequest: { Key: { PK: k.PK, SK: k.SK } } }));

  async function batchWrite(requests: WriteRequest[]): Promise<void> {
    for (let i = 0; i < requests.length; i += BATCH) {
      let pending = requests.slice(i, i + BATCH);
      for (let attempt = 0; pending.length > 0; attempt++) {
        if (attempt > MAX_RETRIES) throw new Error("DynamoDB batch write left unprocessed items after retries");
        if (attempt > 0) await sleep(25 * 2 ** attempt);
        const out = await client.send(new BatchWriteCommand({ RequestItems: { [tableName]: pending } }));
        pending = (out.UnprocessedItems?.[tableName] ?? []) as WriteRequest[];
      }
    }
  }

  return {
    getHousehold: (householdId) => get<Household>(householdId, HOUSEHOLD_SK),
    async putHousehold(householdId, household) {
      assertHouseholdId(householdId);
      await put(item(householdId, "HOUSEHOLD", HOUSEHOLD_SK, household));
    },

    async putAsset(householdId, asset) {
      assertHouseholdId(householdId);
      await put(item(householdId, "ASSET", sk.asset(asset.id), asset));
    },
    getAsset: (householdId, assetId) => get<Asset>(householdId, sk.asset(assetId)),
    async listAssets(householdId) {
      return (await listData<Asset>(householdId, PREFIX.asset)).sort(byNameThenId);
    },
    deleteAsset: (householdId, assetId) => remove(householdId, sk.asset(assetId)),

    async putDoc(householdId, doc) {
      assertHouseholdId(householdId);
      await put(item(householdId, "DOC", sk.doc(doc.id), doc));
    },
    getDoc: (householdId, docId) => get<Doc>(householdId, sk.doc(docId)),
    async listDocs(householdId, filter) {
      const docs = await listData<Doc>(householdId, PREFIX.doc);
      return docs.filter((d) => !filter?.status || d.status === filter.status).sort(byUploadedDescThenId);
    },

    async putAgreement(householdId, agreement) {
      assertHouseholdId(householdId);
      await put(item(householdId, "AGREEMENT", sk.agreement(agreement.id), agreement));
    },
    getAgreement: (householdId, agreementId) => get<Agreement>(householdId, sk.agreement(agreementId)),
    async listAgreements(householdId, filter) {
      const list = await listData<Agreement>(householdId, PREFIX.agreement);
      return list
        .filter(
          (a) =>
            (filter?.docId === undefined || a.docId === filter.docId) &&
            (filter?.assetId === undefined || a.assetIds.includes(filter.assetId)),
        )
        .sort(byCreatedThenId);
    },
    deleteAgreement: (householdId, agreementId) => remove(householdId, sk.agreement(agreementId)),

    async replaceObligations(householdId, agreementId, obligations) {
      assertHouseholdId(householdId);
      const existing = await listPrefix(householdId, PREFIX.obligation);
      const fresh = new Map<string, Item>();
      for (const o of obligations) {
        const i = item(householdId, "OBLIGATION", sk.obligation(o.dueDate, o.id), o, obligationGsi(householdId, o));
        fresh.set(i.SK, i);
      }
      // New set first, then whatever is left of the old one, so a reader never sees a gap. Not atomic: the daily job
      // recomputes the set, so a half-finished replace is repaired by the next run.
      await batchWrite(puts([...fresh.values()]));
      const stale = existing.filter(
        (i) => ((i.data as ObligationRecord).agreementId ?? null) === agreementId && !fresh.has(i.SK),
      );
      await batchWrite(deletes(stale));
    },
    async listObligations(householdId, range) {
      assertHouseholdId(householdId);
      if (range.from > range.to) return [];
      const { lo, hi } = obligationRange(range.from, range.to);
      const items = await queryAll({
        KeyConditionExpression: "PK = :pk AND SK BETWEEN :lo AND :hi",
        ExpressionAttributeValues: { ":pk": pk(householdId), ":lo": lo, ":hi": hi },
        ConsistentRead: true,
      });
      return items
        .map((i) => i.data as ObligationRecord)
        .filter((o) => o.dueDate >= range.from && o.dueDate <= range.to)
        .sort(byDueThenId);
    },

    async addEvent(householdId, event) {
      assertHouseholdId(householdId);
      await put(item(householdId, "EVENT", sk.event(event.assetId, event.ts, event.id), event));
    },
    async deleteEvent(householdId, assetId, eventId) {
      const items = await listPrefix(householdId, sk.eventPrefix(assetId));
      const hits = items.filter((i) => (i.data as ServiceEvent).id === eventId);
      if (hits.length > 0) await batchWrite(deletes(hits));
    },
    async listEvents(householdId, assetId, limit) {
      const events = await listData<ServiceEvent>(householdId, sk.eventPrefix(assetId));
      return events.sort(byTsDescThenId).slice(0, Math.max(0, limit));
    },

    async putAlert(householdId, alert) {
      assertHouseholdId(householdId);
      await put(item(householdId, "ALERT", sk.alert(alert.id), alert, alertGsi(householdId, alert) ?? {}));
    },
    getAlert: (householdId, alertId) => get<Alert>(householdId, sk.alert(alertId)),
    async listAlerts(householdId, filter) {
      assertHouseholdId(householdId);
      if (!filter?.open) return (await listData<Alert>(householdId, PREFIX.alert)).sort(byAlertOrder);
      // A GSI cannot be read strongly consistently, so an alert written a moment ago may be missing here briefly.
      const items = await queryAll({
        IndexName: GSI1,
        KeyConditionExpression: "GSI1PK = :g",
        ExpressionAttributeValues: { ":g": openAlertsGsiPk(householdId) },
      });
      return items.map((i) => i.data as Alert).sort(byAlertOrder);
    },

    async addSuppression(householdId, s) {
      assertHouseholdId(householdId);
      await put(item(householdId, "SUPPRESS", sk.suppress(s.source, s.recallId, s.assetId), s));
    },
    listSuppressions: (householdId) => listData<Suppression>(householdId, PREFIX.suppress),

    async putChunkMeta(householdId, meta) {
      assertHouseholdId(householdId);
      await put(item(householdId, "CHUNKMETA", sk.chunkMeta(meta.docId), meta));
    },
    getChunkMeta: (householdId, docId) => get<ChunkMeta>(householdId, sk.chunkMeta(docId)),

    async pushUndo(householdId, record) {
      assertHouseholdId(householdId);
      await put(item(householdId, "UNDO", sk.undo(record.ts), record, { [TTL_ATTRIBUTE]: record.expiresAt }));
    },
    async popUndo(householdId, nowSeconds) {
      assertHouseholdId(householdId);
      // DynamoDB TTL deletes lazily (up to about two days late), so expiry is checked here as well.
      const items = await queryAll({
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :p)",
        ExpressionAttributeValues: { ":pk": pk(householdId), ":p": PREFIX.undo },
        ScanIndexForward: false,
        ConsistentRead: true,
      });
      for (const i of items) {
        if ((i.data as UndoRecord).expiresAt <= nowSeconds) continue;
        try {
          // Conditional, so two callers racing for the same record cannot both get it.
          await client.send(
            new DeleteCommand({
              TableName: tableName,
              Key: { PK: i.PK, SK: i.SK },
              ConditionExpression: "attribute_exists(PK)",
            }),
          );
          return i.data as UndoRecord;
        } catch (err) {
          if ((err as { name?: string }).name === "ConditionalCheckFailedException") continue;
          throw err;
        }
      }
      return null;
    },

    async deleteDocumentCascade(householdId, docId) {
      assertHouseholdId(householdId);
      const doc = await get<Doc>(householdId, sk.doc(docId));
      if (!doc) return { s3Keys: [] };
      const [chunk, agreementItems, obligationItems, alertItems] = await Promise.all([
        get<ChunkMeta>(householdId, sk.chunkMeta(docId)),
        listPrefix(householdId, PREFIX.agreement),
        listPrefix(householdId, PREFIX.obligation),
        listPrefix(householdId, PREFIX.alert),
      ]);
      const derived = derivedFromDoc(
        docId,
        agreementItems.map((i) => i.data as Agreement),
        obligationItems.map((i) => i.data as ObligationRecord),
        alertItems.map((i) => i.data as Alert),
      );
      const agreementSet = new Set(derived.agreementIds);
      const obligationSet = new Set(derived.obligationIds);
      const alertSet = new Set(derived.alertIds);
      const keys: Key[] = [
        ...alertItems.filter((i) => alertSet.has((i.data as Alert).id)),
        ...obligationItems.filter((i) => obligationSet.has((i.data as ObligationRecord).id)),
        ...agreementItems.filter((i) => agreementSet.has((i.data as Agreement).id)),
        { PK: pk(householdId), SK: sk.chunkMeta(docId) },
        // The doc goes last: if a batch fails part way the doc is still there, so the cascade can simply be run again.
        { PK: pk(householdId), SK: sk.doc(docId) },
      ];
      await batchWrite(deletes(keys));
      return { s3Keys: s3KeysForDoc(householdId, doc, chunk?.s3Key) };
    },

    async deleteHousehold(householdId) {
      assertHouseholdId(householdId);
      const items = await queryAll({
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": pk(householdId) },
        ConsistentRead: true,
      });
      const chunkByDoc = new Map<string, string>();
      for (const i of items) {
        if (i.entity === "CHUNKMETA") chunkByDoc.set((i.data as ChunkMeta).docId, (i.data as ChunkMeta).s3Key);
      }
      const keys = new Set<string>(chunkByDoc.values());
      for (const i of items) {
        if (i.entity !== "DOC") continue;
        const doc = i.data as Doc;
        for (const k of s3KeysForDoc(householdId, doc, chunkByDoc.get(doc.id))) keys.add(k);
      }
      await batchWrite(deletes(items));
      return { s3Keys: [...keys].sort() };
    },
  };
}
