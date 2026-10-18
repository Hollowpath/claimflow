import * as cdk from 'aws-cdk-lib/core';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
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
  }
}
