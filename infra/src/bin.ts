import { App } from "aws-cdk-lib";
import { HippoStack } from "./hippo-stack.ts";

// Entry point for the cdk CLI (cdk.json "app"). Context comes from cdk.json and -c flags.
const app = new App();
new HippoStack(app, "HippoStack");
app.synth();
