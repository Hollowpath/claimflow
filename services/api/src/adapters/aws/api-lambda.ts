import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { createAwsApplicationHandler } from '../../aws-composition.js';
import { createHttpApiAdapter } from '../../http/lambda-adapter.js';
import { JsonLogger, systemClock, uuidGenerator } from '../local/system.js';
import { createS3DownloadSigner } from './s3-download-url.js';
import { createS3UploadFormSigner } from './s3-upload-form.js';

/**
 * The API Lambda's entry point (docs/aws-architecture.md, section 4). It only
 * validates the two required settings, builds the SDK clients and signers once
 * per execution environment, outside the handler, and hands them to the AWS
 * application composition behind the API Gateway HTTP API (payload format
 * 2.0) transport. Credentials come from the function's execution role through
 * the SDK's default provider chain; nothing is read from a profile or file.
 */

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`The ${name} environment variable is missing.`);
  }
  return value;
}

const tableName = requiredEnvironment('CLAIMFLOW_TABLE_NAME');
const receiptBucketName = requiredEnvironment('CLAIMFLOW_RECEIPT_BUCKET_NAME');

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

export const handler = createHttpApiAdapter(
  createAwsApplicationHandler({
    config: { tableName, receiptBucketName },
    clients: {
      dynamo,
      s3,
      signUploadForm: createS3UploadFormSigner(s3),
      signDownloadUrl: createS3DownloadSigner(s3),
    },
    clock: systemClock,
    ids: uuidGenerator,
    logger: new JsonLogger(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random: Math.random,
  }),
);
