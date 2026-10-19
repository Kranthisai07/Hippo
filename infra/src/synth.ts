import { Template } from "aws-cdk-lib/assertions";
import { createApp } from "./app.ts";
import type { HippoStack } from "./hippo-stack.ts";

// Offline synth only (never contacts AWS). Usage: pnpm synth -c hippo:bedrockModelId=... -c key=value
// "--demo" fills the required context with obviously fake placeholders so the resource summary can be printed.
const DEMO_CONTEXT: Record<string, string> = {
  "hippo:bedrockModelId": "PLACEHOLDER-MODEL-ID-NOT-REAL",
  "hippo:sesSenderAddress": "sender@example.invalid",
  "hippo:sesIdentityArn": "arn:aws:ses:us-east-1:111111111111:identity/sender@example.invalid",
};

const context: Record<string, string> = {};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--demo") Object.assign(context, DEMO_CONTEXT);
  else if (arg === "-c" || arg === "--context") {
    const pair = args[++i] ?? "";
    const eq = pair.indexOf("=");
    if (eq < 1) throw new Error(`Expected -c key=value, got "${pair}"`);
    context[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
}

const app = createApp(context);
const stack = app.node.findChild("HippoStack") as HippoStack;
const resources = Template.fromStack(stack).toJSON().Resources as Record<string, { Type: string }>;
const counts = new Map<string, number>();
for (const r of Object.values(resources)) counts.set(r.Type, (counts.get(r.Type) ?? 0) + 1);
console.log(`HippoStack: ${Object.keys(resources).length} resources`);
for (const [type, n] of [...counts].sort()) console.log(`${String(n).padStart(3)}  ${type}`);
