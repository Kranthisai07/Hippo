import {
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";

// Answers the five DynamoDB requests dynamo.ts sends (Put, Get, Delete, BatchWrite, Query) with SQL on Cloudflare D1,
// so createDynamoRepository runs on D1 unchanged and the shared repository suite proves it. Schema:
// apps/edge/migrations/0001_items.sql. Anything else dynamo.ts might send later is refused loudly, never guessed.

/** The part of a D1 database binding this file uses. */
export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  all(): Promise<{ results?: unknown[] }>;
}
export interface D1Like {
  prepare(sql: string): D1Statement;
  /** All statements in one transaction: they all apply or none does. */
  batch(statements: D1Statement[]): Promise<{ results?: unknown[] }[]>;
}

export const D1_PAGE_SIZE = 100;

type Row = { PK: string; SK: string; GSI1PK?: string; GSI1SK?: string };
type Write = { PutRequest: { Item: Row } } | { DeleteRequest: { Key: Row } };
type Input = Record<string, any>;

const conditionFailed = (): Error =>
  Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });
const refuse = (what: string): Error => Object.assign(new Error(`d1: ${what}`), { name: "ValidationException" });

export function createD1DocumentClient(db: D1Like, opts: { pageSize?: number } = {}): DynamoDBDocumentClient {
  const pageSize = opts.pageSize ?? D1_PAGE_SIZE;
  const rows = async (sql: string, ...values: unknown[]): Promise<Record<string, unknown>[]> =>
    ((
      await db
        .prepare(sql)
        .bind(...values)
        .all()
    ).results ?? []) as Record<string, unknown>[];

  const upsert = (item: Row): D1Statement =>
    db
      .prepare("INSERT OR REPLACE INTO items (pk, sk, gsi1pk, gsi1sk, item) VALUES (?, ?, ?, ?, ?)")
      .bind(item.PK, item.SK, item.GSI1PK ?? null, item.GSI1SK ?? null, JSON.stringify(item));
  const remove = (key: Row): D1Statement =>
    db.prepare("DELETE FROM items WHERE pk = ? AND sk = ?").bind(key.PK, key.SK);

  async function get(input: Input) {
    const [r] = await rows("SELECT item FROM items WHERE pk = ? AND sk = ?", input.Key.PK, input.Key.SK);
    return r ? { Item: JSON.parse(r.item as string) } : {};
  }

  async function del(input: Input) {
    if (input.ConditionExpression === undefined) {
      await remove(input.Key).all();
      return {};
    }
    if (input.ConditionExpression !== "attribute_exists(PK)") throw refuse("unsupported condition");
    // The look and the delete are one transaction, so two callers racing for one row cannot both win.
    const [seen] = await db.batch([
      db.prepare("SELECT 1 AS present FROM items WHERE pk = ? AND sk = ?").bind(input.Key.PK, input.Key.SK),
      remove(input.Key),
    ]);
    if (!seen?.results?.length) throw conditionFailed();
    return {};
  }

  async function batchWrite(input: Input) {
    const requests = Object.values(input.RequestItems as Record<string, Write[]>)[0]!;
    if (requests.length > 25) throw refuse("more than 25 requests in a batch");
    if (requests.length > 0) {
      await db.batch(
        requests.map((r) => ("PutRequest" in r ? upsert(r.PutRequest.Item) : remove(r.DeleteRequest.Key))),
      );
    }
    return { UnprocessedItems: {} };
  }

  async function query(input: Input) {
    const v = input.ExpressionAttributeValues as Record<string, string>;
    const expr = input.KeyConditionExpression as string;
    const onIndex = input.IndexName !== undefined;
    if (onIndex && input.IndexName !== "GSI1") throw refuse("unknown index");
    const [hash, range, hashValue] = onIndex ? ["gsi1pk", "gsi1sk", v[":g"]] : ["pk", "sk", v[":pk"]];
    const where: string[] = [`${hash} = ?`];
    const args: unknown[] = [hashValue];
    if (expr.includes("begins_with")) {
      where.push(`substr(${range}, 1, ?) = ?`);
      args.push([...v[":p"]!].length, v[":p"]);
    } else if (expr.includes("BETWEEN")) {
      if (v[":lo"]! > v[":hi"]!) throw refuse("lower bound above upper");
      where.push(`${range} BETWEEN ? AND ?`);
      args.push(v[":lo"], v[":hi"]);
    } else if (!/^\w+ = :\w+$/.test(expr.trim())) {
      throw refuse("unsupported key condition");
    }

    const forward = input.ScanIndexForward !== false;
    const start = input.ExclusiveStartKey as Row | undefined;
    // The index orders by its own sort key, then the table key, so a page can end between equal sort keys.
    const order = onIndex ? [range, "pk", "sk"] : ["sk"];
    if (start) {
      const after = onIndex ? [start.GSI1SK, start.PK, start.SK] : [start.SK];
      where.push(`(${order.join(", ")}) ${forward ? ">" : "<"} (${after.map(() => "?").join(", ")})`);
      args.push(...after);
    }
    const dir = forward ? "ASC" : "DESC";
    const out = await rows(
      `SELECT item FROM items WHERE ${where.join(" AND ")} ORDER BY ${order.map((c) => `${c} ${dir}`).join(", ")} LIMIT ?`,
      ...args,
      pageSize + 1,
    );
    const items = out.slice(0, pageSize).map((r) => JSON.parse(r.item as string) as Row);
    const last = items.at(-1);
    return {
      Items: items,
      LastEvaluatedKey:
        out.length > pageSize && last
          ? { PK: last.PK, SK: last.SK, GSI1PK: last.GSI1PK, GSI1SK: last.GSI1SK }
          : undefined,
    };
  }

  const send = async (command: unknown): Promise<Record<string, unknown>> => {
    if (command instanceof PutCommand) {
      await upsert(command.input.Item as Row).all();
      return {};
    }
    if (command instanceof GetCommand) return get(command.input);
    if (command instanceof DeleteCommand) return del(command.input);
    if (command instanceof BatchWriteCommand) return batchWrite(command.input);
    if (command instanceof QueryCommand) return query(command.input);
    throw refuse("unsupported command");
  };
  return { send } as unknown as DynamoDBDocumentClient;
}
