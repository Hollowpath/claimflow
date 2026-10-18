import {
  isChecksumSha256,
  maxReceiptSizeBytes,
  receiptContentTypes,
  sanitizeFileName,
  type ReceiptContentType,
} from '@claimflow/domain';

import { expiresAfter, type EpochSeconds } from '../../application/commit.js';
import {
  AttributeReader,
  failWith,
  ItemEncodingError,
  ItemIntegrityError,
  type DynamoItem,
  type Fail,
} from './dynamodb-items.js';

/**
 * Pure codecs for receipt metadata items (docs/aws-architecture.md, sections
 * 7, 11, and 14). The persisted lifecycle is kept separate from the domain
 * `Receipt` and `UploadedReceipt` types.
 */

export const receiptEntityType = 'Receipt';

/** Pending uploads expire 24 hours after upload (section 14). */
export const pendingReceiptRetentionMs = 24 * 60 * 60 * 1000;
/** Replaced and removed receipts expire 30 days after the change. */
export const retiredReceiptRetentionMs = 30 * 24 * 60 * 60 * 1000;

/** Fields every receipt item has, whatever its state. */
interface ReceiptItemBase {
  readonly receiptId: string;
  readonly ownerId: string;
  /** Already in the domain's sanitized form. */
  readonly fileName: string;
  readonly uploadedAt: string;
}

/** What the server measured from the uploaded object. */
interface MeasuredReceipt {
  readonly contentType: ReceiptContentType;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
}

/** Uploaded but not attached; only the client's declaration is known. */
export interface PendingReceiptRecord extends ReceiptItemBase {
  readonly state: 'PENDING';
  readonly declaredContentType: ReceiptContentType;
  readonly declaredSizeBytes: number;
  readonly declaredChecksumSha256: string;
  /** Exactly 24 hours after `uploadedAt`. */
  readonly expiresAt: EpochSeconds;
}

/** Attached to a claim; kept until the claim no longer uses it. */
export interface AttachedReceiptRecord
  extends ReceiptItemBase, MeasuredReceipt {
  readonly state: 'ATTACHED';
  readonly attachedClaimId: string;
}

/** Replaced or removed from its claim; kept for 30 days. */
export interface RetiredReceiptRecord extends ReceiptItemBase, MeasuredReceipt {
  readonly state: 'REPLACED' | 'REMOVED';
  readonly attachedClaimId: string;
  /** 30 days after the state change; see `retiredReceiptExpiresAt`. */
  readonly expiresAt: EpochSeconds;
}

export type ReceiptRecord =
  PendingReceiptRecord | AttachedReceiptRecord | RetiredReceiptRecord;

export type ReceiptState = ReceiptRecord['state'];

export const receiptStates = [
  'PENDING',
  'ATTACHED',
  'REPLACED',
  'REMOVED',
] as const satisfies readonly ReceiptState[];

export function receiptKey(receiptId: string) {
  return { PK: `RECEIPT#${receiptId}`, SK: 'RECEIPT' } as const;
}

/** Where the uploaded object is while the receipt is pending. */
export function pendingObjectKey(receiptId: string): string {
  return `uploads/pending/${receiptId}`;
}

/** Where the object is once the receipt has been attached. */
export function receiptObjectKey(receiptId: string): string {
  return `receipts/${receiptId}`;
}

export function objectKeyFor(state: ReceiptState, receiptId: string): string {
  return state === 'PENDING'
    ? pendingObjectKey(receiptId)
    : receiptObjectKey(receiptId);
}

/** The TTL of a pending receipt: exactly 24 hours after upload. */
export function pendingReceiptExpiresAt(uploadedAt: string): EpochSeconds {
  return expiresAfter(new Date(uploadedAt), pendingReceiptRetentionMs);
}

/** The TTL of a replaced or removed receipt: 30 days after the change. */
export function retiredReceiptExpiresAt(changedAt: string): EpochSeconds {
  return expiresAfter(new Date(changedAt), retiredReceiptRetentionMs);
}

const commonAttributes = [
  'PK',
  'SK',
  'entityType',
  'receiptId',
  'ownerId',
  'state',
  'fileName',
  'objectKey',
  'uploadedAt',
] as const;

const declaredAttributes = [
  'declaredContentType',
  'declaredSizeBytes',
  'declaredChecksumSha256',
] as const;
const measuredAttributes = [
  'contentType',
  'sizeBytes',
  'checksumSha256',
] as const;

/** The state-specific attributes each state requires; all others are forbidden. */
const stateAttributes: Readonly<Record<ReceiptState, readonly string[]>> = {
  PENDING: [...declaredAttributes, 'expiresAt'],
  ATTACHED: [...measuredAttributes, 'attachedClaimId'],
  REPLACED: [...measuredAttributes, 'attachedClaimId', 'expiresAt'],
  REMOVED: [...measuredAttributes, 'attachedClaimId', 'expiresAt'],
};

const stateSpecificAttributes = new Set([
  ...declaredAttributes,
  ...measuredAttributes,
  'attachedClaimId',
  'expiresAt',
]);

export function encodeReceiptItem(record: ReceiptRecord): DynamoItem {
  const common = {
    ...receiptKey(record.receiptId),
    entityType: receiptEntityType,
    receiptId: record.receiptId,
    ownerId: record.ownerId,
    state: record.state,
    fileName: record.fileName,
    objectKey: objectKeyFor(record.state, record.receiptId),
    uploadedAt: record.uploadedAt,
  };
  const specific =
    record.state === 'PENDING'
      ? {
          declaredContentType: record.declaredContentType,
          declaredSizeBytes: record.declaredSizeBytes,
          declaredChecksumSha256: record.declaredChecksumSha256,
          expiresAt: record.expiresAt,
        }
      : {
          contentType: record.contentType,
          sizeBytes: record.sizeBytes,
          checksumSha256: record.checksumSha256,
          attachedClaimId: record.attachedClaimId,
          ...(record.state === 'ATTACHED'
            ? {}
            : { expiresAt: record.expiresAt }),
        };
  const item: DynamoItem = { ...common, ...specific };
  readReceipt(item, failWith(ItemEncodingError, item));
  return item;
}

export function decodeReceiptItem(item: DynamoItem): ReceiptRecord {
  return readReceipt(item, failWith(ItemIntegrityError, item));
}

function readReceipt(item: DynamoItem, fail: Fail): ReceiptRecord {
  const read = new AttributeReader(item, fail);
  read.noIndexes();
  const state = read.oneOf<ReceiptState>('state', receiptStates);

  const required = new Set(stateAttributes[state]);
  for (const name of Object.keys(item)) {
    if (stateSpecificAttributes.has(name) && !required.has(name)) {
      fail(`${name} is not allowed for a ${state} receipt`);
    }
  }
  read.allowOnly(new Set([...commonAttributes, ...required]));
  for (const name of required) {
    if (!read.has(name)) {
      fail(`${name} is required for a ${state} receipt`);
    }
  }

  read.entityType(receiptEntityType);
  const receiptId = read.id('receiptId');
  read.keys(receiptKey(receiptId));
  if (item.objectKey !== objectKeyFor(state, receiptId)) {
    fail(`objectKey is not the ${state} object key`);
  }

  const base: ReceiptItemBase = {
    receiptId,
    ownerId: read.id('ownerId'),
    fileName: read.check(
      'fileName',
      (value) => value === sanitizeFileName(value),
    ),
    uploadedAt: read.timestamp('uploadedAt'),
  };

  if (state === 'PENDING') {
    const expiresAt = read.positiveInteger('expiresAt');
    if (expiresAt !== pendingReceiptExpiresAt(base.uploadedAt)) {
      fail('expiresAt must be exactly 24 hours after uploadedAt');
    }
    return {
      ...base,
      state,
      declaredContentType: readContentType(read, 'declaredContentType'),
      declaredSizeBytes: readSize(read, 'declaredSizeBytes', fail),
      declaredChecksumSha256: read.check(
        'declaredChecksumSha256',
        isChecksumSha256,
      ),
      expiresAt,
    };
  }

  const measured: MeasuredReceipt = {
    contentType: readContentType(read, 'contentType'),
    sizeBytes: readSize(read, 'sizeBytes', fail),
    checksumSha256: read.check('checksumSha256', isChecksumSha256),
  };
  const attachedClaimId = read.id('attachedClaimId');
  if (state === 'ATTACHED') {
    return { ...base, ...measured, state, attachedClaimId };
  }
  return {
    ...base,
    ...measured,
    state,
    attachedClaimId,
    expiresAt: read.positiveInteger('expiresAt'),
  };
}

function readContentType(
  read: AttributeReader,
  name: string,
): ReceiptContentType {
  return read.oneOf<ReceiptContentType>(name, receiptContentTypes);
}

/** 1 byte to the domain's 10 MB maximum. */
function readSize(read: AttributeReader, name: string, fail: Fail): number {
  const size = read.positiveInteger(name);
  return size <= maxReceiptSizeBytes
    ? size
    : fail(`${name} exceeds the maximum receipt size`);
}
