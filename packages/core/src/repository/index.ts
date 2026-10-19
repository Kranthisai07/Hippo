// Only the memory repository is exported here, so the MCP voice path can import this barrel without pulling in the AWS
// SDK. The DynamoDB repository lives in "./dynamo" and is imported by that path.
export { createMemoryRepository } from "./memory";
