import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { HippoStack } from "../src/hippo-stack.ts";
import { TABLE_DEFINITION, TTL_SPECIFICATION } from "../../packages/core/src/repository/dynamo";
import { pageTextKey } from "../../packages/core/src/repository/shared";

const CONTEXT = {
  "hippo:bedrockModelId": "TEST-MODEL-ID",
  "hippo:sesSenderAddress": "sender@example.invalid",
  "hippo:sesIdentityArn": "arn:aws:ses:us-east-1:111111111111:identity/sender@example.invalid",
};

function synth(context: Record<string, unknown> = {}): Template {
  const app = new App({ context: { ...CONTEXT, ...context } });
  return Template.fromStack(new HippoStack(app, "HippoStack"));
}

const template = synth();

// The three Hippo functions carry a description starting with "Hippo "; CDK's own helper Lambdas (bucket
// notifications) do not, and are outside our control.
const appFunctions = () =>
  Object.entries(
    template.findResources("AWS::Lambda::Function", { Properties: { Description: Match.stringLikeRegexp("^Hippo ") } }),
  );

describe("cost: nothing bills while idle beyond pay per use", () => {
  // Reasoning: the only fixed charge is the customer managed KMS key the task requires. No NAT gateway, no VPC,
  // no provisioned concurrency, no reserved capacity, no CloudFront, no Kendra, no OpenSearch, no API Gateway.
  it("contains none of the idle-cost resource types", () => {
    const types = new Set(
      Object.values(template.toJSON().Resources as Record<string, { Type: string }>).map((r) => r.Type),
    );
    const forbidden = [
      "AWS::EC2::NatGateway",
      "AWS::EC2::VPC",
      "AWS::CloudFront::Distribution",
      "AWS::ApiGateway::RestApi",
      "AWS::ApiGatewayV2::Api",
      "AWS::Kendra::Index",
      "AWS::OpenSearchService::Domain",
      "AWS::OpenSearchServerless::Collection",
      "AWS::Lambda::Alias",
      "AWS::SecretsManager::Secret",
    ];
    for (const t of forbidden) expect(types.has(t), t).toBe(false);
  });

  it("has no provisioned or reserved concurrency on any function", () => {
    for (const [, fn] of Object.entries(template.findResources("AWS::Lambda::Function"))) {
      expect(fn.Properties.ReservedConcurrentExecutions).toBeUndefined();
    }
    expect(Object.keys(template.findResources("AWS::Lambda::Version"))).toHaveLength(0);
    template.resourceCountIs("AWS::ApplicationAutoScaling::ScalableTarget", 0);
  });
});

describe("DynamoDB table", () => {
  it("has PK/SK, GSI1, on demand billing, TTL ttl, PITR and AWS managed SSE", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
      BillingMode: "PAY_PER_REQUEST",
      GlobalSecondaryIndexes: [
        {
          IndexName: "GSI1",
          KeySchema: [
            { AttributeName: "GSI1PK", KeyType: "HASH" },
            { AttributeName: "GSI1SK", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
      ],
      TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      SSESpecification: { SSEEnabled: true },
    });
  });

  // Review finding: the stack said expiresAt while the repository writes ttl, so undo records would never expire.
  it("uses the same key, index and TTL names as the repository", () => {
    const [table] = Object.values(template.findResources("AWS::DynamoDB::Table")) as { Properties: Record<string, any> }[];
    const p = table!.Properties;
    expect(p.KeySchema).toEqual(TABLE_DEFINITION.KeySchema);
    expect(p.GlobalSecondaryIndexes).toHaveLength(1);
    const gsi = p.GlobalSecondaryIndexes[0];
    const want = TABLE_DEFINITION.GlobalSecondaryIndexes![0]!;
    expect(gsi.IndexName).toBe(want.IndexName);
    expect(gsi.KeySchema).toEqual(want.KeySchema);
    expect(gsi.Projection).toEqual(want.Projection);
    expect(p.BillingMode).toBe(TABLE_DEFINITION.BillingMode);
    expect(p.TimeToLiveSpecification).toEqual({
      AttributeName: TTL_SPECIFICATION.AttributeName,
      Enabled: TTL_SPECIFICATION.Enabled,
    });
  });

  // The delete cascade removes pageTextKey, and the ingest worker can only write under derived/. They must agree.
  it("keeps the page text key under the only prefix the ingest worker may write", () => {
    expect(pageTextKey("hh", "doc").startsWith("derived/")).toBe(true);
    expect(JSON.stringify(template.findResources("AWS::IAM::Policy"))).toContain("/derived/*");
  });

  it("is retained by default and destroyed only with hippo:destroyable=true", () => {
    template.hasResource("AWS::DynamoDB::Table", { DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" });
    synth({ "hippo:destroyable": "true" }).hasResource("AWS::DynamoDB::Table", { DeletionPolicy: "Delete" });
  });
});

describe("docs bucket", () => {
  it("uses SSE-KMS with a rotating customer managed key", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: "aws:kms", KMSMasterKeyID: Match.anyValue() } },
        ],
      },
    });
    template.hasResourceProperties("AWS::KMS::Key", { EnableKeyRotation: true });
  });

  it("blocks public access, enforces SSL, has no versioning and aborts incomplete multipart uploads", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      LifecycleConfiguration: {
        Rules: [Match.objectLike({ AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 }, Status: "Enabled" })],
      },
    });
    const bucket = Object.values(template.findResources("AWS::S3::Bucket"))[0];
    expect(bucket?.Properties.VersioningConfiguration).toBeUndefined();
    template.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Effect: "Deny", Condition: { Bool: { "aws:SecureTransport": "false" } } }),
        ]),
      },
    });
  });

  it("allows PUT from the configured web origin only", () => {
    const cors = (t: Template, origin: string) =>
      t.hasResourceProperties("AWS::S3::Bucket", {
        CorsConfiguration: { CorsRules: [Match.objectLike({ AllowedMethods: ["PUT"], AllowedOrigins: [origin] })] },
      });
    cors(template, "http://localhost:5173");
    cors(
      synth({ "hippo:webOrigin": "https://abc.lambda-url.us-east-1.on.aws" }),
      "https://abc.lambda-url.us-east-1.on.aws",
    );
  });

  it("is retained by default, destroyed with auto delete only when destroyable", () => {
    template.hasResource("AWS::S3::Bucket", { DeletionPolicy: "Retain" });
    template.hasResource("AWS::KMS::Key", { DeletionPolicy: "Retain" });
    expect(Object.keys(template.findResources("Custom::S3AutoDeleteObjects"))).toHaveLength(0);
    const destroyable = synth({ "hippo:destroyable": "true" });
    destroyable.hasResource("AWS::S3::Bucket", { DeletionPolicy: "Delete" });
    destroyable.resourceCountIs("Custom::S3AutoDeleteObjects", 1);
  });

  it("notifies the ingest worker on ObjectCreated under uploads/", () => {
    template.hasResourceProperties("Custom::S3BucketNotifications", {
      NotificationConfiguration: {
        LambdaFunctionConfigurations: [
          Match.objectLike({
            Events: ["s3:ObjectCreated:*"],
            Filter: { Key: { FilterRules: [{ Name: "prefix", Value: "uploads/" }] } },
          }),
        ],
      },
    });
  });
});

describe("Lambda functions", () => {
  it("are Node.js 22 on arm64 with the specified memory and timeouts", () => {
    const fns = appFunctions();
    expect(fns).toHaveLength(3);
    for (const [, fn] of fns) {
      expect(fn.Properties.Runtime).toBe("nodejs22.x");
      expect(fn.Properties.Architectures).toEqual(["arm64"]);
    }
    const byDesc = (re: RegExp) => fns.map(([, f]) => f.Properties).find((p) => re.test(p.Description));
    expect(byDesc(/api/)).toMatchObject({ MemorySize: 512, Timeout: 15 });
    expect(byDesc(/ingest/)).toMatchObject({ MemorySize: 1024, Timeout: 120 });
    expect(byDesc(/daily/)).toMatchObject({ MemorySize: 512 });
  });

  it("passes cost guards and the model id to the ingest worker", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Description: Match.stringLikeRegexp("ingest"),
      Environment: {
        Variables: Match.objectLike({
          MAX_PAGES_PER_DOC: "40",
          MAX_BEDROCK_CALLS_PER_DAY: "200",
          BEDROCK_MODEL_ID: "TEST-MODEL-ID",
        }),
      },
    });
  });

  it("fails synth with a clear message when the Bedrock model id is missing", () => {
    const app = new App({ context: { ...CONTEXT, "hippo:bedrockModelId": undefined } });
    expect(() => new HippoStack(app, "X")).toThrow(/hippo:bedrockModelId/);
  });
});

describe("API Function URL (G-022)", () => {
  const [apiId] = appFunctions().find(([, f]) => /api/.test(f.Properties.Description)) ?? [];

  it("has authType NONE and no other front door", () => {
    template.resourceCountIs("AWS::Lambda::Url", 1);
    template.hasResourceProperties("AWS::Lambda::Url", { AuthType: "NONE" });
  });

  // Proves what CDK 2.273.0 synthesizes: it does add BOTH statements (AWS requires both for URLs created after
  // October 2025, https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html).
  it("grants lambda:InvokeFunctionUrl and lambda:InvokeFunction to * with the documented conditions", () => {
    const perms = Object.values(template.findResources("AWS::Lambda::Permission")).map((p) => p.Properties);
    const forApi = perms.filter((p) => JSON.stringify(p.FunctionName).includes(String(apiId)));
    expect(forApi).toContainEqual(
      expect.objectContaining({ Action: "lambda:InvokeFunctionUrl", Principal: "*", FunctionUrlAuthType: "NONE" }),
    );
    expect(forApi).toContainEqual(
      expect.objectContaining({ Action: "lambda:InvokeFunction", Principal: "*", InvokedViaFunctionUrl: true }),
    );
  });
});

describe("daily schedule", () => {
  it("fires the daily Lambda once a day at the configured UTC time", () => {
    template.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "cron(0 13 * * ? *)",
      State: "ENABLED",
      Targets: [Match.objectLike({ Arn: Match.anyValue() })],
    });
    synth({ "hippo:dailyTimeUtc": "06:30" }).hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "cron(30 6 * * ? *)",
    });
  });

  it("rejects a malformed time", () => {
    const app = new App({ context: { ...CONTEXT, "hippo:dailyTimeUtc": "25:00" } });
    expect(() => new HippoStack(app, "X")).toThrow(/dailyTimeUtc/);
  });
});

describe("IAM", () => {
  type Statement = { Effect: string; Action: string | string[]; Resource: unknown };
  const statements = (): Statement[] => {
    const docs: { Statement: Statement[] }[] = [];
    for (const p of Object.values(template.findResources("AWS::IAM::Policy"))) docs.push(p.Properties.PolicyDocument);
    return docs.flatMap((d) => d.Statement);
  };

  // Actions that AWS only allows on Resource "*". Keep this list minimal and justified.
  const WILDCARD_RESOURCE_ALLOWED = new Set([
    // Textract has no resource level permissions for synchronous detection.
    "textract:DetectDocumentText",
    // CDK's bucket notification helper Lambda; the action cannot be scoped by CDK's own handler.
    "s3:PutBucketNotification",
  ]);

  it("has no Action * or service:* and no Resource * outside the allow list", () => {
    for (const s of statements().filter((x) => x.Effect === "Allow")) {
      const actions = ([] as string[]).concat(s.Action);
      for (const a of actions) expect(a === "*" || a.endsWith(":*"), `action ${a}`).toBe(false);
      const resources = ([] as unknown[]).concat(s.Resource);
      if (resources.includes("*")) {
        for (const a of actions) expect(WILDCARD_RESOURCE_ALLOWED.has(a), `Resource * for ${a}`).toBe(true);
      }
    }
  });

  it("scopes ses:SendEmail to the verified identity ARN from context", () => {
    const send = statements().filter((s) => ([] as string[]).concat(s.Action).includes("ses:SendEmail"));
    expect(send).toHaveLength(1);
    expect(send[0]?.Resource).toBe(CONTEXT["hippo:sesIdentityArn"]);
  });

  it("uses bedrock:InvokeModel (Converse needs it; there is no bedrock:Converse action) and Textract", () => {
    const actions = statements().flatMap((s) => ([] as string[]).concat(s.Action));
    expect(actions).toContain("bedrock:InvokeModel");
    expect(actions).toContain("textract:DetectDocumentText");
    expect(actions.filter((a) => a.startsWith("bedrock:"))).toEqual(["bedrock:InvokeModel"]);
  });

  it("limits SSM reads to the jwt and oauth paths and only for the api function", () => {
    const ssm = statements().filter((s) => ([] as string[]).concat(s.Action).some((a) => a.startsWith("ssm:")));
    expect(ssm).toHaveLength(1);
    expect(JSON.stringify(ssm[0]?.Resource)).toMatch(/parameter\/hippo\/jwt\/\*.*parameter\/hippo\/oauth\/\*/);
  });

  it("gives the daily function no S3 access", () => {
    const policies = Object.entries(template.findResources("AWS::IAM::Policy")).filter(([id]) =>
      id.startsWith("DailyFunction"),
    );
    expect(policies.length).toBeGreaterThan(0);
    for (const [, p] of policies) expect(JSON.stringify(p.Properties.PolicyDocument)).not.toMatch(/"s3:|kms:/);
  });
});

describe("outputs and SES", () => {
  it("outputs the Function URL, bucket name and table name", () => {
    const names = Object.keys(template.toJSON().Outputs);
    expect(names).toEqual(expect.arrayContaining(["FunctionUrl", "BucketName", "TableName", "SesReminder"]));
  });

  it("creates no SES identity", () => {
    const types = Object.values(template.toJSON().Resources as Record<string, { Type: string }>).map((r) => r.Type);
    expect(types.filter((t) => t.startsWith("AWS::SES::"))).toEqual([]);
  });
});
