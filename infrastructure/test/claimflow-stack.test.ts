import { Match, Template } from 'aws-cdk-lib/assertions';
import { App } from 'aws-cdk-lib/core';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  CLAIMFLOW_REGION,
  CLAIMFLOW_STACK_DESCRIPTION,
  ClaimFlowStack,
} from '../lib/claimflow-stack';

const TABLE_TYPE = 'AWS::DynamoDB::GlobalTable';
const USER_POOL_TYPE = 'AWS::Cognito::UserPool';
const BUCKET_TYPE = 'AWS::S3::Bucket';
const BUCKET_POLICY_TYPE = 'AWS::S3::BucketPolicy';

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
    const buckets = Object.entries(template.findResources(BUCKET_TYPE));
    expect(buckets).toHaveLength(1);
    [bucketLogicalId, bucket] = buckets[0] as [string, BucketResource];
  });

  describe('stack', () => {
    it('is described as ClaimFlow infrastructure', () => {
      expect(template.toJSON().Description).toBe(CLAIMFLOW_STACK_DESCRIPTION);
    });

    it('targets ap-southeast-1', () => {
      expect(stack.region).toBe('ap-southeast-1');
    });

    it('contains only the table, the user pool, and the receipt bucket with its policy', () => {
      const resourceTypes = Object.values(
        (template.toJSON().Resources ?? {}) as Record<string, { Type: string }>,
      )
        .map((resource) => resource.Type)
        .filter((type) => type !== 'AWS::CDK::Metadata');

      expect(resourceTypes.sort()).toEqual(
        [USER_POOL_TYPE, TABLE_TYPE, BUCKET_TYPE, BUCKET_POLICY_TYPE].sort(),
      );
      template.resourceCountIs('AWS::KMS::Key', 0);
    });

    it.each([
      'AWS::Cognito::IdentityPool',
      'AWS::Cognito::UserPoolClient',
      'AWS::Cognito::UserPoolDomain',
      'AWS::Cognito::UserPoolUser',
      'AWS::Cognito::UserPoolGroup',
      'AWS::Cognito::ManagedLoginBranding',
      'AWS::Lambda::Function',
      'AWS::IAM::Role',
      'AWS::ApiGatewayV2::Api',
      'AWS::ApiGateway::RestApi',
      'AWS::SES::EmailIdentity',
      'AWS::CloudFront::Distribution',
      'AWS::IAM::User',
      'AWS::Events::EventBus',
      'AWS::SQS::Queue',
      'AWS::SNS::Topic',
      'Custom::S3AutoDeleteObjects',
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
      template.resourceCountIs(BUCKET_POLICY_TYPE, 1);
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
});
