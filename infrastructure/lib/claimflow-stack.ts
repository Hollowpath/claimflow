import * as cdk from 'aws-cdk-lib/core';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
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
    // CORS is deferred until the web application's origin is decided.
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
      },
    });
    this.cleanupWorker.addEventSource(
      new lambdaEventSources.SqsEventSource(this.cleanupQueue, {
        batchSize: 10,
        reportBatchItemFailures: true,
      }),
    );
  }
}
