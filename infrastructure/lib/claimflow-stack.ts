import * as cdk from 'aws-cdk-lib/core';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { resolve } from 'node:path';
import type { Construct } from 'constructs';

/** The only AWS Region ClaimFlow is deployed to. */
export const CLAIMFLOW_REGION = 'ap-southeast-1';

export const CLAIMFLOW_STACK_DESCRIPTION = 'ClaimFlow AWS infrastructure';

export const CLAIMFLOW_TABLE_NAME = 'ClaimFlow';

export const CLAIMFLOW_USER_POOL_NAME = 'ClaimFlow';

/** The four global secondary indexes in docs/aws-architecture.md, section 5. */
export const CLAIMFLOW_INDEX_NAMES = ['GSI1', 'GSI2', 'GSI3', 'GSI4'] as const;

/** Uploaded receipts not yet attached to a claim (docs/aws-architecture.md, section 11). */
export const CLAIMFLOW_PENDING_UPLOAD_PREFIX = 'uploads/pending/';

export const CLAIMFLOW_WEB_CLIENT_NAME = 'ClaimFlowWeb';

/** The Vite development server, which runs the web application locally. */
export const CLAIMFLOW_LOCAL_WEB_ORIGIN = 'http://localhost:5173';

/** Path of the web application's sign-in callback route. */
export const CLAIMFLOW_AUTH_CALLBACK_PATH = '/auth/callback';

/** The custom event bus that carries ClaimFlow's events (section 4). */
export const CLAIMFLOW_EVENT_BUS_NAME = 'claimflow';

/** The source of every ClaimFlow event (section 15). */
export const CLAIMFLOW_EVENT_SOURCE = 'claimflow.api';

export const CLAIMFLOW_CLEANUP_QUEUE_NAME = 'claimflow-cleanup';

export const CLAIMFLOW_CLEANUP_DLQ_NAME = 'claimflow-cleanup-dlq';

/** The internal events that only the cleanup worker handles (section 15). */
export const CLAIMFLOW_CLEANUP_EVENT_TYPES = [
  'internal.receipt-object-deletion-requested',
  'internal.claim-history-purge-requested',
] as const;

/** A queue message is received at most this often before it is moved to the dead-letter queue. */
export const CLAIMFLOW_CLEANUP_MAX_RECEIVES = 5;
export const CLAIMFLOW_CLEANUP_WORKER_NAME = 'claimflow-cleanup-worker';
export const CLAIMFLOW_CLEANUP_WORKER_TABLE_ENV = 'CLAIMFLOW_TABLE_NAME';
export const CLAIMFLOW_CLEANUP_WORKER_BUCKET_ENV =
  'CLAIMFLOW_RECEIPT_BUCKET_NAME';

export const CLAIMFLOW_OUTBOX_PUBLISHER_NAME = 'claimflow-outbox-publisher';
export const CLAIMFLOW_OUTBOX_FAILURE_QUEUE_NAME =
  'claimflow-outbox-publisher-failures';
export const CLAIMFLOW_RECEIPT_JANITOR_NAME = 'claimflow-receipt-janitor';
export const CLAIMFLOW_JANITOR_FAILURE_QUEUE_NAME =
  'claimflow-receipt-janitor-failures';
export const CLAIMFLOW_OUTBOX_SWEEPER_NAME = 'claimflow-outbox-sweeper';
/**
 * CloudWatch alarms (docs/aws-architecture.md, section 4). Standard
 * resolution; native metrics plus the sweeper's Embedded Metric Format metric.
 * Each alarm has an ALARM-only SNS action (no OK or insufficient-data actions).
 */
export const CLAIMFLOW_ALARM_PREFIX = 'claimflow';
/** Lambda errors and throttles, and queue depth: any occurrence is a fault. */
export const CLAIMFLOW_ALARM_FAULT_THRESHOLD = 1;
/** Lambda alarms look at 15 minutes, the sweeper's schedule interval. */
export const CLAIMFLOW_ALARM_LAMBDA_PERIOD_MINUTES = 15;
export const CLAIMFLOW_ALARM_QUEUE_PERIOD_MINUTES = 5;
/** The API's 5xx percentage; a period without requests has no value. */
export const CLAIMFLOW_ALARM_API_PERIOD_MINUTES = 5;
export const CLAIMFLOW_ALARM_API_5XX_PERCENT = 5;
export const CLAIMFLOW_ALARM_API_EVALUATION_PERIODS = 3;
export const CLAIMFLOW_ALARM_API_DATAPOINTS_TO_ALARM = 2;
/**
 * The sweeper's oldest-pending-outbox-age metric (an Embedded Metric Format
 * line in its log, not PutMetricData). It runs every 15 minutes, so each
 * period holds one datapoint.
 */
export const CLAIMFLOW_ALARM_OUTBOX_AGE_NAMESPACE = 'ClaimFlow';
export const CLAIMFLOW_ALARM_OUTBOX_AGE_METRIC = 'OldestPendingOutboxAge';
export const CLAIMFLOW_ALARM_OUTBOX_AGE_SECONDS = 30 * 60;
export const CLAIMFLOW_ALARM_OUTBOX_AGE_PERIOD_MINUTES = 15;
export const CLAIMFLOW_ALARM_OUTBOX_AGE_EVALUATION_PERIODS = 2;
/** The one SNS topic every alarm publishes to when it enters ALARM. */
export const CLAIMFLOW_ALARM_TOPIC_NAME = 'claimflow-alarms';
/** The required, NoEcho stack parameter that holds the subscriber's address. */
export const CLAIMFLOW_ALARM_EMAIL_PARAMETER = 'AlarmNotificationEmail';
/** A stream consumer this far behind has stopped keeping up. */
export const CLAIMFLOW_ALARM_ITERATOR_AGE_MINUTES = 15;
export const CLAIMFLOW_ALARM_ITERATOR_PERIOD_MINUTES = 5;
export const CLAIMFLOW_ALARM_ITERATOR_EVALUATION_PERIODS = 3;
export const CLAIMFLOW_API_FUNCTION_NAME = 'claimflow-api';
/**
 * The third-party notices that accompany every bundled Lambda asset
 * (THIRD_PARTY_NOTICES.txt at the repository root). The hook only copies a
 * file at build time: no resource, permission, or runtime behavior changes.
 */
export const CLAIMFLOW_THIRD_PARTY_NOTICES_FILE = 'THIRD_PARTY_NOTICES.txt';
const slashes = (path: string) => path.split('\\').join('/');
const thirdPartyNoticeHooks: nodejs.ICommandHooks = {
  beforeBundling: () => [],
  beforeInstall: () => [],
  afterBundling: (inputDir, outputDir) => [
    `node -e "require('fs').copyFileSync('${slashes(inputDir)}/${CLAIMFLOW_THIRD_PARTY_NOTICES_FILE}','${slashes(outputDir)}/${CLAIMFLOW_THIRD_PARTY_NOTICES_FILE}')"`,
  ],
};
/** The API function's settings (docs/aws-architecture.md, section 4). */
export const CLAIMFLOW_API_MEMORY_MB = 512;
/** Under the 30-second integration limit of an API Gateway HTTP API. */
export const CLAIMFLOW_API_TIMEOUT_SECONDS = 29;
export const CLAIMFLOW_API_NAME = 'claimflow-api';
/** The path prefix of every API route (`apiBasePath` in the contracts). */
export const CLAIMFLOW_API_BASE_PATH = '/api/v1';
/**
 * The scope a request's access token must carry. Cognito access tokens list
 * the scopes the app client was granted in their `scope` claim, and ID tokens
 * have none, so an ID token cannot satisfy it.
 */
export const CLAIMFLOW_API_REQUIRED_SCOPE = 'openid';
/** Steady-state and burst request limits of the API's default stage. */
export const CLAIMFLOW_API_RATE_LIMIT = 20;
export const CLAIMFLOW_API_BURST_LIMIT = 40;
/** The only request headers a browser may send, and the response headers it may read. */
export const CLAIMFLOW_API_CORS_ALLOWED_HEADERS = [
  'Authorization',
  'Content-Type',
  'Idempotency-Key',
] as const;
export const CLAIMFLOW_API_CORS_EXPOSED_HEADERS = [
  'X-Request-Id',
  'X-Correlation-Id',
] as const;
export const CLAIMFLOW_API_CORS_MAX_AGE_MINUTES = 10;

type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** The one route that needs no token (section 4). */
export const CLAIMFLOW_API_PUBLIC_ROUTES: readonly [ApiMethod, string][] = [
  ['GET', '/health'],
];

/**
 * Every protected route, listed one by one: there is no catch-all, so any
 * other path or method is answered by API Gateway itself.
 */
export const CLAIMFLOW_API_PROTECTED_ROUTES: readonly [ApiMethod, string][] = [
  ['GET', '/session'],
  ['GET', '/categories'],
  ['POST', '/categories'],
  ['PATCH', '/categories/{categoryId}'],
  ['DELETE', '/categories/{categoryId}'],
  ['GET', '/me/claims'],
  ['GET', '/review-queue'],
  ['GET', '/claims'],
  ['POST', '/claims'],
  ['GET', '/claims/{claimId}'],
  ['PATCH', '/claims/{claimId}'],
  ['DELETE', '/claims/{claimId}'],
  ['GET', '/claims/{claimId}/history'],
  ['POST', '/claims/{claimId}/submit'],
  ['POST', '/claims/{claimId}/start-review'],
  ['POST', '/claims/{claimId}/approve'],
  ['POST', '/claims/{claimId}/reject'],
  ['POST', '/claims/{claimId}/reopen'],
  ['POST', '/claims/{claimId}/mark-paid'],
  ['POST', '/receipts'],
  ['PUT', '/claims/{claimId}/receipt'],
  ['DELETE', '/claims/{claimId}/receipt'],
  ['GET', '/claims/{claimId}/receipt'],
];
export const CLAIMFLOW_PUBLISHER_EVENT_BUS_ENV = 'CLAIMFLOW_EVENT_BUS_NAME';

const repositoryRoot = resolve(__dirname, '../..');

const stringKey = (name: string): dynamodb.Attribute => ({
  name,
  type: dynamodb.AttributeType.STRING,
});

/** ClaimFlow's AWS infrastructure. */
export class ClaimFlowStack extends cdk.Stack {
  /** The single table holding all ClaimFlow data. */
  public readonly table: dynamodb.TableV2;

  /**
   * Authenticates ClaimFlow users. Roles and manager assignments are not
   * stored here; they live in DynamoDB user profiles keyed by the user's `sub`.
   */
  public readonly userPool: cognito.UserPool;

  /** Private storage for pending uploads and attached receipt files. */
  public readonly receiptBucket: s3.Bucket;

  /** Private storage for the built web application, read only by CloudFront. */
  public readonly webAssetsBucket: s3.Bucket;

  /** Serves the web application over HTTPS from the web assets bucket. */
  public readonly webDistribution: cloudfront.Distribution;

  /** The web application's public app client for the classic hosted UI. */
  public readonly webClient: cognito.UserPoolClient;

  /** Cognito prefix domain that hosts the classic hosted UI pages. */
  public readonly userPoolDomain: cognito.UserPoolDomain;

  /** Routes ClaimFlow events to their consumers. */
  public readonly eventBus: events.EventBus;

  /** Receives the internal cleanup events for the cleanup worker. */
  public readonly cleanupQueue: sqs.Queue;

  /** Holds cleanup messages that failed repeatedly, and undeliverable events. */
  public readonly cleanupDeadLetterQueue: sqs.Queue;

  /** Performs the internal cleanup events from the cleanup queue. */
  public readonly cleanupWorker: nodejs.NodejsFunction;

  /** The cleanup worker's own log group. */
  public readonly cleanupWorkerLogGroup: logs.LogGroup;

  /** Publishes new outbox items from the table stream to the event bus. */
  public readonly outboxPublisher: nodejs.NodejsFunction;

  /** The outbox publisher's own log group. */
  public readonly outboxPublisherLogGroup: logs.LogGroup;

  /** Receives stream batches the outbox publisher could not process. */
  public readonly outboxFailureQueue: sqs.Queue;

  /** Deletes the objects of pending receipts that expired by TTL. */
  public readonly receiptJanitor: nodejs.NodejsFunction;

  /** The receipt janitor's own log group. */
  public readonly receiptJanitorLogGroup: logs.LogGroup;

  /** Receives stream batches the receipt janitor could not process. */
  public readonly janitorFailureQueue: sqs.Queue;

  /** Republishes outbox items still pending after the stream path. */
  public readonly outboxSweeper: nodejs.NodejsFunction;

  /** The outbox sweeper's own log group. */
  public readonly outboxSweeperLogGroup: logs.LogGroup;

  /** Invokes the outbox sweeper every 15 minutes. */
  public readonly outboxSweeperSchedule: events.Rule;

  /** Serves the HTTP API's requests. */
  public readonly apiFunction: nodejs.NodejsFunction;

  /** The API function's own log group. */
  public readonly apiFunctionLogGroup: logs.LogGroup;

  /** The HTTP API in front of the API function. */
  public readonly httpApi: apigwv2.HttpApi;

  /** Receives every alarm's ALARM notification and emails the subscriber. */
  public readonly alarmTopic: sns.Topic;

  /** Every CloudWatch alarm, by the name it has in CloudWatch. */
  public readonly alarms: Readonly<Record<string, cloudwatch.Alarm>>;

  /** Validates Cognito access tokens before any route reaches the function. */
  public readonly apiAuthorizer: apigwv2Authorizers.HttpJwtAuthorizer;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, { description: CLAIMFLOW_STACK_DESCRIPTION, ...props });

    this.table = new dynamodb.TableV2(this, 'Table', {
      tableName: CLAIMFLOW_TABLE_NAME,
      partitionKey: stringKey('PK'),
      sortKey: stringKey('SK'),
      billing: dynamodb.Billing.onDemand(),
      timeToLiveAttribute: 'expiresAt',
      dynamoStream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      encryption: dynamodb.TableEncryptionV2.dynamoOwnedKey(),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      globalSecondaryIndexes: CLAIMFLOW_INDEX_NAMES.map((indexName) => ({
        indexName,
        partitionKey: stringKey(`${indexName}PK`),
        sortKey: stringKey(`${indexName}SK`),
        projectionType: dynamodb.ProjectionType.ALL,
      })),
    });

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: CLAIMFLOW_USER_POOL_NAME,
      // Password sign-in, email recovery, and TOTP MFA need no Essentials or
      // Plus features, so the plan is pinned rather than left to the default.
      featurePlan: cognito.FeaturePlan.LITE,
      // Administrators create every user; there is no self-service sign-up.
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      signInCaseSensitive: false,
      standardAttributes: { email: { required: true } },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      passwordPolicy: {
        minLength: 12,
        requireUppercase: true,
        requireLowercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: cdk.Duration.days(7),
      },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // No bucket name: S3 names are global, so CloudFormation generates one.
    // Its CORS rule is added below, once the web origin is known.
    this.receiptBucket = new s3.Bucket(this, 'ReceiptBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // Receipts are immutable once attached, so versioning is not needed.
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
      lifecycleRules: [
        {
          id: 'ExpirePendingUploads',
          prefix: CLAIMFLOW_PENDING_UPLOAD_PREFIX,
          expiration: cdk.Duration.days(1),
        },
      ],
    });

    // Separate from the receipt bucket. CloudFront reads it through Origin
    // Access Control; S3 website hosting stays off.
    this.webAssetsBucket = new s3.Bucket(this, 'WebAssetsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    // The bucket grants CloudFront s3:GetObject only, so S3 answers a missing
    // key with 403 rather than 404. Both are served as index.html with 200 so
    // that BrowserRouter can resolve client-side routes.
    const spaFallback = (httpStatus: number): cloudfront.ErrorResponse => ({
      httpStatus,
      responseHttpStatus: 200,
      responsePagePath: '/index.html',
    });

    this.webDistribution = new cloudfront.Distribution(
      this,
      'WebDistribution',
      {
        comment: 'ClaimFlow web application',
        defaultBehavior: {
          origin: origins.S3BucketOrigin.withOriginAccessControl(
            this.webAssetsBucket,
          ),
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        },
        defaultRootObject: 'index.html',
        errorResponses: [spaFallback(403), spaFallback(404)],
      },
    );

    new cdk.CfnOutput(this, 'WebUrl', {
      description: 'HTTPS URL of the web application',
      value: `https://${this.webDistribution.distributionDomainName}`,
    });
    new cdk.CfnOutput(this, 'WebDistributionDomainName', {
      description: 'CloudFront domain name of the web application',
      value: this.webDistribution.distributionDomainName,
    });
    new cdk.CfnOutput(this, 'WebAssetsBucketName', {
      description: 'S3 bucket that holds the built web application',
      value: this.webAssetsBucket.bucketName,
    });

    const webOrigin = `https://${this.webDistribution.distributionDomainName}`;

    // Lets the web application's browser send presigned POST uploads. CORS
    // is not authorization: the presigned POST policy still gates every write.
    this.receiptBucket.addCorsRule({
      allowedOrigins: [webOrigin],
      allowedMethods: [s3.HttpMethods.POST],
      allowedHeaders: ['*'],
    });
    const webCallbackUrl = `${webOrigin}${CLAIMFLOW_AUTH_CALLBACK_PATH}`;

    // A public client for the browser: no secret, and the authorization code
    // grant only. Sign-in happens on the classic hosted UI, so the only
    // direct API flow the client allows is refreshing tokens.
    this.webClient = this.userPool.addClient('WebClient', {
      userPoolClientName: CLAIMFLOW_WEB_CLIENT_NAME,
      generateSecret: false,
      authFlows: { userSrp: false },
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.COGNITO,
      ],
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
          implicitCodeGrant: false,
          clientCredentials: false,
        },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: [
          webCallbackUrl,
          `${CLAIMFLOW_LOCAL_WEB_ORIGIN}${CLAIMFLOW_AUTH_CALLBACK_PATH}`,
        ],
        logoutUrls: [`${webOrigin}/`, `${CLAIMFLOW_LOCAL_WEB_ORIGIN}/`],
        defaultRedirectUri: webCallbackUrl,
      },
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
      enableTokenRevocation: true,
      preventUserExistenceErrors: true,
    });

    // Domain prefixes are global across all AWS accounts, so the prefix
    // includes the account ID. The Lite feature plan supports only the
    // classic hosted UI, not the newer managed login.
    this.userPoolDomain = this.userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: `claimflow-${this.account}` },
      managedLoginVersion: cognito.ManagedLoginVersion.CLASSIC_HOSTED_UI,
    });

    new cdk.CfnOutput(this, 'WebClientId', {
      description: 'Cognito app client ID of the web application',
      value: this.webClient.userPoolClientId,
    });
    new cdk.CfnOutput(this, 'HostedUiBaseUrl', {
      description: 'Base URL of the Cognito classic hosted UI',
      value: this.userPoolDomain.baseUrl(),
    });

    this.eventBus = new events.EventBus(this, 'EventBus', {
      eventBusName: CLAIMFLOW_EVENT_BUS_NAME,
    });

    // Standard queues with SQS-managed encryption (no KMS key to pay for)
    // and TLS required. Messages are kept for 4 days, and failures for 14.
    this.cleanupDeadLetterQueue = new sqs.Queue(
      this,
      'CleanupDeadLetterQueue',
      {
        queueName: CLAIMFLOW_CLEANUP_DLQ_NAME,
        encryption: sqs.QueueEncryption.SQS_MANAGED,
        enforceSSL: true,
        retentionPeriod: cdk.Duration.days(14),
      },
    );
    this.cleanupQueue = new sqs.Queue(this, 'CleanupQueue', {
      queueName: CLAIMFLOW_CLEANUP_QUEUE_NAME,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(4),
      // Six times the 60-second limit planned for the cleanup function.
      visibilityTimeout: cdk.Duration.minutes(6),
      deadLetterQueue: {
        queue: this.cleanupDeadLetterQueue,
        maxReceiveCount: CLAIMFLOW_CLEANUP_MAX_RECEIVES,
      },
    });

    // Only the two internal cleanup events reach the cleanup queue. Events
    // EventBridge cannot deliver go to the same dead-letter queue.
    new events.Rule(this, 'CleanupRule', {
      ruleName: CLAIMFLOW_CLEANUP_QUEUE_NAME,
      description: 'Routes internal cleanup events to the cleanup queue',
      eventBus: this.eventBus,
      eventPattern: {
        source: [CLAIMFLOW_EVENT_SOURCE],
        detailType: [...CLAIMFLOW_CLEANUP_EVENT_TYPES],
      },
      targets: [
        new targets.SqsQueue(this.cleanupQueue, {
          deadLetterQueue: this.cleanupDeadLetterQueue,
        }),
      ],
    });

    new cdk.CfnOutput(this, 'EventBusName', {
      description: 'Name of the ClaimFlow event bus',
      value: this.eventBus.eventBusName,
    });
    new cdk.CfnOutput(this, 'CleanupQueueUrl', {
      description: 'URL of the cleanup worker queue',
      value: this.cleanupQueue.queueUrl,
    });

    // The cleanup worker: bundled from source (the workspaces' `source`
    // export condition) with the pinned AWS SDK, so no prebuilt `dist` files
    // are needed. Tracing stays off: it would add an X-Ray permission.
    this.cleanupWorkerLogGroup = new logs.LogGroup(
      this,
      'CleanupWorkerLogGroup',
      {
        logGroupName: `/aws/lambda/${CLAIMFLOW_CLEANUP_WORKER_NAME}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      },
    );
    const cleanupWorkerRole = new iam.Role(this, 'CleanupWorkerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    this.cleanupWorkerLogGroup.grantWrite(cleanupWorkerRole);
    this.cleanupQueue.grantConsumeMessages(cleanupWorkerRole);
    cleanupWorkerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:Query', 'dynamodb:BatchWriteItem'],
        resources: [this.table.tableArn],
      }),
    );
    cleanupWorkerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:DeleteObject'],
        resources: [this.receiptBucket.arnForObjects('receipts/*')],
      }),
    );
    this.cleanupWorker = new nodejs.NodejsFunction(this, 'CleanupWorker', {
      functionName: CLAIMFLOW_CLEANUP_WORKER_NAME,
      entry: resolve(
        repositoryRoot,
        'services/api/src/adapters/aws/cleanup-worker-lambda.ts',
      ),
      projectRoot: repositoryRoot,
      depsLockFilePath: resolve(repositoryRoot, 'package-lock.json'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(60),
      role: cleanupWorkerRole,
      logGroup: this.cleanupWorkerLogGroup,
      environment: {
        [CLAIMFLOW_CLEANUP_WORKER_TABLE_ENV]: this.table.tableName,
        [CLAIMFLOW_CLEANUP_WORKER_BUCKET_ENV]: this.receiptBucket.bucketName,
      },
      bundling: {
        externalModules: [],
        esbuildArgs: { '--conditions': 'source' },
        forceDockerBundling: false,
        commandHooks: thirdPartyNoticeHooks,
      },
    });
    this.cleanupWorker.addEventSource(
      new lambdaEventSources.SqsEventSource(this.cleanupQueue, {
        batchSize: 10,
        reportBatchItemFailures: true,
      }),
    );

    // The outbox publisher, built like the cleanup worker. The failure queue
    // receives the metadata of stream batches that exhausted their retries.
    this.outboxFailureQueue = new sqs.Queue(this, 'OutboxFailureQueue', {
      queueName: CLAIMFLOW_OUTBOX_FAILURE_QUEUE_NAME,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
    });
    this.outboxPublisherLogGroup = new logs.LogGroup(
      this,
      'OutboxPublisherLogGroup',
      {
        logGroupName: `/aws/lambda/${CLAIMFLOW_OUTBOX_PUBLISHER_NAME}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      },
    );
    const outboxPublisherRole = new iam.Role(this, 'OutboxPublisherRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    this.outboxPublisherLogGroup.grantWrite(outboxPublisherRole);
    outboxPublisherRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
        resources: [this.table.tableArn],
      }),
    );
    outboxPublisherRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['events:PutEvents'],
        resources: [this.eventBus.eventBusArn],
      }),
    );
    this.outboxPublisher = new nodejs.NodejsFunction(this, 'OutboxPublisher', {
      functionName: CLAIMFLOW_OUTBOX_PUBLISHER_NAME,
      entry: resolve(
        repositoryRoot,
        'services/api/src/adapters/aws/outbox-publisher-lambda.ts',
      ),
      projectRoot: repositoryRoot,
      depsLockFilePath: resolve(repositoryRoot, 'package-lock.json'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(60),
      role: outboxPublisherRole,
      logGroup: this.outboxPublisherLogGroup,
      environment: {
        [CLAIMFLOW_CLEANUP_WORKER_TABLE_ENV]: this.table.tableName,
        [CLAIMFLOW_PUBLISHER_EVENT_BUS_ENV]: this.eventBus.eventBusName,
      },
      bundling: {
        externalModules: [],
        esbuildArgs: { '--conditions': 'source' },
        forceDockerBundling: false,
        commandHooks: thirdPartyNoticeHooks,
      },
    });
    this.outboxPublisher.addEventSource(
      new lambdaEventSources.DynamoEventSource(this.table, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 10,
        reportBatchItemFailures: true,
        bisectBatchOnError: true,
        retryAttempts: 5,
        maxRecordAge: cdk.Duration.hours(24),
        onFailure: new lambdaEventSources.SqsDlq(this.outboxFailureQueue),
        filters: [
          lambda.FilterCriteria.filter({
            eventName: lambda.FilterRule.isEqual('INSERT') as string[],
            dynamodb: {
              Keys: {
                SK: {
                  S: lambda.FilterRule.beginsWith('OUTBOX#') as {
                    prefix: string;
                  }[],
                },
              },
            },
          }),
        ],
      }),
    );

    // The receipt janitor, built like the outbox publisher. It never touches
    // table items: it reads the stream and deletes receipt objects.
    this.janitorFailureQueue = new sqs.Queue(this, 'JanitorFailureQueue', {
      queueName: CLAIMFLOW_JANITOR_FAILURE_QUEUE_NAME,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
    });
    this.receiptJanitorLogGroup = new logs.LogGroup(
      this,
      'ReceiptJanitorLogGroup',
      {
        logGroupName: `/aws/lambda/${CLAIMFLOW_RECEIPT_JANITOR_NAME}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      },
    );
    const receiptJanitorRole = new iam.Role(this, 'ReceiptJanitorRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    this.receiptJanitorLogGroup.grantWrite(receiptJanitorRole);
    receiptJanitorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:DeleteObject'],
        resources: [
          this.receiptBucket.arnForObjects('receipts/*'),
          this.receiptBucket.arnForObjects('uploads/pending/*'),
        ],
      }),
    );
    this.receiptJanitor = new nodejs.NodejsFunction(this, 'ReceiptJanitor', {
      functionName: CLAIMFLOW_RECEIPT_JANITOR_NAME,
      entry: resolve(
        repositoryRoot,
        'services/api/src/adapters/aws/receipt-janitor-lambda.ts',
      ),
      projectRoot: repositoryRoot,
      depsLockFilePath: resolve(repositoryRoot, 'package-lock.json'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(60),
      role: receiptJanitorRole,
      logGroup: this.receiptJanitorLogGroup,
      environment: {
        [CLAIMFLOW_CLEANUP_WORKER_BUCKET_ENV]: this.receiptBucket.bucketName,
      },
      bundling: {
        externalModules: [],
        esbuildArgs: { '--conditions': 'source' },
        forceDockerBundling: false,
        commandHooks: thirdPartyNoticeHooks,
      },
    });
    this.receiptJanitor.addEventSource(
      new lambdaEventSources.DynamoEventSource(this.table, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 10,
        reportBatchItemFailures: true,
        bisectBatchOnError: true,
        retryAttempts: 5,
        maxRecordAge: cdk.Duration.hours(24),
        onFailure: new lambdaEventSources.SqsDlq(this.janitorFailureQueue),
        filters: [
          lambda.FilterCriteria.filter({
            eventName: lambda.FilterRule.isEqual('REMOVE') as string[],
            userIdentity: {
              type: lambda.FilterRule.isEqual('Service') as string[],
              principalId: lambda.FilterRule.isEqual(
                'dynamodb.amazonaws.com',
              ) as string[],
            },
            dynamodb: {
              OldImage: {
                entityType: {
                  S: lambda.FilterRule.isEqual('Receipt') as string[],
                },
                state: { S: lambda.FilterRule.isEqual('PENDING') as string[] },
              },
            },
          }),
        ],
      }),
    );

    // The outbox sweeper, built like the outbox publisher but invoked on a
    // schedule. It has no failure queue: unpublished items stay pending, so
    // later runs retry them.
    this.outboxSweeperLogGroup = new logs.LogGroup(
      this,
      'OutboxSweeperLogGroup',
      {
        logGroupName: `/aws/lambda/${CLAIMFLOW_OUTBOX_SWEEPER_NAME}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      },
    );
    const outboxSweeperRole = new iam.Role(this, 'OutboxSweeperRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    this.outboxSweeperLogGroup.grantWrite(outboxSweeperRole);
    outboxSweeperRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:Query'],
        resources: [`${this.table.tableArn}/index/GSI4`],
      }),
    );
    outboxSweeperRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
        resources: [this.table.tableArn],
      }),
    );
    outboxSweeperRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['events:PutEvents'],
        resources: [this.eventBus.eventBusArn],
      }),
    );
    this.outboxSweeper = new nodejs.NodejsFunction(this, 'OutboxSweeper', {
      functionName: CLAIMFLOW_OUTBOX_SWEEPER_NAME,
      entry: resolve(
        repositoryRoot,
        'services/api/src/adapters/aws/outbox-sweeper-lambda.ts',
      ),
      projectRoot: repositoryRoot,
      depsLockFilePath: resolve(repositoryRoot, 'package-lock.json'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(60),
      role: outboxSweeperRole,
      logGroup: this.outboxSweeperLogGroup,
      environment: {
        [CLAIMFLOW_CLEANUP_WORKER_TABLE_ENV]: this.table.tableName,
        [CLAIMFLOW_PUBLISHER_EVENT_BUS_ENV]: this.eventBus.eventBusName,
      },
      bundling: {
        externalModules: [],
        esbuildArgs: { '--conditions': 'source' },
        forceDockerBundling: false,
        commandHooks: thirdPartyNoticeHooks,
      },
    });
    this.outboxSweeperSchedule = new events.Rule(
      this,
      'OutboxSweeperSchedule',
      {
        ruleName: `${CLAIMFLOW_OUTBOX_SWEEPER_NAME}-schedule`,
        description: 'Invokes the outbox sweeper every 15 minutes',
        schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
        targets: [
          new targets.LambdaFunction(this.outboxSweeper, {
            retryAttempts: 2,
            maxEventAge: cdk.Duration.hours(1),
          }),
        ],
      },
    );

    // The API function. The HTTP API below is its only invoker. Its role is derived from the calls the AWS adapters make:
    // a transaction is authorized by the permissions of its operations (there
    // is no separate TransactWriteItems action), so Put, Update, Delete, and
    // ConditionCheck are granted on the table. It has no stream, EventBridge,
    // SQS, or Cognito access, and cannot delete final receipt objects.
    this.apiFunctionLogGroup = new logs.LogGroup(this, 'ApiFunctionLogGroup', {
      logGroupName: `/aws/lambda/${CLAIMFLOW_API_FUNCTION_NAME}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const apiRole = new iam.Role(this, 'ApiFunctionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    this.apiFunctionLogGroup.grantWrite(apiRole);
    apiRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'dynamodb:GetItem',
          'dynamodb:BatchGetItem',
          'dynamodb:Query',
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
          'dynamodb:DeleteItem',
          'dynamodb:ConditionCheckItem',
        ],
        resources: [this.table.tableArn],
      }),
    );
    // Claim lists read GSI1 to GSI4 (GSI4 shares its key space with outbox
    // items, which IAM cannot separate here).
    apiRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:Query'],
        resources: CLAIMFLOW_INDEX_NAMES.map(
          (indexName) => `${this.table.tableArn}/index/${indexName}`,
        ),
      }),
    );
    // Reads for inspection, the copy source, and download URLs; writes for the
    // copy destination and the presigned upload form (signed with this role);
    // deletion only of the pending upload.
    apiRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:PutObject'],
        resources: [
          this.receiptBucket.arnForObjects('receipts/*'),
          this.receiptBucket.arnForObjects(
            `${CLAIMFLOW_PENDING_UPLOAD_PREFIX}*`,
          ),
        ],
      }),
    );
    apiRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:DeleteObject'],
        resources: [
          this.receiptBucket.arnForObjects(
            `${CLAIMFLOW_PENDING_UPLOAD_PREFIX}*`,
          ),
        ],
      }),
    );
    // Without s3:ListBucket, S3 answers a HEAD or GET of a missing key with
    // 403 instead of 404, and the inspector could not tell a missing upload.
    apiRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [this.receiptBucket.bucketArn],
      }),
    );
    this.apiFunction = new nodejs.NodejsFunction(this, 'ApiFunction', {
      functionName: CLAIMFLOW_API_FUNCTION_NAME,
      entry: resolve(
        repositoryRoot,
        'services/api/src/adapters/aws/api-lambda.ts',
      ),
      projectRoot: repositoryRoot,
      depsLockFilePath: resolve(repositoryRoot, 'package-lock.json'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: CLAIMFLOW_API_MEMORY_MB,
      timeout: cdk.Duration.seconds(CLAIMFLOW_API_TIMEOUT_SECONDS),
      role: apiRole,
      logGroup: this.apiFunctionLogGroup,
      environment: {
        [CLAIMFLOW_CLEANUP_WORKER_TABLE_ENV]: this.table.tableName,
        [CLAIMFLOW_CLEANUP_WORKER_BUCKET_ENV]: this.receiptBucket.bucketName,
      },
      bundling: {
        externalModules: [],
        esbuildArgs: { '--conditions': 'source' },
        forceDockerBundling: false,
        commandHooks: thirdPartyNoticeHooks,
      },
    });

    // The HTTP API. Every route is listed explicitly and goes to the API
    // function through one payload format 2.0 integration. Only the health
    // check is public; every other route needs a Cognito access token from
    // the web app client that carries the required scope. An ID token has
    // the right audience but no `scope` claim, so it is refused.
    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: CLAIMFLOW_API_NAME,
      description: 'ClaimFlow HTTP API',
      createDefaultStage: false,
      corsPreflight: {
        allowOrigins: [webOrigin],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PUT,
          apigwv2.CorsHttpMethod.PATCH,
          apigwv2.CorsHttpMethod.DELETE,
        ],
        allowHeaders: [...CLAIMFLOW_API_CORS_ALLOWED_HEADERS],
        exposeHeaders: [...CLAIMFLOW_API_CORS_EXPOSED_HEADERS],
        allowCredentials: false,
        maxAge: cdk.Duration.minutes(CLAIMFLOW_API_CORS_MAX_AGE_MINUTES),
      },
    });
    new apigwv2.HttpStage(this, 'HttpApiDefaultStage', {
      httpApi: this.httpApi,
      stageName: '$default',
      autoDeploy: true,
      throttle: {
        rateLimit: CLAIMFLOW_API_RATE_LIMIT,
        burstLimit: CLAIMFLOW_API_BURST_LIMIT,
      },
    });
    this.apiAuthorizer = new apigwv2Authorizers.HttpJwtAuthorizer(
      'ApiAuthorizer',
      this.userPool.userPoolProviderUrl,
      {
        authorizerName: 'claimflow-cognito',
        jwtAudience: [this.webClient.userPoolClientId],
        identitySource: ['$request.header.Authorization'],
      },
    );
    const apiIntegration = new apigwv2Integrations.HttpLambdaIntegration(
      'ApiIntegration',
      this.apiFunction,
      { payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0 },
    );
    for (const [method, path] of CLAIMFLOW_API_PUBLIC_ROUTES) {
      this.httpApi.addRoutes({
        path: `${CLAIMFLOW_API_BASE_PATH}${path}`,
        methods: [apigwv2.HttpMethod[method]],
        integration: apiIntegration,
        authorizer: new apigwv2.HttpNoneAuthorizer(),
      });
    }
    for (const [method, path] of CLAIMFLOW_API_PROTECTED_ROUTES) {
      this.httpApi.addRoutes({
        path: `${CLAIMFLOW_API_BASE_PATH}${path}`,
        methods: [apigwv2.HttpMethod[method]],
        integration: apiIntegration,
        authorizer: this.apiAuthorizer,
        authorizationScopes: [CLAIMFLOW_API_REQUIRED_SCOPE],
      });
    }

    new cdk.CfnOutput(this, 'ApiEndpoint', {
      description: 'Invoke URL of the HTTP API, without the API base path',
      value: this.httpApi.apiEndpoint,
    });
    new cdk.CfnOutput(this, 'ApiBaseUrl', {
      description: 'Base URL of every ClaimFlow API route',
      value: `${this.httpApi.apiEndpoint}${CLAIMFLOW_API_BASE_PATH}`,
    });
    new cdk.CfnOutput(this, 'ApiId', {
      description: 'ID of the HTTP API',
      value: this.httpApi.apiId,
    });

    // Alarms. Without a dashboard; missing data
    // never breaches, so idle functions and queues stay in the OK state.
    const alarms: Record<string, cloudwatch.Alarm> = {};
    const addAlarm = (
      id: string,
      name: string,
      description: string,
      metric: cloudwatch.IMetric,
      props: {
        readonly threshold: number;
        readonly evaluationPeriods?: number;
        readonly datapointsToAlarm?: number;
      },
    ) => {
      const alarmName = `${CLAIMFLOW_ALARM_PREFIX}-${name}`;
      alarms[alarmName] = new cloudwatch.Alarm(this, id, {
        alarmName,
        alarmDescription: description,
        metric,
        threshold: props.threshold,
        evaluationPeriods: props.evaluationPeriods ?? 1,
        ...(props.datapointsToAlarm === undefined
          ? {}
          : { datapointsToAlarm: props.datapointsToAlarm }),
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    };

    const apiPeriod = cdk.Duration.minutes(CLAIMFLOW_ALARM_API_PERIOD_MINUTES);
    addAlarm(
      'ApiServerErrorRateAlarm',
      'api-5xx-rate',
      `At least ${CLAIMFLOW_ALARM_API_5XX_PERCENT}% of HTTP API requests returned 5xx in ${CLAIMFLOW_ALARM_API_DATAPOINTS_TO_ALARM} of ${CLAIMFLOW_ALARM_API_EVALUATION_PERIODS} periods of ${CLAIMFLOW_ALARM_API_PERIOD_MINUTES} minutes. Periods without requests have no data and do not breach.`,
      new cloudwatch.MathExpression({
        expression: `IF(requests > 0, 100 * FILL(errors, 0) / requests, 0)`,
        usingMetrics: {
          errors: this.httpApi.metricServerError({
            statistic: 'Sum',
            period: apiPeriod,
          }),
          requests: this.httpApi.metricCount({
            statistic: 'Sum',
            period: apiPeriod,
          }),
        },
        label: '5xx percentage',
        period: apiPeriod,
      }),
      {
        threshold: CLAIMFLOW_ALARM_API_5XX_PERCENT,
        evaluationPeriods: CLAIMFLOW_ALARM_API_EVALUATION_PERIODS,
        datapointsToAlarm: CLAIMFLOW_ALARM_API_DATAPOINTS_TO_ALARM,
      },
    );

    const lambdaPeriod = cdk.Duration.minutes(
      CLAIMFLOW_ALARM_LAMBDA_PERIOD_MINUTES,
    );
    const functions: [string, string, nodejs.NodejsFunction][] = [
      ['Api', CLAIMFLOW_API_FUNCTION_NAME, this.apiFunction],
      ['CleanupWorker', CLAIMFLOW_CLEANUP_WORKER_NAME, this.cleanupWorker],
      [
        'OutboxPublisher',
        CLAIMFLOW_OUTBOX_PUBLISHER_NAME,
        this.outboxPublisher,
      ],
      ['ReceiptJanitor', CLAIMFLOW_RECEIPT_JANITOR_NAME, this.receiptJanitor],
      ['OutboxSweeper', CLAIMFLOW_OUTBOX_SWEEPER_NAME, this.outboxSweeper],
    ];
    for (const [id, name, fn] of functions) {
      addAlarm(
        `${id}ErrorsAlarm`,
        `${name.replace(/^claimflow-/, '')}-errors`,
        `${name} had ${CLAIMFLOW_ALARM_FAULT_THRESHOLD} or more invocation errors in ${CLAIMFLOW_ALARM_LAMBDA_PERIOD_MINUTES} minutes.`,
        fn.metricErrors({ statistic: 'Sum', period: lambdaPeriod }),
        { threshold: CLAIMFLOW_ALARM_FAULT_THRESHOLD },
      );
      addAlarm(
        `${id}ThrottlesAlarm`,
        `${name.replace(/^claimflow-/, '')}-throttles`,
        `${name} was throttled ${CLAIMFLOW_ALARM_FAULT_THRESHOLD} or more times in ${CLAIMFLOW_ALARM_LAMBDA_PERIOD_MINUTES} minutes.`,
        fn.metricThrottles({ statistic: 'Sum', period: lambdaPeriod }),
        { threshold: CLAIMFLOW_ALARM_FAULT_THRESHOLD },
      );
    }

    // Only stream consumers report an iterator age; it is missing when idle.
    const iteratorPeriod = cdk.Duration.minutes(
      CLAIMFLOW_ALARM_ITERATOR_PERIOD_MINUTES,
    );
    for (const [id, name, fn] of [
      [
        'OutboxPublisher',
        CLAIMFLOW_OUTBOX_PUBLISHER_NAME,
        this.outboxPublisher,
      ],
      ['ReceiptJanitor', CLAIMFLOW_RECEIPT_JANITOR_NAME, this.receiptJanitor],
    ] as const) {
      addAlarm(
        `${id}IteratorAgeAlarm`,
        `${name.replace(/^claimflow-/, '')}-iterator-age`,
        `${name} is ${CLAIMFLOW_ALARM_ITERATOR_AGE_MINUTES} minutes or more behind the table stream for ${CLAIMFLOW_ALARM_ITERATOR_EVALUATION_PERIODS} consecutive periods of ${CLAIMFLOW_ALARM_ITERATOR_PERIOD_MINUTES} minutes.`,
        fn.metric('IteratorAge', {
          statistic: 'Maximum',
          period: iteratorPeriod,
          unit: cloudwatch.Unit.MILLISECONDS,
        }),
        {
          threshold: cdk.Duration.minutes(
            CLAIMFLOW_ALARM_ITERATOR_AGE_MINUTES,
          ).toMilliseconds(),
          evaluationPeriods: CLAIMFLOW_ALARM_ITERATOR_EVALUATION_PERIODS,
        },
      );
    }

    const queuePeriod = cdk.Duration.minutes(
      CLAIMFLOW_ALARM_QUEUE_PERIOD_MINUTES,
    );
    for (const [id, name, queue] of [
      [
        'CleanupDeadLetter',
        CLAIMFLOW_CLEANUP_DLQ_NAME,
        this.cleanupDeadLetterQueue,
      ],
      [
        'OutboxFailure',
        CLAIMFLOW_OUTBOX_FAILURE_QUEUE_NAME,
        this.outboxFailureQueue,
      ],
      [
        'JanitorFailure',
        CLAIMFLOW_JANITOR_FAILURE_QUEUE_NAME,
        this.janitorFailureQueue,
      ],
    ] as const) {
      addAlarm(
        `${id}QueueDepthAlarm`,
        `${name.replace(/^claimflow-/, '')}-visible-messages`,
        `${name} holds ${CLAIMFLOW_ALARM_FAULT_THRESHOLD} or more visible messages: something failed and was set aside.`,
        queue.metricApproximateNumberOfMessagesVisible({
          statistic: 'Maximum',
          period: queuePeriod,
        }),
        { threshold: CLAIMFLOW_ALARM_FAULT_THRESHOLD },
      );
    }
    addAlarm(
      'OldestPendingOutboxAgeAlarm',
      'oldest-pending-outbox-age',
      `The oldest outbox event the sweeper selected has waited ${CLAIMFLOW_ALARM_OUTBOX_AGE_SECONDS / 60} minutes or more, in ${CLAIMFLOW_ALARM_OUTBOX_AGE_EVALUATION_PERIODS} consecutive periods of ${CLAIMFLOW_ALARM_OUTBOX_AGE_PERIOD_MINUTES} minutes. The sweeper reports 0 when nothing is overdue; a missing report does not breach.`,
      new cloudwatch.Metric({
        namespace: CLAIMFLOW_ALARM_OUTBOX_AGE_NAMESPACE,
        metricName: CLAIMFLOW_ALARM_OUTBOX_AGE_METRIC,
        statistic: 'Maximum',
        unit: cloudwatch.Unit.SECONDS,
        period: cdk.Duration.minutes(CLAIMFLOW_ALARM_OUTBOX_AGE_PERIOD_MINUTES),
      }),
      {
        threshold: CLAIMFLOW_ALARM_OUTBOX_AGE_SECONDS,
        evaluationPeriods: CLAIMFLOW_ALARM_OUTBOX_AGE_EVALUATION_PERIODS,
      },
    );
    this.alarms = alarms;

    // Email delivery. The address is a required NoEcho parameter, never a
    // literal or an output. The subscription stays pending until its owner
    // confirms it from the message SNS sends.
    const alarmEmail = new cdk.CfnParameter(
      this,
      CLAIMFLOW_ALARM_EMAIL_PARAMETER,
      {
        type: 'String',
        noEcho: true,
        description:
          'Email address that receives ClaimFlow alarm notifications. SNS asks it to confirm the subscription.',
        allowedPattern: '^[^@ ]+@[^@ ]+[.][^@ ]+$',
        constraintDescription: 'Enter a valid email address.',
      },
    );
    // A standard topic with the default SNS encryption state (no customer
    // managed key) that denies any publish over plain HTTP.
    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: CLAIMFLOW_ALARM_TOPIC_NAME,
      enforceSSL: true,
    });
    this.alarmTopic.addSubscription(
      new snsSubscriptions.EmailSubscription(alarmEmail.valueAsString),
    );
    // CloudWatch may publish only for this account's ClaimFlow alarms.
    this.alarmTopic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowClaimFlowAlarmsToPublish',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [this.alarmTopic.topicArn],
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: {
            'aws:SourceArn': this.formatArn({
              service: 'cloudwatch',
              resource: 'alarm',
              resourceName: `${CLAIMFLOW_ALARM_PREFIX}-*`,
              arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
            }),
          },
        },
      }),
    );
    // ALARM only: no OK or insufficient-data notifications.
    const alarmAction: cloudwatch.IAlarmAction = {
      bind: () => ({ alarmActionArn: this.alarmTopic.topicArn }),
    };
    for (const alarm of Object.values(alarms)) {
      alarm.addAlarmAction(alarmAction);
    }
  }
}
