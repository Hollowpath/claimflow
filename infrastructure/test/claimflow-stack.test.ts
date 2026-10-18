import { Match, Template } from 'aws-cdk-lib/assertions';
import { App, type CfnElement } from 'aws-cdk-lib/core';
import type { IConstruct } from 'constructs';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  CLAIMFLOW_CLEANUP_DLQ_NAME,
  CLAIMFLOW_CLEANUP_EVENT_TYPES,
  CLAIMFLOW_CLEANUP_QUEUE_NAME,
  CLAIMFLOW_CLEANUP_WORKER_NAME,
  CLAIMFLOW_OUTBOX_FAILURE_QUEUE_NAME,
  CLAIMFLOW_OUTBOX_PUBLISHER_NAME,
  CLAIMFLOW_EVENT_BUS_NAME,
  CLAIMFLOW_EVENT_SOURCE,
  CLAIMFLOW_REGION,
  CLAIMFLOW_STACK_DESCRIPTION,
  ClaimFlowStack,
} from '../lib/claimflow-stack';

const TABLE_TYPE = 'AWS::DynamoDB::GlobalTable';
const USER_POOL_TYPE = 'AWS::Cognito::UserPool';
const BUCKET_TYPE = 'AWS::S3::Bucket';
const BUCKET_POLICY_TYPE = 'AWS::S3::BucketPolicy';
const OAC_TYPE = 'AWS::CloudFront::OriginAccessControl';
const DISTRIBUTION_TYPE = 'AWS::CloudFront::Distribution';
const CLIENT_TYPE = 'AWS::Cognito::UserPoolClient';
const DOMAIN_TYPE = 'AWS::Cognito::UserPoolDomain';
const EVENT_BUS_TYPE = 'AWS::Events::EventBus';
const RULE_TYPE = 'AWS::Events::Rule';
const QUEUE_TYPE = 'AWS::SQS::Queue';
const QUEUE_POLICY_TYPE = 'AWS::SQS::QueuePolicy';
const FUNCTION_TYPE = 'AWS::Lambda::Function';
const MAPPING_TYPE = 'AWS::Lambda::EventSourceMapping';
const ROLE_TYPE = 'AWS::IAM::Role';
const IAM_POLICY_TYPE = 'AWS::IAM::Policy';
const LOG_GROUP_TYPE = 'AWS::Logs::LogGroup';

interface TableResource {
  readonly Properties: Record<string, any>;
  readonly DeletionPolicy?: string;
  readonly UpdateReplacePolicy?: string;
}

type UserPoolResource = TableResource;
type BucketResource = TableResource;

describe('ClaimFlowStack', () => {
  let stack: ClaimFlowStack;
  let template: Template;
  let table: TableResource;
  let userPool: UserPoolResource;
  let bucket: BucketResource;
  let bucketLogicalId: string;
  let webBucket: BucketResource;
  let webBucketLogicalId: string;
  let distribution: TableResource;
  let distributionLogicalId: string;
  let userPoolLogicalId: string;
  let webClient: TableResource;
  let webClientLogicalId: string;
  let domain: TableResource;
  let domainLogicalId: string;

  const resourceOf = (construct: IConstruct): [string, TableResource] => {
    const logicalId = stack.getLogicalId(
      construct.node.defaultChild as CfnElement,
    );
    const resources = template.toJSON().Resources as Record<
      string,
      TableResource
    >;
    expect(resources).toHaveProperty(logicalId);
    return [logicalId, resources[logicalId]];
  };

  /** The statements of the one bucket policy attached to the given bucket. */
  const policyStatementsFor = (logicalId: string): Record<string, any>[] => {
    const policies = Object.values(
      template.findResources(BUCKET_POLICY_TYPE, {
        Properties: { Bucket: { Ref: logicalId } },
      }),
    ) as TableResource[];
    expect(policies).toHaveLength(1);
    return policies[0].Properties.PolicyDocument.Statement;
  };

  const denyInsecureTransport = (logicalId: string) => ({
    Effect: 'Deny',
    Principal: { AWS: '*' },
    Action: 's3:*',
    Condition: { Bool: { 'aws:SecureTransport': 'false' } },
    Resource: [
      { 'Fn::GetAtt': [logicalId, 'Arn'] },
      { 'Fn::Join': ['', [{ 'Fn::GetAtt': [logicalId, 'Arn'] }, '/*']] },
    ],
  });

  beforeAll(() => {
    stack = new ClaimFlowStack(new App(), 'ClaimFlow', {
      env: { account: '123456789012', region: CLAIMFLOW_REGION },
    });
    template = Template.fromStack(stack);
    const tables = Object.values(template.findResources(TABLE_TYPE));
    expect(tables).toHaveLength(1);
    table = tables[0] as TableResource;
    const userPools = Object.values(template.findResources(USER_POOL_TYPE));
    expect(userPools).toHaveLength(1);
    userPool = userPools[0] as UserPoolResource;
    [bucketLogicalId, bucket] = resourceOf(stack.receiptBucket);
    [webBucketLogicalId, webBucket] = resourceOf(stack.webAssetsBucket);
    [distributionLogicalId, distribution] = resourceOf(stack.webDistribution);
    [userPoolLogicalId] = resourceOf(stack.userPool);
    [webClientLogicalId, webClient] = resourceOf(stack.webClient);
    [domainLogicalId, domain] = resourceOf(stack.userPoolDomain);
  });

  describe('stack', () => {
    it('is described as ClaimFlow infrastructure', () => {
      expect(template.toJSON().Description).toBe(CLAIMFLOW_STACK_DESCRIPTION);
    });

    it('targets ap-southeast-1', () => {
      expect(stack.region).toBe('ap-southeast-1');
    });

    it('contains only the expected resources', () => {
      const resourceTypes = Object.values(
        (template.toJSON().Resources ?? {}) as Record<string, { Type: string }>,
      )
        .map((resource) => resource.Type)
        .filter((type) => type !== 'AWS::CDK::Metadata');

      expect(resourceTypes.sort()).toEqual(
        [
          USER_POOL_TYPE,
          TABLE_TYPE,
          BUCKET_TYPE,
          BUCKET_POLICY_TYPE,
          BUCKET_TYPE,
          BUCKET_POLICY_TYPE,
          OAC_TYPE,
          DISTRIBUTION_TYPE,
          CLIENT_TYPE,
          DOMAIN_TYPE,
          EVENT_BUS_TYPE,
          RULE_TYPE,
          QUEUE_TYPE,
          QUEUE_TYPE,
          QUEUE_POLICY_TYPE,
          QUEUE_POLICY_TYPE,
          FUNCTION_TYPE,
          MAPPING_TYPE,
          ROLE_TYPE,
          IAM_POLICY_TYPE,
          LOG_GROUP_TYPE,
          QUEUE_TYPE,
          QUEUE_POLICY_TYPE,
          FUNCTION_TYPE,
          MAPPING_TYPE,
          ROLE_TYPE,
          IAM_POLICY_TYPE,
          LOG_GROUP_TYPE,
        ].sort(),
      );
      template.resourceCountIs('AWS::KMS::Key', 0);
    });

    it.each([
      'AWS::Cognito::IdentityPool',
      'AWS::Cognito::UserPoolUser',
      'AWS::Cognito::UserPoolGroup',
      'AWS::Cognito::UserPoolIdentityProvider',
      'AWS::Cognito::UserPoolResourceServer',
      'AWS::Cognito::UserPoolUICustomizationAttachment',
      'AWS::Cognito::ManagedLoginBranding',
      'AWS::ApiGatewayV2::Api',
      'AWS::ApiGateway::RestApi',
      'AWS::SES::EmailIdentity',
      'AWS::IAM::User',
      'AWS::SNS::Topic',
      'AWS::Lambda::Permission',
      'AWS::Lambda::LayerVersion',
      'AWS::IAM::ManagedPolicy',
      'AWS::Events::Archive',
      'AWS::Events::Connection',
      'AWS::Events::ApiDestination',
      'AWS::Pipes::Pipe',
      'AWS::Scheduler::Schedule',
      'AWS::CloudWatch::Alarm',
      'Custom::S3AutoDeleteObjects',
      'Custom::CDKBucketDeployment',
      'AWS::CloudFront::CloudFrontOriginAccessIdentity',
      'AWS::CloudFront::Function',
      'AWS::CertificateManager::Certificate',
      'AWS::Route53::RecordSet',
      'AWS::WAFv2::WebACL',
    ])('defines no %s', (type) => {
      template.resourceCountIs(type, 0);
    });

    it('uses the default synthesizer bootstrap version check', () => {
      template.hasParameter('BootstrapVersion', {
        Type: 'AWS::SSM::Parameter::Value<String>',
        Default: Match.stringLikeRegexp('^/cdk-bootstrap/'),
      });
    });
  });

  describe('DynamoDB table', () => {
    it('is named ClaimFlow', () => {
      expect(table.Properties.TableName).toBe('ClaimFlow');
    });

    it('uses string PK and SK as the base keys', () => {
      expect(table.Properties.KeySchema).toEqual([
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ]);
      expect(table.Properties.AttributeDefinitions).toEqual(
        expect.arrayContaining([
          { AttributeName: 'PK', AttributeType: 'S' },
          { AttributeName: 'SK', AttributeType: 'S' },
        ]),
      );
    });

    it('uses on-demand billing', () => {
      expect(table.Properties.BillingMode).toBe('PAY_PER_REQUEST');
    });

    it('expires items through the expiresAt TTL attribute', () => {
      expect(table.Properties.TimeToLiveSpecification).toEqual({
        AttributeName: 'expiresAt',
        Enabled: true,
      });
    });

    it('streams new and old images', () => {
      expect(table.Properties.StreamSpecification).toEqual({
        StreamViewType: 'NEW_AND_OLD_IMAGES',
      });
    });

    it('has one replica in ap-southeast-1 with point-in-time recovery and deletion protection', () => {
      expect(table.Properties.Replicas).toHaveLength(1);
      expect(table.Properties.Replicas[0]).toMatchObject({
        Region: 'ap-southeast-1',
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        DeletionProtectionEnabled: true,
      });
    });

    it('is encrypted with the DynamoDB owned key and no KMS key', () => {
      // DynamoDB always encrypts at rest. SSEEnabled: false selects the
      // DynamoDB owned key (the default) instead of a KMS key.
      expect(table.Properties.SSESpecification).toEqual({ SSEEnabled: false });
      expect(table.Properties.Replicas[0]).not.toHaveProperty(
        'SSESpecification',
      );

      const properties = JSON.stringify(table.Properties);
      expect(properties).not.toContain('SSEType');
      expect(properties).not.toContain('KMSMasterKey');
      expect(properties).not.toContain('arn:aws:kms');
      template.resourceCountIs('AWS::KMS::Key', 0);
    });

    it('is retained when removed from the stack or replaced', () => {
      expect(table.DeletionPolicy).toBe('Retain');
      expect(table.UpdateReplacePolicy).toBe('Retain');
    });

    it('defines exactly the four approved GSIs with ALL projection', () => {
      const indexes = table.Properties.GlobalSecondaryIndexes as unknown[];
      expect(indexes).toEqual(
        ['GSI1', 'GSI2', 'GSI3', 'GSI4'].map((name) => ({
          IndexName: name,
          KeySchema: [
            { AttributeName: `${name}PK`, KeyType: 'HASH' },
            { AttributeName: `${name}SK`, KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        })),
      );
    });

    it('declares every key attribute as a string and nothing else', () => {
      const names = ['PK', 'SK'].concat(
        ...['GSI1', 'GSI2', 'GSI3', 'GSI4'].map((n) => [`${n}PK`, `${n}SK`]),
      );
      expect(table.Properties.AttributeDefinitions).toEqual(
        names.map((AttributeName) => ({ AttributeName, AttributeType: 'S' })),
      );
    });
  });

  describe('Cognito User Pool', () => {
    it('is named ClaimFlow and exposed by the stack', () => {
      expect(userPool.Properties.UserPoolName).toBe('ClaimFlow');
      expect(stack.userPool).toBeDefined();
    });

    it('uses the Lite feature plan', () => {
      expect(userPool.Properties.UserPoolTier).toBe('LITE');
    });

    it('verifies email addresses automatically', () => {
      expect(userPool.Properties.AutoVerifiedAttributes).toEqual(['email']);
    });

    it('allows only administrators to create users', () => {
      expect(userPool.Properties.AdminCreateUserConfig).toEqual({
        AllowAdminCreateUserOnly: true,
      });
    });

    it('signs users in with their email address, case-insensitively', () => {
      expect(userPool.Properties.UsernameAttributes).toEqual(['email']);
      expect(userPool.Properties).not.toHaveProperty('AliasAttributes');
      expect(userPool.Properties.UsernameConfiguration).toEqual({
        CaseSensitive: false,
      });
    });

    it('requires email as the only schema attribute, with no custom attributes', () => {
      expect(userPool.Properties.Schema).toEqual([
        { Name: 'email', Required: true, Mutable: true },
      ]);
    });

    it('recovers accounts by email only', () => {
      expect(userPool.Properties.AccountRecoverySetting).toEqual({
        RecoveryMechanisms: [{ Name: 'verified_email', Priority: 1 }],
      });
    });

    it('enforces the complete password policy', () => {
      expect(userPool.Properties.Policies).toEqual({
        PasswordPolicy: {
          MinimumLength: 12,
          RequireUppercase: true,
          RequireLowercase: true,
          RequireNumbers: true,
          RequireSymbols: true,
          TemporaryPasswordValidityDays: 7,
        },
      });
    });

    it('offers optional TOTP MFA with SMS MFA disabled', () => {
      expect(userPool.Properties.MfaConfiguration).toBe('OPTIONAL');
      expect(userPool.Properties.EnabledMfas).toEqual(['SOFTWARE_TOKEN_MFA']);
      expect(userPool.Properties).not.toHaveProperty('SmsConfiguration');
    });

    it('has deletion protection enabled', () => {
      expect(userPool.Properties.DeletionProtection).toBe('ACTIVE');
    });

    it('is retained when removed from the stack or replaced', () => {
      expect(userPool.DeletionPolicy).toBe('Retain');
      expect(userPool.UpdateReplacePolicy).toBe('Retain');
    });

    it('has no Lambda triggers, SES email configuration, or custom KMS key', () => {
      expect(userPool.Properties).not.toHaveProperty('LambdaConfig');
      expect(userPool.Properties).not.toHaveProperty('EmailConfiguration');
      expect(JSON.stringify(userPool.Properties)).not.toContain('KmsKey');
    });
  });

  describe('receipt bucket', () => {
    it('has a generated name and is exposed by the stack', () => {
      expect(bucket.Properties).not.toHaveProperty('BucketName');
      expect(stack.receiptBucket).toBeDefined();
    });

    it('blocks all public access', () => {
      expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });
    });

    it('is encrypted with S3 managed keys and no KMS key', () => {
      expect(bucket.Properties.BucketEncryption).toEqual({
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      });
      expect(JSON.stringify(bucket.Properties)).not.toContain('KMS');
    });

    it('does not enable versioning', () => {
      expect(bucket.Properties).not.toHaveProperty('VersioningConfiguration');
    });

    it('expires pending uploads after one day and nothing else', () => {
      expect(bucket.Properties.LifecycleConfiguration).toEqual({
        Rules: [
          {
            Id: 'ExpirePendingUploads',
            Prefix: 'uploads/pending/',
            ExpirationInDays: 1,
            Status: 'Enabled',
          },
        ],
      });
    });

    it('is retained when removed from the stack or replaced', () => {
      expect(bucket.DeletionPolicy).toBe('Retain');
      expect(bucket.UpdateReplacePolicy).toBe('Retain');
    });

    it('has a bucket policy that denies requests not sent over TLS', () => {
      expect(policyStatementsFor(bucketLogicalId)).toHaveLength(1);
      template.hasResourceProperties(BUCKET_POLICY_TYPE, {
        Bucket: { Ref: bucketLogicalId },
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Deny',
              Principal: { AWS: '*' },
              Action: 's3:*',
              Condition: { Bool: { 'aws:SecureTransport': 'false' } },
            }),
          ]),
        },
      });
    });

    it('has no CORS rules, website hosting, or auto-delete', () => {
      expect(bucket.Properties).not.toHaveProperty('CorsConfiguration');
      expect(bucket.Properties).not.toHaveProperty('WebsiteConfiguration');
      expect(JSON.stringify(bucket)).not.toContain('auto-delete');
    });
  });

  describe('web assets bucket', () => {
    it('is a separate bucket with a generated name, exposed by the stack', () => {
      expect(webBucketLogicalId).not.toBe(bucketLogicalId);
      expect(webBucket.Properties).not.toHaveProperty('BucketName');
      template.resourceCountIs(BUCKET_TYPE, 2);
    });

    it('blocks all public access', () => {
      expect(webBucket.Properties.PublicAccessBlockConfiguration).toEqual({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });
    });

    it('is encrypted with S3 managed keys and no KMS key', () => {
      expect(webBucket.Properties.BucketEncryption).toEqual({
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      });
      expect(JSON.stringify(webBucket.Properties)).not.toContain('KMS');
    });

    it('has no website hosting, versioning, lifecycle rules, CORS, or auto-delete', () => {
      expect(webBucket.Properties).not.toHaveProperty('WebsiteConfiguration');
      expect(webBucket.Properties).not.toHaveProperty(
        'VersioningConfiguration',
      );
      expect(webBucket.Properties).not.toHaveProperty('LifecycleConfiguration');
      expect(webBucket.Properties).not.toHaveProperty('CorsConfiguration');
      expect(JSON.stringify(webBucket)).not.toContain('auto-delete');
    });

    it('is retained when removed from the stack or replaced', () => {
      expect(webBucket.DeletionPolicy).toBe('Retain');
      expect(webBucket.UpdateReplacePolicy).toBe('Retain');
    });

    it('denies non-TLS requests and allows only this distribution to read objects', () => {
      const statements = policyStatementsFor(webBucketLogicalId);
      expect(statements).toHaveLength(2);
      expect(statements).toEqual(
        expect.arrayContaining([
          denyInsecureTransport(webBucketLogicalId),
          {
            Effect: 'Allow',
            Principal: { Service: 'cloudfront.amazonaws.com' },
            Action: 's3:GetObject',
            Resource: {
              'Fn::Join': [
                '',
                [{ 'Fn::GetAtt': [webBucketLogicalId, 'Arn'] }, '/*'],
              ],
            },
            Condition: {
              StringEquals: {
                'AWS:SourceArn': {
                  'Fn::Join': [
                    '',
                    [
                      'arn:',
                      { Ref: 'AWS::Partition' },
                      ':cloudfront::',
                      { Ref: 'AWS::AccountId' },
                      ':distribution/',
                      { Ref: distributionLogicalId },
                    ],
                  ],
                },
              },
            },
          },
        ]),
      );
    });

    it('does not give CloudFront access to the receipt bucket', () => {
      expect(
        JSON.stringify(policyStatementsFor(bucketLogicalId)),
      ).not.toContain('cloudfront');
    });
  });

  describe('web distribution', () => {
    it('reads the web assets bucket through Origin Access Control', () => {
      template.resourceCountIs(OAC_TYPE, 1);
      const [oacLogicalId] = Object.keys(
        template.findResources(OAC_TYPE, {
          Properties: {
            OriginAccessControlConfig: {
              OriginAccessControlOriginType: 's3',
              SigningBehavior: 'always',
              SigningProtocol: 'sigv4',
            },
          },
        }),
      );
      expect(oacLogicalId).toBeDefined();

      const origins = distribution.Properties.DistributionConfig.Origins;
      expect(origins).toHaveLength(1);
      expect(origins[0]).toMatchObject({
        DomainName: {
          'Fn::GetAtt': [webBucketLogicalId, 'RegionalDomainName'],
        },
        OriginAccessControlId: { 'Fn::GetAtt': [oacLogicalId, 'Id'] },
        S3OriginConfig: { OriginAccessIdentity: '' },
      });
      expect(origins[0]).not.toHaveProperty('CustomOriginConfig');
    });

    it('redirects HTTP to HTTPS and serves only GET and HEAD', () => {
      const behavior =
        distribution.Properties.DistributionConfig.DefaultCacheBehavior;
      expect(behavior.ViewerProtocolPolicy).toBe('redirect-to-https');
      expect(behavior.AllowedMethods).toEqual(['GET', 'HEAD']);
      expect(distribution.Properties.DistributionConfig).not.toHaveProperty(
        'CacheBehaviors',
      );
    });

    it('uses index.html as the default root object', () => {
      expect(distribution.Properties.DistributionConfig.DefaultRootObject).toBe(
        'index.html',
      );
    });

    it('serves /index.html with 200 for missing paths so BrowserRouter routes resolve', () => {
      expect(
        distribution.Properties.DistributionConfig.CustomErrorResponses,
      ).toEqual([
        { ErrorCode: 403, ResponseCode: 200, ResponsePagePath: '/index.html' },
        { ErrorCode: 404, ResponseCode: 200, ResponsePagePath: '/index.html' },
      ]);
    });

    it('is enabled on the default CloudFront domain without a custom domain or certificate', () => {
      const config = distribution.Properties.DistributionConfig;
      expect(config.Enabled).toBe(true);
      expect(config).not.toHaveProperty('Aliases');
      expect(config).not.toHaveProperty('ViewerCertificate');
      expect(config).not.toHaveProperty('WebACLId');
    });
  });

  describe('outputs', () => {
    const domainName = () => ({
      'Fn::GetAtt': [distributionLogicalId, 'DomainName'],
    });

    it('exports the web application URL and CloudFront domain name', () => {
      template.hasOutput('WebUrl', {
        Value: { 'Fn::Join': ['', ['https://', domainName()]] },
      });
      template.hasOutput('WebDistributionDomainName', { Value: domainName() });
    });

    it('exports the web assets bucket name', () => {
      template.hasOutput('WebAssetsBucketName', {
        Value: { Ref: webBucketLogicalId },
      });
    });

    it('exports the web app client ID and the classic hosted UI base URL', () => {
      template.hasOutput('WebClientId', { Value: { Ref: webClientLogicalId } });
      expect(template.toJSON().Outputs).not.toHaveProperty(
        'ManagedLoginBaseUrl',
      );
      template.hasOutput('HostedUiBaseUrl', {
        Value: {
          'Fn::Join': [
            '',
            [
              'https://',
              { Ref: domainLogicalId },
              '.auth.ap-southeast-1.amazoncognito.com',
            ],
          ],
        },
      });
    });
  });

  describe('cleanup event delivery', () => {
    let busLogicalId: string;
    let cleanupQueueLogicalId: string;
    let dlqLogicalId: string;
    let ruleLogicalId: string;

    const arnOf = (logicalId: string) => ({ 'Fn::GetAtt': [logicalId, 'Arn'] });

    const queuePolicyStatements = (
      logicalId: string,
    ): Record<string, any>[] => {
      const policies = Object.values(
        template.findResources(QUEUE_POLICY_TYPE, {
          Properties: { Queues: [{ Ref: logicalId }] },
        }),
      ) as TableResource[];
      expect(policies).toHaveLength(1);
      return policies[0].Properties.PolicyDocument.Statement;
    };

    const denyInsecureQueueTransport = (logicalId: string) => ({
      Effect: 'Deny',
      Principal: { AWS: '*' },
      Action: 'sqs:*',
      Condition: { Bool: { 'aws:SecureTransport': 'false' } },
      Resource: arnOf(logicalId),
    });

    beforeAll(() => {
      [busLogicalId] = resourceOf(stack.eventBus);
      [cleanupQueueLogicalId] = resourceOf(stack.cleanupQueue);
      [dlqLogicalId] = resourceOf(stack.cleanupDeadLetterQueue);
      [ruleLogicalId] = Object.keys(template.findResources(RULE_TYPE));
    });

    it('defines a custom event bus named claimflow', () => {
      expect(CLAIMFLOW_EVENT_BUS_NAME).toBe('claimflow');
      template.resourceCountIs(EVENT_BUS_TYPE, 1);
      template.hasResourceProperties(EVENT_BUS_TYPE, { Name: 'claimflow' });
    });

    it('defines three queues in total, two for cleanup', () => {
      template.resourceCountIs(QUEUE_TYPE, 3);
      template.resourceCountIs(QUEUE_POLICY_TYPE, 3);
    });

    it('defines standard queues with SQS-managed encryption', () => {
      for (const [logicalId, name] of [
        [cleanupQueueLogicalId, CLAIMFLOW_CLEANUP_QUEUE_NAME],
        [dlqLogicalId, CLAIMFLOW_CLEANUP_DLQ_NAME],
      ]) {
        const { Properties } = template.toJSON().Resources[logicalId];
        expect(Properties.QueueName).toBe(name);
        expect(Properties.SqsManagedSseEnabled).toBe(true);
        expect(Properties).not.toHaveProperty('FifoQueue');
        expect(Properties).not.toHaveProperty('KmsMasterKeyId');
      }
      expect(CLAIMFLOW_CLEANUP_QUEUE_NAME).toBe('claimflow-cleanup');
      expect(CLAIMFLOW_CLEANUP_DLQ_NAME).toBe('claimflow-cleanup-dlq');
      template.resourceCountIs('AWS::KMS::Key', 0);
    });

    it('retains cleanup messages for 4 days and dead letters for 14', () => {
      template.hasResourceProperties(QUEUE_TYPE, {
        QueueName: 'claimflow-cleanup',
        MessageRetentionPeriod: 4 * 24 * 60 * 60,
      });
      template.hasResourceProperties(QUEUE_TYPE, {
        QueueName: 'claimflow-cleanup-dlq',
        MessageRetentionPeriod: 14 * 24 * 60 * 60,
      });
    });

    it('gives the cleanup queue a 6 minute visibility timeout', () => {
      template.hasResourceProperties(QUEUE_TYPE, {
        QueueName: 'claimflow-cleanup',
        VisibilityTimeout: 360,
      });
      const dlq = template.toJSON().Resources[dlqLogicalId].Properties;
      expect(dlq).not.toHaveProperty('VisibilityTimeout');
    });

    it('redrives to the dead-letter queue after 5 receives', () => {
      template.hasResourceProperties(QUEUE_TYPE, {
        QueueName: 'claimflow-cleanup',
        RedrivePolicy: {
          deadLetterTargetArn: arnOf(dlqLogicalId),
          maxReceiveCount: 5,
        },
      });
      const dlq = template.toJSON().Resources[dlqLogicalId].Properties;
      expect(dlq).not.toHaveProperty('RedrivePolicy');
    });

    it('enforces TLS on both queues', () => {
      for (const logicalId of [cleanupQueueLogicalId, dlqLogicalId]) {
        expect(queuePolicyStatements(logicalId)).toContainEqual(
          denyInsecureQueueTransport(logicalId),
        );
      }
    });

    it('routes only the two cleanup detail types from claimflow.api', () => {
      template.resourceCountIs(RULE_TYPE, 1);
      template.hasResourceProperties(RULE_TYPE, {
        EventBusName: { Ref: busLogicalId },
        State: 'ENABLED',
        EventPattern: {
          source: ['claimflow.api'],
          'detail-type': [
            'internal.receipt-object-deletion-requested',
            'internal.claim-history-purge-requested',
          ],
        },
      });
      expect(CLAIMFLOW_EVENT_SOURCE).toBe('claimflow.api');
      expect([...CLAIMFLOW_CLEANUP_EVENT_TYPES]).toEqual([
        'internal.receipt-object-deletion-requested',
        'internal.claim-history-purge-requested',
      ]);
      const pattern =
        template.toJSON().Resources[ruleLogicalId].Properties.EventPattern;
      expect(Object.keys(pattern).sort()).toEqual(['detail-type', 'source']);
    });

    it('targets only the cleanup queue, with the shared dead-letter queue', () => {
      const { Targets } = template.toJSON().Resources[ruleLogicalId].Properties;
      expect(Targets).toEqual([
        {
          Arn: arnOf(cleanupQueueLogicalId),
          DeadLetterConfig: { Arn: arnOf(dlqLogicalId) },
          Id: 'Target0',
        },
      ]);
    });

    it('lets only this rule send to the cleanup queue', () => {
      const statements = queuePolicyStatements(cleanupQueueLogicalId);
      expect(statements).toHaveLength(2);
      expect(statements).toContainEqual({
        Effect: 'Allow',
        Principal: { Service: 'events.amazonaws.com' },
        Action: [
          'sqs:SendMessage',
          'sqs:GetQueueAttributes',
          'sqs:GetQueueUrl',
        ],
        Resource: arnOf(cleanupQueueLogicalId),
        Condition: { ArnEquals: { 'aws:SourceArn': arnOf(ruleLogicalId) } },
      });
    });

    it('lets only this rule send to the dead-letter queue', () => {
      const statements = queuePolicyStatements(dlqLogicalId);
      expect(statements).toHaveLength(2);
      expect(statements).toContainEqual(
        expect.objectContaining({
          Effect: 'Allow',
          Principal: { Service: 'events.amazonaws.com' },
          Action: 'sqs:SendMessage',
          Resource: arnOf(dlqLogicalId),
          Condition: { ArnEquals: { 'aws:SourceArn': arnOf(ruleLogicalId) } },
        }),
      );
    });

    it('exports the event bus name and cleanup queue URL', () => {
      template.hasOutput('EventBusName', { Value: { Ref: busLogicalId } });
      template.hasOutput('CleanupQueueUrl', {
        Value: { Ref: cleanupQueueLogicalId },
      });
    });
  });

  describe('cleanup worker', () => {
    let functionLogicalId: string;
    let roleLogicalId: string;
    let logGroupLogicalId: string;
    let queueLogicalId: string;
    let dlqLogicalId: string;
    let tableId: string;

    const arnOf = (logicalId: string) => ({ 'Fn::GetAtt': [logicalId, 'Arn'] });

    const statements = (): Record<string, any>[] => {
      const policies = Object.values(
        template.findResources(IAM_POLICY_TYPE, {
          Properties: { Roles: [{ Ref: roleLogicalId }] },
        }),
      ) as TableResource[];
      expect(policies).toHaveLength(1);
      return policies[0].Properties.PolicyDocument.Statement;
    };

    beforeAll(() => {
      [functionLogicalId] = resourceOf(stack.cleanupWorker);
      roleLogicalId = (
        template.toJSON().Resources as Record<string, TableResource>
      )[functionLogicalId].Properties.Role['Fn::GetAtt'][0];
      [logGroupLogicalId] = resourceOf(stack.cleanupWorkerLogGroup);
      [queueLogicalId] = resourceOf(stack.cleanupQueue);
      [dlqLogicalId] = resourceOf(stack.cleanupDeadLetterQueue);
      [tableId] = Object.keys(template.findResources(TABLE_TYPE));
    });

    const functionProperties = () =>
      template.toJSON().Resources[functionLogicalId].Properties;

    it('defines a role, policy, log group and mapping per function', () => {
      template.resourceCountIs(FUNCTION_TYPE, 2);
      template.resourceCountIs(ROLE_TYPE, 2);
      template.resourceCountIs(IAM_POLICY_TYPE, 2);
      template.resourceCountIs(LOG_GROUP_TYPE, 2);
      template.resourceCountIs(MAPPING_TYPE, 2);
      template.resourceCountIs('AWS::Lambda::Permission', 0);
    });

    it('configures the function', () => {
      expect(CLAIMFLOW_CLEANUP_WORKER_NAME).toBe('claimflow-cleanup-worker');
      template.hasResourceProperties(FUNCTION_TYPE, {
        FunctionName: 'claimflow-cleanup-worker',
        Runtime: 'nodejs24.x',
        Architectures: ['arm64'],
        MemorySize: 256,
        Timeout: 60,
        Handler: 'index.handler',
        Role: arnOf(roleLogicalId),
        LoggingConfig: { LogGroup: { Ref: logGroupLogicalId } },
      });
      const properties = functionProperties();
      expect(properties).not.toHaveProperty('TracingConfig');
      expect(properties).not.toHaveProperty('ReservedConcurrentExecutions');
      expect(properties).not.toHaveProperty('DeadLetterConfig');
      expect(properties).not.toHaveProperty('Layers');
    });

    it('passes only the table and receipt bucket names', () => {
      expect(functionProperties().Environment).toEqual({
        Variables: {
          CLAIMFLOW_TABLE_NAME: { Ref: tableId },
          CLAIMFLOW_RECEIPT_BUCKET_NAME: { Ref: bucketLogicalId },
        },
      });
    });

    it('uses a bundled code asset', () => {
      const { Code } = functionProperties();
      expect(Code).toHaveProperty('S3Key');
      expect(Code).not.toHaveProperty('ZipFile');
    });

    it('has a dedicated log group with 30 day retention', () => {
      template.hasResourceProperties(LOG_GROUP_TYPE, {
        LogGroupName: '/aws/lambda/claimflow-cleanup-worker',
        RetentionInDays: 30,
      });
    });

    it('lets only Lambda assume the role, with no managed policies', () => {
      const role = template.toJSON().Resources[roleLogicalId].Properties;
      expect(role.AssumeRolePolicyDocument.Statement).toEqual([
        {
          Action: 'sts:AssumeRole',
          Effect: 'Allow',
          Principal: { Service: 'lambda.amazonaws.com' },
        },
      ]);
      expect(role).not.toHaveProperty('ManagedPolicyArns');
      template.hasResourceProperties(IAM_POLICY_TYPE, {
        Roles: [{ Ref: roleLogicalId }],
      });
    });

    it('grants exactly the four scoped permissions', () => {
      expect(statements()).toEqual([
        {
          Effect: 'Allow',
          Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
          Resource: arnOf(logGroupLogicalId),
        },
        {
          Effect: 'Allow',
          Action: [
            'sqs:ReceiveMessage',
            'sqs:ChangeMessageVisibility',
            'sqs:GetQueueUrl',
            'sqs:DeleteMessage',
            'sqs:GetQueueAttributes',
          ],
          Resource: arnOf(queueLogicalId),
        },
        {
          Effect: 'Allow',
          Action: ['dynamodb:Query', 'dynamodb:BatchWriteItem'],
          Resource: arnOf(tableId),
        },
        {
          Effect: 'Allow',
          Action: 's3:DeleteObject',
          Resource: {
            'Fn::Join': ['', [arnOf(bucketLogicalId), '/receipts/*']],
          },
        },
      ]);
    });

    it('grants nothing on indexes, pending objects, the bucket, the dead-letter queue or wildcards', () => {
      const json = JSON.stringify(statements());
      expect(json).not.toContain('/index/');
      expect(json).not.toContain('uploads');
      expect(json).not.toContain(dlqLogicalId);
      expect(json).not.toContain('"*"');
      for (const statement of statements()) {
        expect(statement).not.toHaveProperty('NotAction');
        expect(statement).not.toHaveProperty('NotResource');
        expect(statement.Action).not.toContain('*');
      }
    });

    it('maps the cleanup queue in batches of 10 with partial failures', () => {
      template.hasResourceProperties(MAPPING_TYPE, {
        EventSourceArn: arnOf(queueLogicalId),
        FunctionName: { Ref: functionLogicalId },
        BatchSize: 10,
        FunctionResponseTypes: ['ReportBatchItemFailures'],
      });
      const [mapping] = Object.values(
        template.findResources(MAPPING_TYPE, {
          Properties: { FunctionName: { Ref: functionLogicalId } },
        }),
      ) as TableResource[];
      expect(mapping.Properties).not.toHaveProperty(
        'MaximumBatchingWindowInSeconds',
      );
      expect(mapping.Properties).not.toHaveProperty('ScalingConfig');
    });

    it('does not consume the dead-letter queue', () => {
      const sources = Object.values(
        template.findResources(MAPPING_TYPE, {
          Properties: { FunctionName: { Ref: functionLogicalId } },
        }),
      ).map((mapping) => (mapping as TableResource).Properties.EventSourceArn);
      expect(sources).toEqual([arnOf(queueLogicalId)]);
    });

    it('keeps the 6 minute visibility timeout and 5 receive redrive', () => {
      template.hasResourceProperties(QUEUE_TYPE, {
        QueueName: 'claimflow-cleanup',
        VisibilityTimeout: 360,
        RedrivePolicy: { maxReceiveCount: 5 },
      });
    });
  });

  describe('outbox publisher', () => {
    let functionLogicalId: string;
    let roleLogicalId: string;
    let logGroupLogicalId: string;
    let failureQueueLogicalId: string;
    let tableId: string;
    let busId: string;

    const arnOf = (logicalId: string) => ({ 'Fn::GetAtt': [logicalId, 'Arn'] });
    const streamArn = () => ({ 'Fn::GetAtt': [tableId, 'StreamArn'] });
    const resources = () =>
      template.toJSON().Resources as Record<string, TableResource>;

    const statements = (): Record<string, any>[] => {
      const policies = Object.values(
        template.findResources(IAM_POLICY_TYPE, {
          Properties: { Roles: [{ Ref: roleLogicalId }] },
        }),
      ) as TableResource[];
      expect(policies).toHaveLength(1);
      return policies[0].Properties.PolicyDocument.Statement;
    };

    const mapping = (): TableResource => {
      const found = Object.values(
        template.findResources(MAPPING_TYPE, {
          Properties: { FunctionName: { Ref: functionLogicalId } },
        }),
      ) as TableResource[];
      expect(found).toHaveLength(1);
      return found[0];
    };

    beforeAll(() => {
      [functionLogicalId] = resourceOf(stack.outboxPublisher);
      [logGroupLogicalId] = resourceOf(stack.outboxPublisherLogGroup);
      [failureQueueLogicalId] = resourceOf(stack.outboxFailureQueue);
      [tableId] = Object.keys(template.findResources(TABLE_TYPE));
      [busId] = resourceOf(stack.eventBus);
      roleLogicalId =
        resources()[functionLogicalId].Properties.Role['Fn::GetAtt'][0];
    });

    it('configures the function', () => {
      expect(CLAIMFLOW_OUTBOX_PUBLISHER_NAME).toBe(
        'claimflow-outbox-publisher',
      );
      template.hasResourceProperties(FUNCTION_TYPE, {
        FunctionName: 'claimflow-outbox-publisher',
        Runtime: 'nodejs24.x',
        Architectures: ['arm64'],
        MemorySize: 256,
        Timeout: 60,
        Handler: 'index.handler',
        Role: arnOf(roleLogicalId),
        LoggingConfig: { LogGroup: { Ref: logGroupLogicalId } },
      });
      const properties = resources()[functionLogicalId].Properties;
      expect(properties).not.toHaveProperty('TracingConfig');
      expect(properties).not.toHaveProperty('ReservedConcurrentExecutions');
      expect(properties).not.toHaveProperty('Layers');
      expect(properties.Code).toHaveProperty('S3Key');
    });

    it('passes only the table and event bus names', () => {
      expect(resources()[functionLogicalId].Properties.Environment).toEqual({
        Variables: {
          CLAIMFLOW_TABLE_NAME: { Ref: tableId },
          CLAIMFLOW_EVENT_BUS_NAME: { Ref: busId },
        },
      });
    });

    it('has a dedicated log group with 30 day retention', () => {
      template.hasResourceProperties(LOG_GROUP_TYPE, {
        LogGroupName: '/aws/lambda/claimflow-outbox-publisher',
        RetentionInDays: 30,
      });
    });

    it('has its own role, assumed only by Lambda, with no managed policies', () => {
      expect(roleLogicalId).not.toBe(
        resources()[resourceOf(stack.cleanupWorker)[0]].Properties.Role[
          'Fn::GetAtt'
        ][0],
      );
      const role = resources()[roleLogicalId].Properties;
      expect(role.AssumeRolePolicyDocument.Statement).toEqual([
        {
          Action: 'sts:AssumeRole',
          Effect: 'Allow',
          Principal: { Service: 'lambda.amazonaws.com' },
        },
      ]);
      expect(role).not.toHaveProperty('ManagedPolicyArns');
    });

    it('grants exactly the scoped permissions', () => {
      expect(statements()).toEqual([
        {
          Effect: 'Allow',
          Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
          Resource: arnOf(logGroupLogicalId),
        },
        {
          Effect: 'Allow',
          Action: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
          Resource: arnOf(tableId),
        },
        {
          Effect: 'Allow',
          Action: 'events:PutEvents',
          Resource: arnOf(busId),
        },
        {
          Effect: 'Allow',
          Action: [
            'sqs:SendMessage',
            'sqs:GetQueueAttributes',
            'sqs:GetQueueUrl',
          ],
          Resource: arnOf(failureQueueLogicalId),
        },
        {
          Effect: 'Allow',
          Action: 'dynamodb:ListStreams',
          Resource: streamArn(),
        },
        {
          Effect: 'Allow',
          Action: [
            'dynamodb:DescribeStream',
            'dynamodb:GetRecords',
            'dynamodb:GetShardIterator',
          ],
          Resource: streamArn(),
        },
      ]);
    });

    it('grants no wildcard, index, query, scan, write or read-all access', () => {
      const json = JSON.stringify(statements());
      expect(json).not.toContain('/index/');
      expect(json).not.toContain('"*"');
      expect(json).not.toMatch(/dynamodb:(Query|Scan|PutItem|DeleteItem)/);
      expect(json).not.toContain('s3:');
      for (const statement of statements()) {
        expect(statement).not.toHaveProperty('NotAction');
        expect(statement).not.toHaveProperty('NotResource');
        expect(statement.Action).not.toContain('*');
      }
    });

    it('defines an encrypted failure queue that enforces TLS', () => {
      const queue = resources()[failureQueueLogicalId].Properties;
      expect(CLAIMFLOW_OUTBOX_FAILURE_QUEUE_NAME).toBe(
        'claimflow-outbox-publisher-failures',
      );
      expect(queue).toEqual({
        QueueName: 'claimflow-outbox-publisher-failures',
        SqsManagedSseEnabled: true,
        MessageRetentionPeriod: 14 * 24 * 60 * 60,
      });
      const [policy] = Object.values(
        template.findResources(QUEUE_POLICY_TYPE, {
          Properties: { Queues: [{ Ref: failureQueueLogicalId }] },
        }),
      ) as TableResource[];
      expect(policy.Properties.PolicyDocument.Statement).toEqual([
        {
          Effect: 'Deny',
          Principal: { AWS: '*' },
          Action: 'sqs:*',
          Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          Resource: arnOf(failureQueueLogicalId),
        },
      ]);
    });

    it('maps the table stream with the approved settings', () => {
      const { Properties } = mapping();
      expect(Properties).toEqual({
        EventSourceArn: streamArn(),
        FunctionName: { Ref: functionLogicalId },
        StartingPosition: 'LATEST',
        BatchSize: 10,
        FunctionResponseTypes: ['ReportBatchItemFailures'],
        BisectBatchOnFunctionError: true,
        MaximumRetryAttempts: 5,
        MaximumRecordAgeInSeconds: 24 * 60 * 60,
        DestinationConfig: {
          OnFailure: { Destination: arnOf(failureQueueLogicalId) },
        },
        FilterCriteria: { Filters: [{ Pattern: expect.any(String) }] },
      });
    });

    it('filters for INSERT records whose sort key starts with OUTBOX#', () => {
      const [filter] = mapping().Properties.FilterCriteria.Filters;
      expect(JSON.parse(filter.Pattern)).toEqual({
        eventName: ['INSERT'],
        dynamodb: { Keys: { SK: { S: [{ prefix: 'OUTBOX#' }] } } },
      });
    });

    it('is the only consumer of the table stream', () => {
      const sources = Object.values(template.findResources(MAPPING_TYPE)).map(
        (found) => (found as TableResource).Properties.EventSourceArn,
      );
      expect(sources).toHaveLength(2);
      expect(sources).toContainEqual(streamArn());
    });
  });

  describe('web app client', () => {
    const webUrl = (path: string) => ({
      'Fn::Join': [
        '',
        [
          'https://',
          { 'Fn::GetAtt': [distributionLogicalId, 'DomainName'] },
          path,
        ],
      ],
    });

    it('is the only app client, named ClaimFlowWeb, on the ClaimFlow user pool', () => {
      template.resourceCountIs(CLIENT_TYPE, 1);
      expect(webClient.Properties.ClientName).toBe('ClaimFlowWeb');
      expect(webClient.Properties.UserPoolId).toEqual({
        Ref: userPoolLogicalId,
      });
    });

    it('is a public client without a secret', () => {
      expect(webClient.Properties.GenerateSecret).toBe(false);
    });

    it('allows only the authorization code grant', () => {
      expect(webClient.Properties.AllowedOAuthFlowsUserPoolClient).toBe(true);
      expect(webClient.Properties.AllowedOAuthFlows).toEqual(['code']);
    });

    it('allows no direct sign-in flows, only token refresh', () => {
      expect(webClient.Properties.ExplicitAuthFlows).toEqual([
        'ALLOW_REFRESH_TOKEN_AUTH',
      ]);
    });

    it('uses the user pool as the only identity provider', () => {
      expect(webClient.Properties.SupportedIdentityProviders).toEqual([
        'COGNITO',
      ]);
    });

    it('limits OAuth scopes to openid and email', () => {
      expect(webClient.Properties.AllowedOAuthScopes).toEqual([
        'openid',
        'email',
      ]);
    });

    it('redirects only to the CloudFront and local callback routes, defaulting to CloudFront', () => {
      expect(webClient.Properties.CallbackURLs).toEqual([
        webUrl('/auth/callback'),
        'http://localhost:5173/auth/callback',
      ]);
      expect(webClient.Properties.DefaultRedirectURI).toEqual(
        webUrl('/auth/callback'),
      );
    });

    it('signs out only to the CloudFront and local application roots', () => {
      expect(webClient.Properties.LogoutURLs).toEqual([
        webUrl('/'),
        'http://localhost:5173/',
      ]);
    });

    it('issues one-hour access and ID tokens and 30-day refresh tokens', () => {
      expect(webClient.Properties).toMatchObject({
        AccessTokenValidity: 60,
        IdTokenValidity: 60,
        RefreshTokenValidity: 30 * 24 * 60,
        TokenValidityUnits: {
          AccessToken: 'minutes',
          IdToken: 'minutes',
          RefreshToken: 'minutes',
        },
      });
    });

    it('enables token revocation and prevents user existence errors', () => {
      expect(webClient.Properties.EnableTokenRevocation).toBe(true);
      expect(webClient.Properties.PreventUserExistenceErrors).toBe('ENABLED');
    });
  });

  describe('classic hosted UI', () => {
    it('uses a Cognito prefix domain derived from ClaimFlow and the account, with the classic hosted UI', () => {
      template.resourceCountIs(DOMAIN_TYPE, 1);
      expect(domain.Properties).toEqual({
        Domain: 'claimflow-123456789012',
        ManagedLoginVersion: 1,
        UserPoolId: { Ref: userPoolLogicalId },
      });
    });

    it('keeps the user pool on the Lite feature plan', () => {
      expect(userPool.Properties.UserPoolTier).toBe('LITE');
    });

    it('derives the domain prefix from the deploying account', () => {
      const other = new ClaimFlowStack(new App(), 'ClaimFlow', {
        env: { account: '210987654321', region: CLAIMFLOW_REGION },
      });
      Template.fromStack(other).hasResourceProperties(DOMAIN_TYPE, {
        Domain: 'claimflow-210987654321',
      });
    });

    it('has no managed login branding or custom hosted UI styling', () => {
      template.resourceCountIs('AWS::Cognito::ManagedLoginBranding', 0);
      template.resourceCountIs(
        'AWS::Cognito::UserPoolUICustomizationAttachment',
        0,
      );
    });
  });
});
