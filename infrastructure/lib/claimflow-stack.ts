import * as cdk from 'aws-cdk-lib/core';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type { Construct } from 'constructs';

/** The only AWS Region ClaimFlow is deployed to. */
export const CLAIMFLOW_REGION = 'ap-southeast-1';

export const CLAIMFLOW_STACK_DESCRIPTION = 'ClaimFlow AWS infrastructure';

export const CLAIMFLOW_TABLE_NAME = 'ClaimFlow';

/** The four global secondary indexes in docs/aws-architecture.md, section 5. */
export const CLAIMFLOW_INDEX_NAMES = ['GSI1', 'GSI2', 'GSI3', 'GSI4'] as const;

const stringKey = (name: string): dynamodb.Attribute => ({
  name,
  type: dynamodb.AttributeType.STRING,
});

/** ClaimFlow's AWS infrastructure. */
export class ClaimFlowStack extends cdk.Stack {
  /** The single table holding all ClaimFlow data. */
  public readonly table: dynamodb.TableV2;

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
  }
}
