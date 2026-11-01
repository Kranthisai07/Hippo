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
import type { Repository } from "../contracts";
import { createItemRepository, type Item, type ItemClient, type WriteRequest } from "./items";
import { GSI1, TTL_ATTRIBUTE } from "./keys";

// The DynamoDB side of the repository. The repository logic itself lives in items.ts and is shared with D1 (d1.ts), so
// a Workers build can import items.ts and d1.ts without pulling in the AWS SDK that this file needs.

export { GSI1, TTL_ATTRIBUTE };
export { stripUndefined } from "./items";

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

const BATCH = 25;
const MAX_RETRIES = 8;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createDynamoItemClient({ client, tableName }: DynamoRepositoryOptions): ItemClient {
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

  return {
    async put(item) {
      await client.send(new PutCommand({ TableName: tableName, Item: item }));
    },
    async get(pk, sk) {
      const out = await client.send(
        new GetCommand({ TableName: tableName, Key: { PK: pk, SK: sk }, ConsistentRead: true }),
      );
      return (out.Item as Item | undefined) ?? null;
    },
    async delete(pk, sk) {
      await client.send(new DeleteCommand({ TableName: tableName, Key: { PK: pk, SK: sk } }));
    },
    async deleteIfExists(pk, sk) {
      try {
        await client.send(
          new DeleteCommand({
            TableName: tableName,
            Key: { PK: pk, SK: sk },
            ConditionExpression: "attribute_exists(PK)",
          }),
        );
        return true;
      } catch (err) {
        if ((err as { name?: string }).name === "ConditionalCheckFailedException") return false;
        throw err;
      }
    },
    query({ index, hash, range, descending }) {
      const hashName = index ? "GSI1PK" : "PK";
      const rangeName = index ? "GSI1SK" : "SK";
      const values: Record<string, string> = { [index ? ":g" : ":pk"]: hash };
      let condition = `${hashName} = ${index ? ":g" : ":pk"}`;
      if (range && "beginsWith" in range) {
        condition += ` AND begins_with(${rangeName}, :p)`;
        values[":p"] = range.beginsWith;
      } else if (range) {
        condition += ` AND ${rangeName} BETWEEN :lo AND :hi`;
        [values[":lo"], values[":hi"]] = range.between as [string, string];
      }
      return queryAll({
        ...(index ? { IndexName: index } : {}),
        KeyConditionExpression: condition,
        ExpressionAttributeValues: values,
        // A GSI cannot be read strongly consistently, so an alert written a moment ago may be missing there briefly.
        ...(index ? {} : { ConsistentRead: true }),
        ...(descending ? { ScanIndexForward: false } : {}),
      });
    },
    async write(requests) {
      for (let i = 0; i < requests.length; i += BATCH) {
        let pending = requests.slice(i, i + BATCH);
        for (let attempt = 0; pending.length > 0; attempt++) {
          if (attempt > MAX_RETRIES) throw new Error("DynamoDB batch write left unprocessed items after retries");
          if (attempt > 0) await sleep(25 * 2 ** attempt);
          const out = await client.send(new BatchWriteCommand({ RequestItems: { [tableName]: pending } }));
          pending = (out.UnprocessedItems?.[tableName] ?? []) as WriteRequest[];
        }
      }
    },
  };
}

export const createDynamoRepository = (options: DynamoRepositoryOptions): Repository =>
  createItemRepository(createDynamoItemClient(options));
