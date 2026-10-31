import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

// A small in-process stand-in for the DynamoDB document client. It is NOT DynamoDB: it understands only the request
// shapes dynamo.ts sends. It exists so the Dynamo repository's own logic (keys, escaping, GSI, TTL, cascade, paging,
// batching) runs against the shared suite on a machine with no Docker. It is deliberately stricter than the real
// service in two places: it refuses `undefined` values, and it pages queries and leaves batch items unprocessed, so the
// retry and pagination code is exercised.

type Row = Record<string, unknown> & { PK: string; SK: string; GSI1PK?: string; GSI1SK?: string };
interface Cmd {
  constructor: { name: string };
  input: Record<string, any>;
}

const PAGE = 7;

function assertNoUndefined(value: unknown, path = "item"): void {
  if (value === undefined) throw Object.assign(new Error(`undefined at ${path}`), { name: "ValidationException" });
  if (Array.isArray(value)) value.forEach((v, i) => assertNoUndefined(v, `${path}[${i}]`));
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) assertNoUndefined(v, `${path}.${k}`);
  }
}

export interface FakeDynamo {
  client: DynamoDBDocumentClient;
  rows: Map<string, Row>;
  sent: Cmd[];
}

export function createFakeDynamo(): FakeDynamo {
  const rows = new Map<string, Row>();
  const sent: Cmd[] = [];
  let batches = 0;
  const id = (pk: string, sk: string) => `${pk}\u0000${sk}`;

  const send = async (command: Cmd): Promise<Record<string, unknown>> => {
    sent.push(command);
    const input = command.input;
    switch (command.constructor.name) {
      case "PutCommand": {
        assertNoUndefined(input.Item);
        const row = structuredClone(input.Item) as Row;
        rows.set(id(row.PK, row.SK), row);
        return {};
      }
      case "GetCommand": {
        if (input.ConsistentRead !== true) throw new Error("fake: a base table read must be strongly consistent");
        const row = rows.get(id(input.Key.PK, input.Key.SK));
        return { Item: row ? structuredClone(row) : undefined };
      }
      case "DeleteCommand": {
        const key = id(input.Key.PK, input.Key.SK);
        if (input.ConditionExpression === "attribute_exists(PK)" && !rows.has(key)) {
          throw Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });
        }
        rows.delete(key);
        return {};
      }
      case "BatchWriteCommand": {
        const requests = Object.values(input.RequestItems)[0] as any[];
        if (requests.length > 25) throw Object.assign(new Error("Too many items"), { name: "ValidationException" });
        const seen = new Set<string>();
        for (const r of requests) {
          const key = r.PutRequest
            ? id(r.PutRequest.Item.PK, r.PutRequest.Item.SK)
            : id(r.DeleteRequest.Key.PK, r.DeleteRequest.Key.SK);
          if (seen.has(key))
            throw Object.assign(new Error("Provided list of item keys contains duplicates"), {
              name: "ValidationException",
            });
          seen.add(key);
        }
        // Every fifth batch leaves its first request unprocessed once, like a throttled table.
        const leave = batches++ % 5 === 0 && requests.length > 1 ? requests.slice(0, 1) : [];
        for (const r of requests.slice(leave.length)) {
          if (r.PutRequest) {
            assertNoUndefined(r.PutRequest.Item);
            rows.set(id(r.PutRequest.Item.PK, r.PutRequest.Item.SK), structuredClone(r.PutRequest.Item));
          } else rows.delete(id(r.DeleteRequest.Key.PK, r.DeleteRequest.Key.SK));
        }
        const table = Object.keys(input.RequestItems)[0]!;
        return { UnprocessedItems: leave.length ? { [table]: leave } : {} };
      }
      case "QueryCommand":
        return query(input);
      default:
        throw new Error(`fake: unsupported command ${command.constructor.name}`);
    }
  };

  function query(input: Record<string, any>): Record<string, unknown> {
    const v = input.ExpressionAttributeValues as Record<string, string>;
    const expr = input.KeyConditionExpression as string;
    const onIndex = input.IndexName === "GSI1";
    if (input.IndexName && !onIndex) throw new Error("fake: unknown index");
    if (onIndex && input.ConsistentRead)
      throw Object.assign(new Error("Consistent reads are not supported on GSIs"), { name: "ValidationException" });
    if (!onIndex && input.ConsistentRead !== true)
      throw new Error("fake: a base table read must be strongly consistent");
    const hashName = onIndex ? "GSI1PK" : "PK";
    const rangeName = onIndex ? "GSI1SK" : "SK";
    const hashValue = onIndex ? v[":g"] : v[":pk"];
    let list = [...rows.values()].filter((r) => r[hashName] === hashValue && typeof r[rangeName] === "string");
    if (expr.includes("begins_with")) list = list.filter((r) => (r[rangeName] as string).startsWith(v[":p"]!));
    else if (expr.includes("BETWEEN")) {
      if (v[":lo"]! > v[":hi"]!)
        throw Object.assign(new Error("Invalid KeyConditionExpression: lower bound above upper"), {
          name: "ValidationException",
        });
      list = list.filter((r) => (r[rangeName] as string) >= v[":lo"]! && (r[rangeName] as string) <= v[":hi"]!);
    }
    list.sort((a, b) =>
      (a[rangeName] as string) < (b[rangeName] as string) ? -1 : a[rangeName] === b[rangeName] ? 0 : 1,
    );
    if (input.ScanIndexForward === false) list.reverse();
    const start = input.ExclusiveStartKey ? Number((input.ExclusiveStartKey as { n: number }).n) : 0;
    const page = list.slice(start, start + PAGE);
    const more = start + PAGE < list.length;
    return { Items: page.map((r) => structuredClone(r)), LastEvaluatedKey: more ? { n: start + PAGE } : undefined };
  }

  return { client: { send } as unknown as DynamoDBDocumentClient, rows, sent };
}
