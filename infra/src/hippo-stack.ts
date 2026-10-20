import * as path from "node:path";
import { Arn, ArnFormat, CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import type { Construct } from "constructs";
import { readConfig } from "./context.ts";

// These names must match TABLE_DEFINITION and TTL_ATTRIBUTE in packages/core/src/repository. A test compares them.
const TABLE = {
  partitionKey: "PK",
  sortKey: "SK",
  gsi1: { name: "GSI1", partitionKey: "GSI1PK", sortKey: "GSI1SK" },
  ttlAttribute: "ttl",
} as const;

// Nothing here bills while idle except the customer managed KMS key (fixed monthly charge per key, price
// unverified) and stored bytes. No NAT gateway, no provisioned concurrency, no reserved capacity, no CloudFront,
// no Kendra or OpenSearch, no VPC. Everything else is pay per request.
export class HippoStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    const cfg = readConfig(this.node);
    const dataRemoval = cfg.destroyable ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN;

    const table = new dynamodb.Table(this, "Table", {
      partitionKey: { name: TABLE.partitionKey, type: dynamodb.AttributeType.STRING },
      sortKey: { name: TABLE.sortKey, type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: TABLE.ttlAttribute,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: dataRemoval,
    });
    table.addGlobalSecondaryIndex({
      indexName: TABLE.gsi1.name,
      partitionKey: { name: TABLE.gsi1.partitionKey, type: dynamodb.AttributeType.STRING },
      sortKey: { name: TABLE.gsi1.sortKey, type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const docsKey = new kms.Key(this, "DocsKey", {
      description: "Hippo docs bucket key",
      enableKeyRotation: true,
      removalPolicy: dataRemoval,
    });
    // Object keys are uploads/<householdId>/<docId>/<file>; derived/ holds page text and search indexes.
    const bucket = new s3.Bucket(this, "DocsBucket", {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: docsKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: false,
      removalPolicy: dataRemoval,
      autoDeleteObjects: cfg.destroyable,
      lifecycleRules: [{ id: "abort-incomplete-multipart", abortIncompleteMultipartUploadAfter: Duration.days(1) }],
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: [cfg.webOrigin],
          allowedHeaders: ["*"],
          exposedHeaders: ["ETag"],
          maxAge: 3000,
        },
      ],
    });

    const common = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      code: lambda.Code.fromAsset(path.join(import.meta.dirname, "../placeholder-lambda")),
      handler: "index.handler",
    };
    const logGroup = (name: string) =>
      new logs.LogGroup(this, `${name}Logs`, {
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: RemovalPolicy.DESTROY,
      });
    const ssmParameterArn = (pathUnderHippo: string) =>
      Arn.format(
        {
          service: "ssm",
          resource: "parameter",
          resourceName: `hippo/${pathUnderHippo}`,
          arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
        },
        this,
      );

    const api = new lambda.Function(this, "ApiFunction", {
      ...common,
      description: "Hippo api (Hono: /mcp, /api, /oauth)",
      memorySize: 512,
      timeout: Duration.seconds(15),
      logGroup: logGroup("Api"),
      environment: { TABLE_NAME: table.tableName, BUCKET_NAME: bucket.bucketName, SSM_PREFIX: "/hippo" },
    });
    table.grantReadWriteData(api);
    bucket.grantReadWrite(api);
    api.addToRolePolicy(
      new iam.PolicyStatement({
        // JWT signing key and OAuth client config only. Create them by hand: aws ssm put-parameter --type SecureString.
        // SecureString with the default aws/ssm key needs no extra KMS grant for the caller.
        actions: ["ssm:GetParameter", "ssm:GetParameters"],
        resources: [ssmParameterArn("jwt/*"), ssmParameterArn("oauth/*")],
      }),
    );
    // With authType NONE, CDK adds InvokeFunctionUrl (condition FunctionUrlAuthType) and InvokeFunction
    // (condition InvokedViaFunctionUrl) for principal *. test/hippo-stack.test.ts proves it against the template.
    const fnUrl = api.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

    const ingest = new lambda.Function(this, "IngestFunction", {
      ...common,
      description: "Hippo ingest worker (S3 ObjectCreated)",
      memorySize: 1024,
      timeout: Duration.seconds(120),
      logGroup: logGroup("Ingest"),
      environment: {
        TABLE_NAME: table.tableName,
        BUCKET_NAME: bucket.bucketName,
        MAX_PAGES_PER_DOC: String(cfg.maxPagesPerDoc),
        MAX_BEDROCK_CALLS_PER_DAY: String(cfg.maxBedrockCallsPerDay),
        BEDROCK_MODEL_ID: cfg.bedrockModelId,
      },
    });
    table.grantReadWriteData(ingest);
    bucket.grantRead(ingest);
    bucket.grantPut(ingest, "derived/*");
    ingest.addToRolePolicy(
      new iam.PolicyStatement({
        // AWS Converse docs: calling Converse needs bedrock:InvokeModel; there is no bedrock:Converse action.
        // Resource shapes follow the AWS inference-profiles prerequisites page.
        actions: ["bedrock:InvokeModel"],
        resources: [
          Arn.format(
            {
              service: "bedrock",
              region: "*",
              account: "",
              resource: "foundation-model",
              resourceName: "*",
              arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
            },
            this,
          ),
          Arn.format(
            {
              service: "bedrock",
              region: "*",
              resource: "inference-profile",
              resourceName: "*",
              arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
            },
            this,
          ),
        ],
      }),
    );
    ingest.addToRolePolicy(
      // AWS Textract IAM examples grant DetectDocumentText on "*"; the action has no resource level permissions.
      new iam.PolicyStatement({ actions: ["textract:DetectDocumentText"], resources: ["*"] }),
    );
    bucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(ingest), { prefix: "uploads/" });

    const daily = new lambda.Function(this, "DailyFunction", {
      ...common,
      description: "Hippo daily job (deadlines, alerts, recall radar, digest)",
      memorySize: 512,
      timeout: Duration.seconds(300),
      logGroup: logGroup("Daily"),
      environment: {
        TABLE_NAME: table.tableName,
        SES_SENDER_ADDRESS: cfg.sesSenderAddress,
        ...(cfg.sesRecipientAddress ? { SES_RECIPIENT_ADDRESS: cfg.sesRecipientAddress } : {}),
      },
    });
    table.grantReadWriteData(daily);
    daily.addToRolePolicy(new iam.PolicyStatement({ actions: ["ses:SendEmail"], resources: [cfg.sesIdentityArn] }));
    new events.Rule(this, "DailySchedule", {
      description: "Hippo daily job, once a day (UTC)",
      schedule: events.Schedule.cron({ minute: String(cfg.dailyMinuteUtc), hour: String(cfg.dailyHourUtc) }),
      targets: [new targets.LambdaFunction(daily)],
    });

    new CfnOutput(this, "FunctionUrl", { value: fnUrl.url });
    new CfnOutput(this, "BucketName", { value: bucket.bucketName });
    new CfnOutput(this, "TableName", { value: table.tableName });
    new CfnOutput(this, "SesReminder", {
      value:
        "SES stays in sandbox: a human must verify the sender identity and every recipient address in this Region. The stack creates no identities.",
    });
  }
}
