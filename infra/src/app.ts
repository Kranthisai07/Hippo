import { App } from "aws-cdk-lib";
import { HippoStack } from "./hippo-stack.ts";

// Env-agnostic on purpose: account and Region come from the CLI profile at deploy time.
export function createApp(context: Record<string, string> = {}): App {
  const app = new App({ context });
  new HippoStack(app, "HippoStack");
  return app;
}
