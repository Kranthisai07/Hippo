import type { Node } from "constructs";

export interface HippoConfig {
  destroyable: boolean;
  webOrigin: string;
  bedrockModelId: string;
  maxPagesPerDoc: number;
  maxBedrockCallsPerDay: number;
  dailyHourUtc: number;
  dailyMinuteUtc: number;
  sesSenderAddress: string;
  sesIdentityArn: string;
  sesRecipientAddress: string | undefined;
}

function required(node: Node, key: string, hint: string): string {
  const value: unknown = node.tryGetContext(key);
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing CDK context "${key}": ${hint}. Pass it with: -c ${key}=<value>`);
  }
  return value.trim();
}

function positiveInt(node: Node, key: string, fallback: number): number {
  const raw: unknown = node.tryGetContext(key);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`CDK context "${key}" must be a positive integer, got "${String(raw)}"`);
  }
  return n;
}

export function readConfig(node: Node): HippoConfig {
  const time = String(node.tryGetContext("hippo:dailyTimeUtc") ?? "13:00");
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match) throw new Error(`CDK context "hippo:dailyTimeUtc" must look like HH:MM (UTC), got "${time}"`);
  const recipient: unknown = node.tryGetContext("hippo:sesRecipientAddress");
  return {
    destroyable: String(node.tryGetContext("hippo:destroyable")) === "true",
    webOrigin: String(node.tryGetContext("hippo:webOrigin") ?? "http://localhost:5173"),
    // No default on purpose: model ids change and must be verified (docs/VERIFIED.md section 3).
    bedrockModelId: required(
      node,
      "hippo:bedrockModelId",
      "a Bedrock model or inference profile id verified for your Region",
    ),
    maxPagesPerDoc: positiveInt(node, "hippo:maxPagesPerDoc", 40),
    maxBedrockCallsPerDay: positiveInt(node, "hippo:maxBedrockCallsPerDay", 200),
    dailyHourUtc: Number(match[1]),
    dailyMinuteUtc: Number(match[2]),
    sesSenderAddress: required(node, "hippo:sesSenderAddress", "the SES-verified From address"),
    sesIdentityArn: required(node, "hippo:sesIdentityArn", "the ARN of the verified SES identity (email or domain)"),
    sesRecipientAddress: typeof recipient === "string" && recipient !== "" ? recipient : undefined,
  };
}
