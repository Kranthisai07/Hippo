import { createDynamoRepository } from "../src/repository/dynamo";
import { createFakeDynamo } from "./dynamo.fake";
import { runRepositorySuite } from "./repository.suite";

// Runs the shared contract suite against the Dynamo repository on an in-process fake client. This proves the
// repository's own logic only. The real DynamoDB behaviour is covered by repository.dynamo.test.ts (needs DynamoDB Local).
runRepositorySuite("dynamo on in-process fake (not real DynamoDB)", () =>
  createDynamoRepository({ client: createFakeDynamo().client, tableName: "hippo-test" }),
);
