import { S3Client } from '@aws-sdk/client-s3';

import { createReceiptJanitorHandler } from './receipt-janitor-handler.js';
import { S3ReceiptObjects } from './s3-receipt-objects.js';

/**
 * The receipt janitor's Lambda entry point (docs/aws-architecture.md,
 * section 11). It only wires the S3 client and adapter to the stream
 * handler; the client is built once per execution environment, outside the
 * handler.
 */

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`The ${name} environment variable is missing.`);
  }
  return value;
}

const bucketName = requiredEnvironment('CLAIMFLOW_RECEIPT_BUCKET_NAME');

export const handler = createReceiptJanitorHandler(
  new S3ReceiptObjects({ client: new S3Client({}), bucketName }),
);
