import { unmarshall } from '@aws-sdk/util-dynamodb';
import type {
  DynamoDBBatchResponse,
  DynamoDBRecord,
  DynamoDBStreamEvent,
} from 'aws-lambda';

import { decodeReceiptItem } from './dynamodb-receipt-items.js';
import type { S3ReceiptObjects } from './s3-receipt-objects.js';

/**
 * The receipt janitor's DynamoDB Streams handler (docs/aws-architecture.md,
 * section 11): when DynamoDB's TTL removes pending receipt metadata, the
 * uploaded object, and any copy already promoted, are deleted. It builds no
 * clients and is not a Lambda entry point itself.
 */

/** The object operations the janitor uses; `S3ReceiptObjects` provides them. */
export type ReceiptObjectCleanup = Pick<
  S3ReceiptObjects,
  'deletePending' | 'deleteFinal'
>;

export type ReceiptJanitorHandler = (
  event: DynamoDBStreamEvent,
) => Promise<DynamoDBBatchResponse>;

/**
 * A handler that treats a `REMOVE` made by the DynamoDB service as a cleanup
 * candidate. For an old image of a pending receipt, the codec validates it
 * strictly and both objects are deleted, whatever happens to the first
 * deletion. Records are independent: a malformed old image or a failed
 * deletion fails that record only, and the response names the first failed
 * sequence number in stream order. A candidate without a sequence number
 * throws, so Lambda retries the whole batch.
 */
export function createReceiptJanitorHandler(
  objects: ReceiptObjectCleanup,
): ReceiptJanitorHandler {
  return async (event) => {
    const candidates = (event.Records ?? [])
      .filter(isTtlRemoval)
      .map((record) => {
        const sequenceNumber = record.dynamodb?.SequenceNumber;
        if (typeof sequenceNumber !== 'string' || sequenceNumber.length === 0) {
          throw new TypeError('A stream record has no sequence number.');
        }
        return { record, sequenceNumber };
      });

    const outcomes = await Promise.all(
      candidates.map(async ({ record, sequenceNumber }) => ({
        sequenceNumber,
        ok: await clean(record, objects),
      })),
    );

    const first = outcomes.find((outcome) => !outcome.ok);
    return {
      batchItemFailures:
        first === undefined ? [] : [{ itemIdentifier: first.sequenceNumber }],
    };
  };
}

/** The approved filter: a removal made by the DynamoDB service (TTL). */
function isTtlRemoval(record: DynamoDBRecord): boolean {
  // The Lambda types declare the identity as `any`.
  const identity = record?.userIdentity as
    { type?: unknown; principalId?: unknown } | undefined;
  return (
    record?.eventName === 'REMOVE' &&
    identity?.type === 'Service' &&
    identity.principalId === 'dynamodb.amazonaws.com'
  );
}

/** Whether the record is handled: ignored, or cleaned up completely. */
async function clean(
  record: DynamoDBRecord,
  objects: ReceiptObjectCleanup,
): Promise<boolean> {
  const image = record.dynamodb?.OldImage;
  if (image === undefined) {
    return false;
  }

  let receiptId: string;
  try {
    const item = unmarshall(image as Parameters<typeof unmarshall>[0]);
    // Only pending receipts are the janitor's; anything else is ignored.
    if (item.entityType !== 'Receipt' || item.state !== 'PENDING') {
      return true;
    }
    receiptId = decodeReceiptItem(item).receiptId;
  } catch {
    return false;
  }

  const results = await Promise.allSettled([
    // Wrapped so that even a synchronous throw cannot skip the other deletion.
    (async () => objects.deleteFinal(receiptId))(),
    (async () => objects.deletePending(receiptId))(),
  ]);
  return results.every((result) => result.status === 'fulfilled');
}
