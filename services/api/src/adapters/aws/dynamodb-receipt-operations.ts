import { idSchema } from '@claimflow/contracts';

import { isIsoTimestamp } from './dynamodb-items.js';
import {
  encodeReceiptItem,
  receiptKey,
  receiptObjectKey,
  retiredReceiptExpiresAt,
  type AttachedReceiptRecord,
  type PendingReceiptRecord,
  type RetiredReceiptRecord,
} from './dynamodb-receipt-items.js';
import type { TransactionItem } from './dynamodb-transaction.js';

/**
 * Pure builders for receipt metadata operations inside a business
 * transaction (docs/aws-architecture.md, sections 8, 9, and 11). They return
 * `TransactionItem` values for the transaction composer and never send a
 * DynamoDB or S3 command. Records are validated by the receipt codec.
 */

/** Receipt metadata is created once. */
export const receiptCreateCondition = 'attribute_not_exists(PK)';

/** Only a pending receipt owned by the actor can be attached. */
export const receiptAttachCondition =
  'ownerId = :actorId AND #state = :pending';

/** Only a receipt attached to the expected claim can be replaced or removed. */
export const receiptRetireCondition =
  '#state = :attached AND attachedClaimId = :claimId';

/** A receipt operation that cannot be built from its inputs. */
export class ReceiptOperationError extends Error {
  public constructor(problem: string) {
    super(`Cannot build the receipt operation: ${problem}.`);
    this.name = 'ReceiptOperationError';
  }
}

/** `Put` of new pending metadata, written only if absent. */
export function createPendingReceiptOperation(
  tableName: string,
  record: PendingReceiptRecord,
): TransactionItem {
  checkTable(tableName);
  checkState(record.state, 'PENDING', 'a new receipt must be PENDING');
  return {
    Put: {
      TableName: tableName,
      Item: encodeReceiptItem(record),
      ConditionExpression: receiptCreateCondition,
    },
  };
}

/**
 * `Update` of pending metadata to `ATTACHED`: sets the measured values, the
 * claim, and the final object key, and removes the declaration and the TTL.
 * The receipt ID, owner, file name, and upload time are kept.
 */
export function attachReceiptOperation(
  tableName: string,
  pending: PendingReceiptRecord,
  attached: AttachedReceiptRecord,
  actorId: string,
): TransactionItem {
  checkTable(tableName);
  checkState(
    pending.state,
    'PENDING',
    'only a PENDING receipt can be attached',
  );
  checkState(attached.state, 'ATTACHED', 'the new state must be ATTACHED');
  encodeReceiptItem(pending);
  encodeReceiptItem(attached);
  checkSameUpload(pending, attached);
  // The object was verified against the declaration, so they must agree.
  if (attached.contentType !== pending.declaredContentType) {
    throw new ReceiptOperationError(
      'the measured content type differs from the declared one',
    );
  }
  if (attached.sizeBytes !== pending.declaredSizeBytes) {
    throw new ReceiptOperationError(
      'the measured size differs from the declared one',
    );
  }
  if (attached.checksumSha256 !== pending.declaredChecksumSha256) {
    throw new ReceiptOperationError(
      'the measured checksum differs from the declared one',
    );
  }
  if (!idSchema.safeParse(actorId).success) {
    throw new ReceiptOperationError('the actor ID is not valid');
  }
  if (actorId !== pending.ownerId) {
    throw new ReceiptOperationError('only the owner can attach the receipt');
  }
  return {
    Update: {
      TableName: tableName,
      Key: receiptKey(pending.receiptId),
      UpdateExpression:
        'SET #state = :state, #contentType = :contentType, ' +
        '#sizeBytes = :sizeBytes, #checksumSha256 = :checksumSha256, ' +
        '#attachedClaimId = :attachedClaimId, #objectKey = :objectKey ' +
        'REMOVE #declaredContentType, #declaredSizeBytes, ' +
        '#declaredChecksumSha256, #expiresAt',
      ConditionExpression: receiptAttachCondition,
      ExpressionAttributeNames: {
        '#state': 'state',
        '#contentType': 'contentType',
        '#sizeBytes': 'sizeBytes',
        '#checksumSha256': 'checksumSha256',
        '#attachedClaimId': 'attachedClaimId',
        '#objectKey': 'objectKey',
        '#declaredContentType': 'declaredContentType',
        '#declaredSizeBytes': 'declaredSizeBytes',
        '#declaredChecksumSha256': 'declaredChecksumSha256',
        '#expiresAt': 'expiresAt',
      },
      ExpressionAttributeValues: {
        ':state': 'ATTACHED',
        ':contentType': attached.contentType,
        ':sizeBytes': attached.sizeBytes,
        ':checksumSha256': attached.checksumSha256,
        ':attachedClaimId': attached.attachedClaimId,
        ':objectKey': receiptObjectKey(attached.receiptId),
        ':actorId': actorId,
        ':pending': 'PENDING',
      },
    },
  };
}

/**
 * `Update` of attached metadata to `REPLACED` or `REMOVED`, with a TTL 30
 * days after `changedAt`. Nothing else changes; the object stays at
 * `receipts/<receiptId>` until the cleanup worker deletes it.
 */
export function retireReceiptOperation(
  tableName: string,
  attached: AttachedReceiptRecord,
  retired: RetiredReceiptRecord,
  changedAt: string,
): TransactionItem {
  checkTable(tableName);
  checkState(
    attached.state,
    'ATTACHED',
    'only an ATTACHED receipt can be retired',
  );
  if (retired.state !== 'REPLACED' && retired.state !== 'REMOVED') {
    throw new ReceiptOperationError(
      'the new state must be REPLACED or REMOVED',
    );
  }
  encodeReceiptItem(attached);
  encodeReceiptItem(retired);
  checkSameUpload(attached, retired);
  if (
    retired.contentType !== attached.contentType ||
    retired.sizeBytes !== attached.sizeBytes ||
    retired.checksumSha256 !== attached.checksumSha256 ||
    retired.attachedClaimId !== attached.attachedClaimId
  ) {
    throw new ReceiptOperationError(
      'the retired receipt must keep its measured values and claim',
    );
  }
  if (!isIsoTimestamp(changedAt)) {
    throw new ReceiptOperationError('changedAt is not a valid timestamp');
  }
  if (changedAt < attached.uploadedAt) {
    throw new ReceiptOperationError('changedAt is before the upload');
  }
  if (retired.expiresAt !== retiredReceiptExpiresAt(changedAt)) {
    throw new ReceiptOperationError(
      'expiresAt must be exactly 30 days after changedAt',
    );
  }
  return {
    Update: {
      TableName: tableName,
      Key: receiptKey(attached.receiptId),
      UpdateExpression: 'SET #state = :state, #expiresAt = :expiresAt',
      ConditionExpression: receiptRetireCondition,
      ExpressionAttributeNames: {
        '#state': 'state',
        '#expiresAt': 'expiresAt',
      },
      ExpressionAttributeValues: {
        ':state': retired.state,
        ':expiresAt': retired.expiresAt,
        ':attached': 'ATTACHED',
        ':claimId': attached.attachedClaimId,
      },
    },
  };
}

/** Both records describe the same upload. */
function checkSameUpload(
  before: {
    receiptId: string;
    ownerId: string;
    fileName: string;
    uploadedAt: string;
  },
  after: {
    receiptId: string;
    ownerId: string;
    fileName: string;
    uploadedAt: string;
  },
): void {
  if (before.receiptId !== after.receiptId) {
    throw new ReceiptOperationError('the records are for different receipts');
  }
  if (before.ownerId !== after.ownerId) {
    throw new ReceiptOperationError('the records have different owners');
  }
  if (before.fileName !== after.fileName) {
    throw new ReceiptOperationError('the records have different file names');
  }
  if (before.uploadedAt !== after.uploadedAt) {
    throw new ReceiptOperationError('the records have different upload times');
  }
}

/** A runtime check for callers that bypass the record types. */
function checkState(actual: string, expected: string, problem: string): void {
  if (actual !== expected) {
    throw new ReceiptOperationError(problem);
  }
}

function checkTable(tableName: string): void {
  if (typeof tableName !== 'string' || tableName.length === 0) {
    throw new ReceiptOperationError('the table name is missing');
  }
}
