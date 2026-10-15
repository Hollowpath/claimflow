import { Match, Template } from 'aws-cdk-lib/assertions';
import { App } from 'aws-cdk-lib/core';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  CLAIMFLOW_REGION,
  CLAIMFLOW_STACK_DESCRIPTION,
  ClaimFlowStack,
} from '../lib/claimflow-stack';

const TABLE_TYPE = 'AWS::DynamoDB::GlobalTable';

interface TableResource {
  readonly Properties: Record<string, any>;
  readonly DeletionPolicy?: string;
  readonly UpdateReplacePolicy?: string;
}

describe('ClaimFlowStack', () => {
  let stack: ClaimFlowStack;
  let template: Template;
  let table: TableResource;

  beforeAll(() => {
    stack = new ClaimFlowStack(new App(), 'ClaimFlow', {
      env: { account: '123456789012', region: CLAIMFLOW_REGION },
    });
    template = Template.fromStack(stack);
    const tables = Object.values(template.findResources(TABLE_TYPE));
    expect(tables).toHaveLength(1);
    table = tables[0] as TableResource;
  });

  describe('stack', () => {
    it('is described as ClaimFlow infrastructure', () => {
      expect(template.toJSON().Description).toBe(CLAIMFLOW_STACK_DESCRIPTION);
    });

    it('targets ap-southeast-1', () => {
      expect(stack.region).toBe('ap-southeast-1');
    });

    it('contains only the DynamoDB table', () => {
      const resourceTypes = Object.values(
        (template.toJSON().Resources ?? {}) as Record<string, { Type: string }>,
      )
        .map((resource) => resource.Type)
        .filter((type) => type !== 'AWS::CDK::Metadata');

      expect(resourceTypes).toEqual([TABLE_TYPE]);
      template.resourceCountIs('AWS::KMS::Key', 0);
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
});
