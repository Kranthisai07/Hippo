import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, waitUntilTableExists } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe } from "vitest";
import { TABLE_DEFINITION, createDynamoRepository } from "../src/repository/dynamo";
import { runRepositorySuite } from "./repository.suite";

// Real DynamoDB Local only. Start it with `docker compose up -d`, then:
//   DYNAMODB_ENDPOINT=http://localhost:8000 AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local AWS_REGION=us-east-1 pnpm test
const endpoint = process.env.DYNAMODB_ENDPOINT;

if (!endpoint) {
  describe.skip("Repository contract: dynamo (skipped: set DYNAMODB_ENDPOINT to a DynamoDB Local URL to run)", () => {});
} else {
  const raw = new DynamoDBClient({ endpoint });
  const client = DynamoDBDocumentClient.from(raw);
  const tableName = `hippo-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(async () => {
    await raw.send(new CreateTableCommand({ TableName: tableName, ...TABLE_DEFINITION }));
    await waitUntilTableExists({ client: raw, maxWaitTime: 30 }, { TableName: tableName });
  });
  afterAll(async () => {
    await raw.send(new DeleteTableCommand({ TableName: tableName }));
    raw.destroy();
  });

  runRepositorySuite("dynamo (DynamoDB Local)", () => createDynamoRepository({ client, tableName }));
}
