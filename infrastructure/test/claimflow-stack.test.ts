import { Match, Template } from 'aws-cdk-lib/assertions';
import { build } from 'esbuild';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { App, type CfnElement } from 'aws-cdk-lib/core';
import type { IConstruct } from 'constructs';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  CLAIMFLOW_ALARM_EMAIL_PARAMETER,
  CLAIMFLOW_ALARM_TOPIC_NAME,
  CLAIMFLOW_CLEANUP_DLQ_NAME,
  CLAIMFLOW_THIRD_PARTY_NOTICES_FILE,
  CLAIMFLOW_CLEANUP_EVENT_TYPES,
  CLAIMFLOW_CLEANUP_QUEUE_NAME,
  CLAIMFLOW_CLEANUP_WORKER_NAME,
  CLAIMFLOW_OUTBOX_FAILURE_QUEUE_NAME,
  CLAIMFLOW_JANITOR_FAILURE_QUEUE_NAME,
  CLAIMFLOW_OUTBOX_PUBLISHER_NAME,
  CLAIMFLOW_API_FUNCTION_NAME,
  CLAIMFLOW_API_PROTECTED_ROUTES,
  CLAIMFLOW_API_PUBLIC_ROUTES,
  CLAIMFLOW_API_REQUIRED_SCOPE,
  CLAIMFLOW_OUTBOX_SWEEPER_NAME,
  CLAIMFLOW_RECEIPT_JANITOR_NAME,
  CLAIMFLOW_EVENT_BUS_NAME,
  CLAIMFLOW_EVENT_SOURCE,
  CLAIMFLOW_REGION,
  CLAIMFLOW_STACK_DESCRIPTION,
  ClaimFlowStack,
} from '../lib/claimflow-stack';
import { createAwsRoutes } from '../../services/api/src/http/routes';

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
  readonly Type?: string;
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
          QUEUE_TYPE,
          QUEUE_POLICY_TYPE,
          FUNCTION_TYPE,
          MAPPING_TYPE,
          ROLE_TYPE,
          IAM_POLICY_TYPE,
          LOG_GROUP_TYPE,
          RULE_TYPE,
          FUNCTION_TYPE,
          ROLE_TYPE,
          IAM_POLICY_TYPE,
          LOG_GROUP_TYPE,
          FUNCTION_TYPE,
          ROLE_TYPE,
          IAM_POLICY_TYPE,
          LOG_GROUP_TYPE,
          'AWS::Lambda::Permission',
          'AWS::ApiGatewayV2::Api',
          'AWS::ApiGatewayV2::Integration',
          'AWS::ApiGatewayV2::Authorizer',
          'AWS::ApiGatewayV2::Stage',
          ...Array.from({ length: 24 }, () => 'AWS::ApiGatewayV2::Route'),
          ...Array.from({ length: 24 }, () => 'AWS::Lambda::Permission'),
          ...Array.from({ length: 17 }, () => 'AWS::CloudWatch::Alarm'),
          'AWS::SNS::Topic',
          'AWS::SNS::TopicPolicy',
          'AWS::SNS::Subscription',
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
      'AWS::ApiGateway::RestApi',
      'AWS::SES::EmailIdentity',
      'AWS::IAM::User',
      'AWS::Lambda::LayerVersion',
      'AWS::IAM::ManagedPolicy',
      'AWS::Events::Archive',
      'AWS::Events::Connection',
      'AWS::Events::ApiDestination',
      'AWS::Pipes::Pipe',
      'AWS::Scheduler::Schedule',
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

    it('has no website hosting or auto-delete', () => {
      expect(bucket.Properties).not.toHaveProperty('WebsiteConfiguration');
      expect(JSON.stringify(bucket)).not.toContain('auto-delete');
    });

    describe('CORS', () => {
      const rules = (): Record<string, any>[] =>
        bucket.Properties.CorsConfiguration.CorsRules;

      it('has exactly one rule', () => {
        expect(rules()).toHaveLength(1);
        expect(Object.keys(bucket.Properties.CorsConfiguration)).toEqual([
          'CorsRules',
        ]);
      });

      it('allows POST with any request header from the web origin only', () => {
        expect(rules()).toEqual([
          {
            AllowedOrigins: [
              {
                'Fn::Join': [
                  '',
                  [
                    'https://',
                    { 'Fn::GetAtt': [distributionLogicalId, 'DomainName'] },
                  ],
                ],
              },
            ],
            AllowedMethods: ['POST'],
            AllowedHeaders: ['*'],
          },
        ]);
      });

      it('allows no wildcard or localhost origin and no other method', () => {
        const [rule] = rules();
        const json = JSON.stringify(rule.AllowedOrigins);
        expect(json).not.toContain('"*"');
        expect(json).not.toContain('localhost');
        expect(json).not.toContain('http://');
        expect(rule.AllowedOrigins).toHaveLength(1);
        for (const method of ['GET', 'PUT', 'DELETE', 'HEAD']) {
          expect(rule.AllowedMethods).not.toContain(method);
        }
      });

      it('exposes no response headers and sets no cache duration', () => {
        const [rule] = rules();
        expect(rule).not.toHaveProperty('ExposedHeaders');
        expect(rule).not.toHaveProperty('MaxAge');
        expect(rule).not.toHaveProperty('Id');
      });

      it('leaves the web assets bucket without CORS', () => {
        expect(webBucket.Properties).not.toHaveProperty('CorsConfiguration');
      });
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
      [ruleLogicalId] = Object.keys(
        template.findResources(RULE_TYPE, {
          Properties: { Name: 'claimflow-cleanup' },
        }),
      );
    });

    it('defines a custom event bus named claimflow', () => {
      expect(CLAIMFLOW_EVENT_BUS_NAME).toBe('claimflow');
      template.resourceCountIs(EVENT_BUS_TYPE, 1);
      template.hasResourceProperties(EVENT_BUS_TYPE, { Name: 'claimflow' });
    });

    it('defines four queues in total, two for cleanup', () => {
      template.resourceCountIs(QUEUE_TYPE, 4);
      template.resourceCountIs(QUEUE_POLICY_TYPE, 4);
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
      template.resourceCountIs(RULE_TYPE, 2);
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
      template.resourceCountIs(FUNCTION_TYPE, 5);
      template.resourceCountIs(ROLE_TYPE, 5);
      template.resourceCountIs(IAM_POLICY_TYPE, 5);
      template.resourceCountIs(LOG_GROUP_TYPE, 5);
      template.resourceCountIs(MAPPING_TYPE, 3);
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
  });

  describe('receipt janitor', () => {
    let functionLogicalId: string;
    let roleLogicalId: string;
    let logGroupLogicalId: string;
    let failureQueueLogicalId: string;
    let tableId: string;
    let publisherLogicalId: string;

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
      [functionLogicalId] = resourceOf(stack.receiptJanitor);
      [logGroupLogicalId] = resourceOf(stack.receiptJanitorLogGroup);
      [failureQueueLogicalId] = resourceOf(stack.janitorFailureQueue);
      [publisherLogicalId] = resourceOf(stack.outboxPublisher);
      [tableId] = Object.keys(template.findResources(TABLE_TYPE));
      roleLogicalId =
        resources()[functionLogicalId].Properties.Role['Fn::GetAtt'][0];
    });

    it('configures the function', () => {
      expect(CLAIMFLOW_RECEIPT_JANITOR_NAME).toBe('claimflow-receipt-janitor');
      template.hasResourceProperties(FUNCTION_TYPE, {
        FunctionName: 'claimflow-receipt-janitor',
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

    it('passes only the receipt bucket name', () => {
      expect(resources()[functionLogicalId].Properties.Environment).toEqual({
        Variables: { CLAIMFLOW_RECEIPT_BUCKET_NAME: { Ref: bucketLogicalId } },
      });
    });

    it('has a dedicated log group with 30 day retention', () => {
      template.hasResourceProperties(LOG_GROUP_TYPE, {
        LogGroupName: '/aws/lambda/claimflow-receipt-janitor',
        RetentionInDays: 30,
      });
    });

    it('has its own role, assumed only by Lambda, with no managed policies', () => {
      const publisherRole =
        resources()[publisherLogicalId].Properties.Role['Fn::GetAtt'][0];
      expect(roleLogicalId).not.toBe(publisherRole);
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
          Action: 's3:DeleteObject',
          Resource: [
            { 'Fn::Join': ['', [arnOf(bucketLogicalId), '/receipts/*']] },
            {
              'Fn::Join': ['', [arnOf(bucketLogicalId), '/uploads/pending/*']],
            },
          ],
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

    it('grants no table item, index, bucket-wide or wildcard access', () => {
      const json = JSON.stringify(statements());
      expect(json).not.toMatch(
        /dynamodb:(GetItem|PutItem|UpdateItem|DeleteItem|Query|Scan|BatchWriteItem)/,
      );
      expect(json).not.toContain('/index/');
      expect(json).not.toContain('"*"');
      expect(json).not.toMatch(/s3:(Get|Put|List)/);
      expect(json).not.toContain('events:');
      expect(json).not.toContain(JSON.stringify(arnOf(tableId)));
      for (const statement of statements()) {
        expect(statement).not.toHaveProperty('NotAction');
        expect(statement).not.toHaveProperty('NotResource');
        expect(statement.Action).not.toContain('*');
      }
    });

    it('defines an encrypted failure queue that enforces TLS', () => {
      expect(CLAIMFLOW_JANITOR_FAILURE_QUEUE_NAME).toBe(
        'claimflow-receipt-janitor-failures',
      );
      expect(resources()[failureQueueLogicalId].Properties).toEqual({
        QueueName: 'claimflow-receipt-janitor-failures',
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
      expect(mapping().Properties).toEqual({
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

    it('filters for TTL removals of pending receipts by the DynamoDB service', () => {
      const [filter] = mapping().Properties.FilterCriteria.Filters;
      expect(JSON.parse(filter.Pattern)).toEqual({
        eventName: ['REMOVE'],
        userIdentity: {
          type: ['Service'],
          principalId: ['dynamodb.amazonaws.com'],
        },
        dynamodb: {
          OldImage: {
            entityType: { S: ['Receipt'] },
            state: { S: ['PENDING'] },
          },
        },
      });
    });

    it('gives the table stream exactly the publisher and janitor consumers', () => {
      const consumers = Object.values(
        template.findResources(MAPPING_TYPE, {
          Properties: { EventSourceArn: streamArn() },
        }),
      ).map((found) => (found as TableResource).Properties.FunctionName);
      expect(consumers).toHaveLength(2);
      expect(consumers).toContainEqual({ Ref: publisherLogicalId });
      expect(consumers).toContainEqual({ Ref: functionLogicalId });
    });
  });

  describe('outbox sweeper', () => {
    let functionLogicalId: string;
    let roleLogicalId: string;
    let logGroupLogicalId: string;
    let scheduleLogicalId: string;
    let tableId: string;
    let busId: string;

    const arnOf = (logicalId: string) => ({ 'Fn::GetAtt': [logicalId, 'Arn'] });
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

    beforeAll(() => {
      [functionLogicalId] = resourceOf(stack.outboxSweeper);
      [logGroupLogicalId] = resourceOf(stack.outboxSweeperLogGroup);
      [scheduleLogicalId] = resourceOf(stack.outboxSweeperSchedule);
      [tableId] = Object.keys(template.findResources(TABLE_TYPE));
      [busId] = resourceOf(stack.eventBus);
      roleLogicalId =
        resources()[functionLogicalId].Properties.Role['Fn::GetAtt'][0];
    });

    it('configures the function', () => {
      expect(CLAIMFLOW_OUTBOX_SWEEPER_NAME).toBe('claimflow-outbox-sweeper');
      template.hasResourceProperties(FUNCTION_TYPE, {
        FunctionName: 'claimflow-outbox-sweeper',
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
      expect(properties).not.toHaveProperty('DeadLetterConfig');
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
        LogGroupName: '/aws/lambda/claimflow-outbox-sweeper',
        RetentionInDays: 30,
      });
    });

    it('has its own role, assumed only by Lambda, with no managed policies', () => {
      for (const other of [
        stack.cleanupWorker,
        stack.outboxPublisher,
        stack.receiptJanitor,
      ]) {
        const otherRole =
          resources()[resourceOf(other)[0]].Properties.Role['Fn::GetAtt'][0];
        expect(roleLogicalId).not.toBe(otherRole);
      }
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
          Action: 'dynamodb:Query',
          Resource: { 'Fn::Join': ['', [arnOf(tableId), '/index/GSI4']] },
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
      ]);
    });

    it('grants no stream, S3, SQS, wildcard or other index access', () => {
      const json = JSON.stringify(statements());
      expect(json).not.toMatch(/dynamodb:(Scan|PutItem|DeleteItem|Batch)/);
      expect(json).not.toMatch(/dynamodb:\w*Stream/);
      expect(json).not.toContain('StreamArn');
      expect(json).not.toContain('s3:');
      expect(json).not.toContain('sqs:');
      expect(json).not.toContain('"*"');
      expect(json).not.toMatch(/index\/GSI[123]/);
      for (const statement of statements()) {
        expect(statement).not.toHaveProperty('NotAction');
        expect(statement).not.toHaveProperty('NotResource');
        expect(statement.Action).not.toContain('*');
      }
    });

    it('runs every 15 minutes on the default bus', () => {
      template.hasResourceProperties(RULE_TYPE, {
        Name: 'claimflow-outbox-sweeper-schedule',
        ScheduleExpression: 'rate(15 minutes)',
        State: 'ENABLED',
      });
      const rule = resources()[scheduleLogicalId].Properties;
      expect(rule).not.toHaveProperty('EventBusName');
      expect(rule).not.toHaveProperty('EventPattern');
    });

    it('targets only the sweeper with 2 retries and a 1 hour event age', () => {
      expect(resources()[scheduleLogicalId].Properties.Targets).toEqual([
        {
          Arn: arnOf(functionLogicalId),
          Id: 'Target0',
          RetryPolicy: {
            MaximumRetryAttempts: 2,
            MaximumEventAgeInSeconds: 3600,
          },
        },
      ]);
    });

    it('has no failure queue or dead-letter target', () => {
      const target = resources()[scheduleLogicalId].Properties.Targets[0];
      expect(target).not.toHaveProperty('DeadLetterConfig');
      template.resourceCountIs(QUEUE_TYPE, 4);
    });

    it('lets only the schedule invoke the sweeper', () => {
      template.resourceCountIs('AWS::Lambda::Permission', 1 + 24);
      template.hasResourceProperties('AWS::Lambda::Permission', {
        Action: 'lambda:InvokeFunction',
        FunctionName: arnOf(functionLogicalId),
        Principal: 'events.amazonaws.com',
        SourceArn: arnOf(scheduleLogicalId),
      });
    });

    it('has no event-source mapping', () => {
      template.resourceCountIs(MAPPING_TYPE, 3);
      const functions = Object.values(template.findResources(MAPPING_TYPE)).map(
        (found) => (found as TableResource).Properties.FunctionName,
      );
      expect(functions).not.toContainEqual({ Ref: functionLogicalId });
    });
  });

  describe('API function', () => {
    let functionLogicalId: string;
    let roleLogicalId: string;
    let logGroupLogicalId: string;
    let tableId: string;
    let bucketId: string;

    const arnOf = (logicalId: string) => ({ 'Fn::GetAtt': [logicalId, 'Arn'] });
    const resources = () =>
      template.toJSON().Resources as Record<string, TableResource>;
    const objects = (pattern: string) => ({
      'Fn::Join': ['', [arnOf(bucketId), pattern]],
    });

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
      [functionLogicalId] = resourceOf(stack.apiFunction);
      [logGroupLogicalId] = resourceOf(stack.apiFunctionLogGroup);
      [tableId] = Object.keys(template.findResources(TABLE_TYPE));
      bucketId = bucketLogicalId;
      roleLogicalId =
        resources()[functionLogicalId].Properties.Role['Fn::GetAtt'][0];
    });

    it('configures the function', () => {
      expect(CLAIMFLOW_API_FUNCTION_NAME).toBe('claimflow-api');
      template.hasResourceProperties(FUNCTION_TYPE, {
        FunctionName: 'claimflow-api',
        Runtime: 'nodejs24.x',
        Architectures: ['arm64'],
        MemorySize: 512,
        Timeout: 29,
        Handler: 'index.handler',
        Role: arnOf(roleLogicalId),
        LoggingConfig: { LogGroup: { Ref: logGroupLogicalId } },
      });
      const properties = resources()[functionLogicalId].Properties;
      expect(properties).not.toHaveProperty('TracingConfig');
      expect(properties).not.toHaveProperty('VpcConfig');
      expect(properties).not.toHaveProperty('ReservedConcurrentExecutions');
      expect(properties).not.toHaveProperty('DeadLetterConfig');
      expect(properties).not.toHaveProperty('Layers');
      expect(properties.Code).toHaveProperty('S3Key');
    });

    it('passes only the table and receipt bucket names', () => {
      expect(resources()[functionLogicalId].Properties.Environment).toEqual({
        Variables: {
          CLAIMFLOW_TABLE_NAME: { Ref: tableId },
          CLAIMFLOW_RECEIPT_BUCKET_NAME: { Ref: bucketId },
        },
      });
    });

    it('bundles the entry point into a zip asset with no layer', () => {
      // CDK bundles the SDK and workspace sources at synth time.
      const properties = resources()[functionLogicalId].Properties;
      expect(properties.Code.S3Key).toMatch(/\.zip$/);
      expect(properties).not.toHaveProperty('Layers');
    });

    it('has a dedicated log group with 30 day retention', () => {
      template.hasResourceProperties(LOG_GROUP_TYPE, {
        LogGroupName: '/aws/lambda/claimflow-api',
        RetentionInDays: 30,
      });
    });

    it('has its own role, assumed only by Lambda, with no managed policies', () => {
      for (const other of [
        stack.cleanupWorker,
        stack.outboxPublisher,
        stack.receiptJanitor,
        stack.outboxSweeper,
      ]) {
        const otherRole =
          resources()[resourceOf(other)[0]].Properties.Role['Fn::GetAtt'][0];
        expect(roleLogicalId).not.toBe(otherRole);
      }
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
          Action: [
            'dynamodb:GetItem',
            'dynamodb:BatchGetItem',
            'dynamodb:Query',
            'dynamodb:PutItem',
            'dynamodb:UpdateItem',
            'dynamodb:DeleteItem',
            'dynamodb:ConditionCheckItem',
          ],
          Resource: arnOf(tableId),
        },
        {
          Effect: 'Allow',
          Action: 'dynamodb:Query',
          Resource: ['GSI1', 'GSI2', 'GSI3', 'GSI4'].map((index) => ({
            'Fn::Join': ['', [arnOf(tableId), `/index/${index}`]],
          })),
        },
        {
          Effect: 'Allow',
          Action: ['s3:GetObject', 's3:PutObject'],
          Resource: [objects('/receipts/*'), objects('/uploads/pending/*')],
        },
        {
          Effect: 'Allow',
          Action: 's3:DeleteObject',
          Resource: objects('/uploads/pending/*'),
        },
        {
          Effect: 'Allow',
          Action: 's3:ListBucket',
          Resource: arnOf(bucketId),
        },
      ]);
    });

    it('authorizes transactions through item actions, not a transaction action', () => {
      const json = JSON.stringify(statements());
      expect(json).not.toMatch(/dynamodb:Transact/);
      for (const action of [
        'PutItem',
        'UpdateItem',
        'DeleteItem',
        'ConditionCheckItem',
      ]) {
        expect(json).toContain(`dynamodb:${action}`);
      }
    });

    it('grants no stream, event bus, queue, Cognito, final-delete, or wildcard access', () => {
      const json = JSON.stringify(statements());
      expect(json).not.toMatch(/dynamodb:(Scan|\w*Stream|\w*Table|\*)/);
      expect(json).not.toContain('StreamArn');
      expect(json).not.toContain('events:');
      expect(json).not.toContain('sqs:');
      expect(json).not.toContain('cognito');
      expect(json).not.toContain('s3:*');
      expect(json).not.toContain('"*"');
      const deletes = statements().filter((statement) =>
        JSON.stringify(statement.Action).includes('s3:DeleteObject'),
      );
      expect(JSON.stringify(deletes)).not.toContain('/receipts/*');
      for (const statement of statements()) {
        expect(statement).not.toHaveProperty('NotAction');
        expect(statement).not.toHaveProperty('NotResource');
        expect(statement).not.toHaveProperty('Condition');
      }
    });

    it('is invoked only by API Gateway, never by an event source', () => {
      const principals = Object.values(resources())
        .filter(
          (resource) =>
            resource.Type === 'AWS::Lambda::Permission' &&
            JSON.stringify(resource.Properties.FunctionName).includes(
              functionLogicalId,
            ),
        )
        .map((resource) => resource.Properties.Principal);
      expect(principals.length).toBeGreaterThan(0);
      expect(new Set(principals)).toEqual(
        new Set(['apigateway.amazonaws.com']),
      );
      const mappings = Object.values(template.findResources(MAPPING_TYPE)).map(
        (found) => (found as TableResource).Properties.FunctionName,
      );
      expect(mappings).not.toContainEqual({ Ref: functionLogicalId });
    });
  });

  describe('HTTP API', () => {
    let apiLogicalId: string;
    let authorizerLogicalId: string;
    let functionLogicalId: string;
    let integrationLogicalId: string;
    let webClientId: string;

    const resources = () =>
      template.toJSON().Resources as Record<string, TableResource>;
    const ofType = (type: string) =>
      Object.values(template.findResources(type)) as TableResource[];
    const routes = () => ofType('AWS::ApiGatewayV2::Route');
    const routeKeys = () =>
      routes()
        .map((route) => route.Properties.RouteKey as string)
        .sort();
    const basePath = '/api/v1';

    beforeAll(() => {
      [apiLogicalId] = resourceOf(stack.httpApi);
      [functionLogicalId] = resourceOf(stack.apiFunction);
      authorizerLogicalId = Object.keys(
        template.findResources('AWS::ApiGatewayV2::Authorizer'),
      )[0];
      integrationLogicalId = Object.keys(
        template.findResources('AWS::ApiGatewayV2::Integration'),
      )[0];
      webClientId = webClientLogicalId;
    });

    it('is an HTTP API without a default catch-all stage or route', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
        Name: 'claimflow-api',
        ProtocolType: 'HTTP',
      });
      template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
      for (const key of routeKeys()) {
        expect(key).toMatch(/^(GET|POST|PUT|PATCH|DELETE) \/api\/v1\//);
        expect(key).not.toMatch(/\$default|ANY|\{proxy\+\}|\*/);
      }
      expect(resources()[apiLogicalId].Properties).not.toHaveProperty(
        'DisableExecuteApiEndpoint',
      );
    });

    it('routes exactly the application routes, matching the route table', () => {
      const expected = createAwsRoutes({} as never)
        .map(
          (route) =>
            `${route.method} ${basePath}${route.path.replace(/:(\w+)/g, '{$1}')}`,
        )
        .sort();
      expect(routeKeys()).toEqual(expected);
      expect(routeKeys()).toHaveLength(
        CLAIMFLOW_API_PUBLIC_ROUTES.length +
          CLAIMFLOW_API_PROTECTED_ROUTES.length,
      );
    });

    it('leaves only the health check public', () => {
      const open = routes().filter(
        (route) => route.Properties.AuthorizationType === 'NONE',
      );
      expect(open.map((route) => route.Properties.RouteKey)).toEqual([
        `GET ${basePath}/health`,
      ]);
      expect(open[0].Properties).not.toHaveProperty('AuthorizerId');
    });

    it('protects every other route with the JWT authorizer and the openid scope', () => {
      const protectedRoutes = routes().filter(
        (route) => route.Properties.RouteKey !== `GET ${basePath}/health`,
      );
      expect(protectedRoutes).toHaveLength(
        CLAIMFLOW_API_PROTECTED_ROUTES.length,
      );
      for (const route of protectedRoutes) {
        expect(route.Properties).toMatchObject({
          AuthorizationType: 'JWT',
          AuthorizerId: { Ref: authorizerLogicalId },
          AuthorizationScopes: ['openid'],
        });
      }
      expect(CLAIMFLOW_API_REQUIRED_SCOPE).toBe('openid');
    });

    it('validates Cognito access tokens by issuer, app client, and header', () => {
      template.resourceCountIs('AWS::ApiGatewayV2::Authorizer', 1);
      template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
        ApiId: { Ref: apiLogicalId },
        AuthorizerType: 'JWT',
        IdentitySource: ['$request.header.Authorization'],
        JwtConfiguration: {
          Issuer: { 'Fn::GetAtt': [userPoolLogicalId, 'ProviderURL'] },
          Audience: [{ Ref: webClientId }],
        },
      });
    });

    it('uses one payload format 2.0 proxy integration with the API function', () => {
      template.resourceCountIs('AWS::ApiGatewayV2::Integration', 1);
      template.hasResourceProperties('AWS::ApiGatewayV2::Integration', {
        ApiId: { Ref: apiLogicalId },
        IntegrationType: 'AWS_PROXY',
        IntegrationUri: { 'Fn::GetAtt': [functionLogicalId, 'Arn'] },
        PayloadFormatVersion: '2.0',
      });
      for (const route of routes()) {
        expect(JSON.stringify(route.Properties.Target)).toContain(
          integrationLogicalId,
        );
      }
    });

    it('lets API Gateway invoke the function only for this API and one route each', () => {
      const permissions = Object.values(resources())
        .filter(
          (resource) =>
            resource.Type === 'AWS::Lambda::Permission' &&
            resource.Properties.Principal === 'apigateway.amazonaws.com',
        )
        .map((resource) => resource.Properties);
      expect(permissions).toHaveLength(routes().length);
      const sources: string[] = [];
      for (const permission of permissions) {
        expect(permission.Action).toBe('lambda:InvokeFunction');
        expect(permission.FunctionName).toEqual({
          'Fn::GetAtt': [functionLogicalId, 'Arn'],
        });
        const source = JSON.stringify(permission.SourceArn);
        expect(source).toContain(`{"Ref":"${apiLogicalId}"}`);
        expect(source).toMatch(/\/\*\/\*\/api\/v1\//);
        expect(source).not.toMatch(/\/\*\/\*\/\*"|\/\*"\]/);
        sources.push(source);
      }
      // Routes that share a path (different methods) share a source ARN.
      expect(new Set(sources).size).toBe(
        new Set(routeKeys().map((key) => key.split(' ')[1])).size,
      );
    });

    it('allows the CloudFront origin only, with the required methods and headers', () => {
      const cors = resources()[apiLogicalId].Properties.CorsConfiguration;
      expect(cors).toEqual({
        AllowCredentials: false,
        AllowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
        AllowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
        AllowOrigins: [
          {
            'Fn::Join': [
              '',
              [
                'https://',
                {
                  'Fn::GetAtt': [distributionLogicalId, 'DomainName'],
                },
              ],
            ],
          },
        ],
        ExposeHeaders: ['X-Request-Id', 'X-Correlation-Id'],
        MaxAge: 600,
      });
      expect(JSON.stringify(cors)).not.toContain('*');
    });

    it('bounds throttling on the default stage', () => {
      template.resourceCountIs('AWS::ApiGatewayV2::Stage', 1);
      template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
        ApiId: { Ref: apiLogicalId },
        StageName: '$default',
        AutoDeploy: true,
        DefaultRouteSettings: {
          ThrottlingRateLimit: 20,
          ThrottlingBurstLimit: 40,
        },
      });
    });

    it('outputs the endpoint, the base URL, and the API ID', () => {
      const outputs = template.toJSON().Outputs as Record<string, any>;
      expect(outputs.ApiEndpoint.Value).toEqual({
        'Fn::GetAtt': [apiLogicalId, 'ApiEndpoint'],
      });
      expect(JSON.stringify(outputs.ApiBaseUrl.Value)).toContain('/api/v1');
      expect(outputs.ApiId.Value).toEqual({ Ref: apiLogicalId });
    });

    it('adds no custom domain, VPC link, or WebSocket API', () => {
      for (const type of [
        'AWS::ApiGatewayV2::DomainName',
        'AWS::ApiGatewayV2::VpcLink',
        'AWS::ApiGateway::RestApi',
      ]) {
        template.resourceCountIs(type, 0);
      }
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

  describe('CloudWatch alarms', () => {
    it('alarms on the sweeper EMF metric, which needs no IAM permission', () => {
      const properties = Object.values(
        template.findResources('AWS::CloudWatch::Alarm', {
          Properties: { AlarmName: 'claimflow-oldest-pending-outbox-age' },
        }),
      )[0].Properties as Record<string, unknown>;
      expect(properties).toMatchObject({
        Namespace: 'ClaimFlow',
        MetricName: 'OldestPendingOutboxAge',
        Statistic: 'Maximum',
        Unit: 'Seconds',
        Period: 900,
        EvaluationPeriods: 2,
        Threshold: 1800,
        TreatMissingData: 'notBreaching',
        ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      });
      // A dimensionless metric, and no action of any kind.
      expect(properties).not.toHaveProperty('Dimensions');
      expect(properties.AlarmActions).toHaveLength(1);
      // EMF is written to the log, so no role gains a CloudWatch permission.
      expect(
        JSON.stringify(template.findResources(IAM_POLICY_TYPE)),
      ).not.toMatch(/cloudwatch:/i);
    });

    interface Alarm {
      readonly Properties: Record<string, any>;
    }
    const alarms = () =>
      Object.values(
        template.findResources('AWS::CloudWatch::Alarm'),
      ) as Alarm[];
    const named = (name: string) => {
      const found = alarms().filter(
        (alarm) => alarm.Properties.AlarmName === name,
      );
      expect(found, name).toHaveLength(1);
      return found[0].Properties;
    };
    const logicalId = (construct: IConstruct) => resourceOf(construct)[0];

    const lambdaFunctions = (): [string, string][] => [
      [CLAIMFLOW_API_FUNCTION_NAME, logicalId(stack.apiFunction)],
      [CLAIMFLOW_CLEANUP_WORKER_NAME, logicalId(stack.cleanupWorker)],
      [CLAIMFLOW_OUTBOX_PUBLISHER_NAME, logicalId(stack.outboxPublisher)],
      [CLAIMFLOW_RECEIPT_JANITOR_NAME, logicalId(stack.receiptJanitor)],
      [CLAIMFLOW_OUTBOX_SWEEPER_NAME, logicalId(stack.outboxSweeper)],
    ];

    it('defines exactly the approved alarms', () => {
      const lambdaNames = lambdaFunctions().flatMap(([name]) => {
        const short = name.replace(/^claimflow-/, '');
        return [`claimflow-${short}-errors`, `claimflow-${short}-throttles`];
      });
      expect(
        alarms()
          .map((alarm) => alarm.Properties.AlarmName)
          .sort(),
      ).toEqual(
        [
          'claimflow-api-5xx-rate',
          'claimflow-oldest-pending-outbox-age',
          ...lambdaNames,
          'claimflow-outbox-publisher-iterator-age',
          'claimflow-receipt-janitor-iterator-age',
          'claimflow-cleanup-dlq-visible-messages',
          'claimflow-outbox-publisher-failures-visible-messages',
          'claimflow-receipt-janitor-failures-visible-messages',
        ].sort(),
      );
      expect(Object.keys(stack.alarms).sort()).toEqual(
        alarms()
          .map((alarm) => alarm.Properties.AlarmName)
          .sort(),
      );
    });

    it('treats missing data as not breaching and compares with >=', () => {
      for (const { Properties } of alarms()) {
        expect(Properties.TreatMissingData).toBe('notBreaching');
        expect(Properties.ComparisonOperator).toBe(
          'GreaterThanOrEqualToThreshold',
        );
      }
    });

    it('has no custom metric namespace besides ClaimFlow, and standard-resolution periods', () => {
      const periods: number[] = [];
      for (const { Properties } of alarms()) {
        for (const key of ['OKActions', 'InsufficientDataActions']) {
          expect(Properties, key).not.toHaveProperty(key);
        }
        expect(Properties).not.toHaveProperty('ExtendedStatistic');
        expect(Properties).not.toHaveProperty(
          'EvaluateLowSampleCountPercentile',
        );
        const metrics: any[] = Properties.Metrics ?? [Properties];
        for (const metric of metrics) {
          const stat = metric.MetricStat?.Metric ?? metric;
          if (stat.Namespace !== undefined) {
            expect([
              'AWS/Lambda',
              'AWS/SQS',
              'AWS/ApiGateway',
              'ClaimFlow',
            ]).toContain(stat.Namespace);
          }
          const period = metric.MetricStat?.Period ?? metric.Period;
          if (period !== undefined) {
            periods.push(period);
          }
        }
      }
      expect(periods.length).toBeGreaterThan(0);
      for (const period of periods) {
        expect(period % 60, `period ${period}`).toBe(0);
        expect(period).toBeGreaterThanOrEqual(60);
      }
      template.resourceCountIs('AWS::CloudWatch::Dashboard', 0);
    });

    it.each([
      ['Errors', 'errors'],
      ['Throttles', 'throttles'],
    ])(
      'alarms on %s of each of the five Lambda functions',
      (metric, suffix) => {
        expect(lambdaFunctions()).toHaveLength(5);
        for (const [name, id] of lambdaFunctions()) {
          const short = name.replace(/^claimflow-/, '');
          expect(named(`claimflow-${short}-${suffix}`)).toMatchObject({
            Namespace: 'AWS/Lambda',
            MetricName: metric,
            Dimensions: [{ Name: 'FunctionName', Value: { Ref: id } }],
            Statistic: 'Sum',
            Period: 900,
            EvaluationPeriods: 1,
            Threshold: 1,
          });
        }
      },
    );

    it.each([
      [CLAIMFLOW_OUTBOX_PUBLISHER_NAME, () => stack.outboxPublisher],
      [CLAIMFLOW_RECEIPT_JANITOR_NAME, () => stack.receiptJanitor],
    ])('alarms on the iterator age of %s', (name, fn) => {
      expect(
        named(`claimflow-${name.replace(/^claimflow-/, '')}-iterator-age`),
      ).toMatchObject({
        Namespace: 'AWS/Lambda',
        MetricName: 'IteratorAge',
        Dimensions: [{ Name: 'FunctionName', Value: { Ref: logicalId(fn()) } }],
        Statistic: 'Maximum',
        Unit: 'Milliseconds',
        Period: 300,
        EvaluationPeriods: 3,
        Threshold: 15 * 60 * 1000,
      });
    });

    it('has no iterator age alarm for functions without a stream', () => {
      const names = alarms().map((alarm) => alarm.Properties.AlarmName);
      expect(
        names.filter((name) => name.includes('iterator-age')),
      ).toHaveLength(2);
    });

    it.each([
      [CLAIMFLOW_CLEANUP_DLQ_NAME, () => stack.cleanupDeadLetterQueue],
      [CLAIMFLOW_OUTBOX_FAILURE_QUEUE_NAME, () => stack.outboxFailureQueue],
      [CLAIMFLOW_JANITOR_FAILURE_QUEUE_NAME, () => stack.janitorFailureQueue],
    ])('alarms on visible messages in %s', (name, queue) => {
      expect(
        named(`claimflow-${name.replace(/^claimflow-/, '')}-visible-messages`),
      ).toMatchObject({
        Namespace: 'AWS/SQS',
        MetricName: 'ApproximateNumberOfMessagesVisible',
        Dimensions: [
          {
            Name: 'QueueName',
            Value: { 'Fn::GetAtt': [logicalId(queue()), 'QueueName'] },
          },
        ],
        Statistic: 'Maximum',
        Period: 300,
        EvaluationPeriods: 1,
        Threshold: 1,
      });
    });

    it('alarms on the HTTP API 5xx rate, with no minimum request count', () => {
      const [apiId] = resourceOf(stack.httpApi);
      const properties = named('claimflow-api-5xx-rate');
      expect(properties).toMatchObject({
        Threshold: 5,
        EvaluationPeriods: 3,
        DatapointsToAlarm: 2,
      });
      const metrics = properties.Metrics as any[];
      const expression = metrics.find((metric) => metric.Expression);
      expect(expression.Expression).toBe(
        'IF(requests > 0, 100 * FILL(errors, 0) / requests, 0)',
      );
      expect(expression.ReturnData).not.toBe(false);
      const byId = Object.fromEntries(
        metrics
          .filter((metric) => metric.MetricStat)
          .map((metric) => [metric.Id, metric]),
      );
      for (const [id, metricName] of [
        ['errors', '5xx'],
        ['requests', 'Count'],
      ]) {
        expect(byId[id].MetricStat).toMatchObject({
          Metric: {
            Namespace: 'AWS/ApiGateway',
            MetricName: metricName,
            Dimensions: [{ Name: 'ApiId', Value: { Ref: apiId } }],
          },
          Period: 300,
          Stat: 'Sum',
        });
        expect(byId[id].ReturnData).toBe(false);
      }
    });
  });

  describe('alarm notifications', () => {
    let topicId: string;
    const alarmResources = () =>
      Object.values(template.findResources('AWS::CloudWatch::Alarm')) as {
        Properties: Record<string, any>;
      }[];

    beforeAll(() => {
      [topicId] = resourceOf(stack.alarmTopic);
    });

    it('defines one standard topic named claimflow-alarms', () => {
      template.resourceCountIs('AWS::SNS::Topic', 1);
      expect(CLAIMFLOW_ALARM_TOPIC_NAME).toBe('claimflow-alarms');
      template.hasResourceProperties('AWS::SNS::Topic', {
        TopicName: 'claimflow-alarms',
      });
      const topic = template.findResources('AWS::SNS::Topic')[topicId]
        .Properties as Record<string, unknown>;
      // Standard, not FIFO, and no customer-managed key.
      expect(topic).not.toHaveProperty('FifoTopic');
      expect(topic).not.toHaveProperty('KmsMasterKeyId');
      template.resourceCountIs('AWS::KMS::Key', 0);
    });

    it('takes the address from a required NoEcho parameter, never a literal or output', () => {
      const parameter =
        template.toJSON().Parameters[CLAIMFLOW_ALARM_EMAIL_PARAMETER];
      expect(CLAIMFLOW_ALARM_EMAIL_PARAMETER).toBe('AlarmNotificationEmail');
      expect(parameter).toMatchObject({ Type: 'String', NoEcho: true });
      expect(parameter).not.toHaveProperty('Default');
      expect(new RegExp(parameter.AllowedPattern).test('a@example.com')).toBe(
        true,
      );
      expect(new RegExp(parameter.AllowedPattern).test('not an email')).toBe(
        false,
      );
      // The only reference to the address anywhere is the subscription.
      const json = JSON.stringify(template.toJSON());
      expect(json.match(/AlarmNotificationEmail/g)).toHaveLength(
        1 /* declaration */ + 1 /* subscription */,
      );
      expect(template.toJSON().Outputs).not.toHaveProperty(
        'AlarmNotificationEmail',
      );
      expect(JSON.stringify(template.toJSON().Outputs)).not.toMatch(
        /AlarmNotificationEmail|@/,
      );
      expect(json).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    });

    it('has exactly one email subscription to the topic using the parameter', () => {
      template.resourceCountIs('AWS::SNS::Subscription', 1);
      template.hasResourceProperties('AWS::SNS::Subscription', {
        Protocol: 'email',
        TopicArn: { Ref: topicId },
        Endpoint: { Ref: CLAIMFLOW_ALARM_EMAIL_PARAMETER },
      });
    });

    it("lets only this account's ClaimFlow alarms publish, and only over TLS", () => {
      template.resourceCountIs('AWS::SNS::TopicPolicy', 1);
      const [policy] = Object.values(
        template.findResources('AWS::SNS::TopicPolicy'),
      ) as { Properties: Record<string, any> }[];
      expect(policy.Properties.Topics).toEqual([{ Ref: topicId }]);
      const statements = policy.Properties.PolicyDocument.Statement as any[];
      expect(statements).toHaveLength(2);

      const deny = statements.find((s) => s.Effect === 'Deny');
      expect(deny).toMatchObject({
        Action: 'sns:Publish',
        Principal: '*',
        Resource: { Ref: topicId },
        Condition: { Bool: { 'aws:SecureTransport': 'false' } },
      });

      const allow = statements.find((s) => s.Effect === 'Allow');
      expect(allow).toMatchObject({
        Action: 'sns:Publish',
        Principal: { Service: 'cloudwatch.amazonaws.com' },
        Resource: { Ref: topicId },
      });
      expect(allow.Condition.StringEquals['aws:SourceAccount']).toBe(
        stack.account,
      );
      const sourceArn = JSON.stringify(
        allow.Condition.ArnLike['aws:SourceArn'],
      );
      expect(sourceArn).toContain(':cloudwatch:');
      expect(sourceArn).toContain(CLAIMFLOW_REGION);
      expect(sourceArn).toContain(stack.account);
      expect(sourceArn).toContain(':alarm:claimflow-*');
      // No wildcard action, principal, or resource on the allow statement.
      expect(JSON.stringify(allow.Action)).not.toContain('*');
      expect(JSON.stringify(allow.Principal)).not.toContain('*');
      expect(JSON.stringify(allow.Resource)).not.toContain('*');
    });

    it('sends every one of the 17 alarms to the topic in ALARM only', () => {
      expect(alarmResources()).toHaveLength(17);
      expect(Object.keys(stack.alarms)).toHaveLength(17);
      for (const { Properties } of alarmResources()) {
        expect(Properties.AlarmActions, Properties.AlarmName).toEqual([
          { Ref: topicId },
        ]);
      }
    });

    it('has no OK or insufficient-data actions on any alarm', () => {
      for (const { Properties } of alarmResources()) {
        expect(Properties).not.toHaveProperty('OKActions');
        expect(Properties).not.toHaveProperty('InsufficientDataActions');
      }
    });

    it('adds no other topic, subscription, dashboard, or notification target', () => {
      template.resourceCountIs('AWS::CloudWatch::Dashboard', 0);
      expect(JSON.stringify(template.toJSON().Outputs)).not.toContain(
        'arn:aws:sns',
      );
    });
  });

  describe('third-party notices', () => {
    const repoRoot = resolve(process.cwd(), '..');
    const noticesPath = join(repoRoot, CLAIMFLOW_THIRD_PARTY_NOTICES_FILE);
    const lambdaEntries = [
      'api-lambda',
      'cleanup-worker-lambda',
      'outbox-publisher-lambda',
      'outbox-sweeper-lambda',
      'receipt-janitor-lambda',
    ];

    const functions = () =>
      Object.values(template.findResources(FUNCTION_TYPE)) as TableResource[];

    it('ships the notices file in the asset of every bundled Lambda function', () => {
      const notices = readFileSync(noticesPath, 'utf8');
      expect(notices).toContain('THIRD-PARTY NOTICES FOR CLAIMFLOW');
      expect(functions()).toHaveLength(lambdaEntries.length);

      const assembly = (stack.node.root as App).synth();
      for (const fn of functions()) {
        const key = fn.Properties.Code.S3Key as string;
        expect(key).toMatch(/\.zip$/);
        const assetDir = join(
          assembly.directory,
          `asset.${key.replace(/\.zip$/, '')}`,
        );
        expect(existsSync(join(assetDir, 'index.js')), assetDir).toBe(true);
        expect(
          readFileSync(
            join(assetDir, CLAIMFLOW_THIRD_PARTY_NOTICES_FILE),
            'utf8',
          ),
        ).toBe(notices);
      }
    });

    it('lists every package that the Lambda bundles contain', async () => {
      const notices = readFileSync(noticesPath, 'utf8');
      const listed = new Set(
        notices
          .split('\n')
          .map((line) => /^(\S+@\S+)\s+\S+\s+(lambda|web)/.exec(line)?.[1])
          .filter((entry): entry is string => entry !== undefined),
      );
      const missing = new Set<string>();
      for (const entry of lambdaEntries) {
        const result = await build({
          entryPoints: [
            join(repoRoot, 'services/api/src/adapters/aws', `${entry}.ts`),
          ],
          bundle: true,
          platform: 'node',
          target: 'node24',
          format: 'cjs',
          conditions: ['source'],
          metafile: true,
          write: false,
          logLevel: 'silent',
        });
        for (const input of Object.keys(result.metafile.inputs)) {
          const normalized = input.split('\\').join('/');
          const marker = 'node_modules/';
          const index = normalized.lastIndexOf(marker);
          if (index < 0) {
            continue;
          }
          const parts = normalized.slice(index + marker.length).split('/');
          const name = parts[0].startsWith('@')
            ? `${parts[0]}/${parts[1]}`
            : parts[0];
          const manifest = JSON.parse(
            readFileSync(
              join(
                resolve(process.cwd(), normalized.slice(0, index)),
                marker,
                name,
                'package.json',
              ),
              'utf8',
            ),
          ) as { version: string };
          if (!listed.has(`${name}@${manifest.version}`)) {
            missing.add(`${name}@${manifest.version}`);
          }
        }
      }
      expect([...missing]).toEqual([]);
    });

    it('adds no resource, permission, or runtime behavior for the notices', () => {
      // The hook copies a file while bundling; the template has no trace of it.
      expect(JSON.stringify(template.toJSON())).not.toContain(
        CLAIMFLOW_THIRD_PARTY_NOTICES_FILE,
      );
    });
  });
});
