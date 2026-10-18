import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { createCleanupWorkerHandler } from './cleanup-worker-handler.js';
import { DynamoDbHistoryPurger } from './dynamodb-history-purger.js';
import { S3ReceiptObjects } from './s3-receipt-objects.js';

/**
 * The cleanup worker's Lambda entry point (docs/aws-architecture.md,
 * section 12). It only wires clients and adapters to the SQS handler; the
 * clients are built once per execution environment, outside the handler.
 */

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`The ${name} environment variable is missing.`);
  }
  return value;
}

const tableName = requiredEnvironment('CLAIMFLOW_TABLE_NAME');
const bucketName = requiredEnvironment('CLAIMFLOW_RECEIPT_BUCKET_NAME');

export const handler = createCleanupWorkerHandler({
  objects: new S3ReceiptObjects({ client: new S3Client({}), bucketName }),
  history: new DynamoDbHistoryPurger({
    client: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    tableName,
  }),
});
