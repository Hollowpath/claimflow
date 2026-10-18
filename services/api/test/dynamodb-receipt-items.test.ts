import { maxReceiptSizeBytes, receiptContentTypes } from '@claimflow/domain';
import { describe, expect, it } from 'vitest';

import {
  indexAttributes,
  invalidKeyIdentifier,
  ItemEncodingError,
  ItemIntegrityError,
  type DynamoItem,
} from '../src/adapters/aws/dynamodb-items.js';
import {
  decodeReceiptItem,
  encodeReceiptItem,
  objectKeyFor,
  pendingObjectKey,
  pendingReceiptExpiresAt,
  receiptKey,
  receiptObjectKey,
  retiredReceiptExpiresAt,
  type AttachedReceiptRecord,
  type PendingReceiptRecord,
  type ReceiptRecord,
  type RetiredReceiptRecord,
} from '../src/adapters/aws/dynamodb-receipt-items.js';
import { toEpochSeconds } from '../src/application/commit.js';

const checksum = '9f2c'.repeat(16);
const measuredChecksum = 'a1b2'.repeat(16);
const claimId = '4ce0c74b-9c64-46d6-87ba-07fb71b0628c';

/** The approved pending example (section 7), with a complete checksum. */
const pending: PendingReceiptRecord = {
  receiptId: 'r-7731',
  ownerId: 'sub-aisha',
  state: 'PENDING',
  fileName: 'flight.pdf',
  declaredContentType: 'application/pdf',
  declaredSizeBytes: 52_144,
  declaredChecksumSha256: checksum,
  uploadedAt: '2026-10-14T10:35:00.000Z',
  expiresAt: 1_792_060_500,
};

const attached: AttachedReceiptRecord = {
  receiptId: 'r-7731',
  ownerId: 'sub-aisha',
  state: 'ATTACHED',
  fileName: 'flight.pdf',
  contentType: 'application/pdf',
  sizeBytes: 52_144,
  checksumSha256: measuredChecksum,
  uploadedAt: '2026-10-14T10:35:00.000Z',
  attachedClaimId: claimId,
};

const retired = (state: 'REPLACED' | 'REMOVED'): RetiredReceiptRecord => ({
  ...attached,
  state,
  expiresAt: retiredReceiptExpiresAt('2026-10-20T08:00:00.000Z'),
});

const allStates: readonly ReceiptRecord[] = [
  pending,
  attached,
  retired('REPLACED'),
  retired('REMOVED'),
];

function errorOf(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** An item with `changes` applied; `undefined` removes an attribute. */
function changed(item: DynamoItem, changes: DynamoItem): DynamoItem {
  const result = { ...item, ...changes };
  for (const [name, value] of Object.entries(changes)) {
    if (value === undefined) {
      delete result[name];
    }
  }
  return result;
}

describe('receipt items', () => {
  it('encode the approved pending example exactly', () => {
    expect(encodeReceiptItem(pending)).toEqual({
      PK: 'RECEIPT#r-7731',
      SK: 'RECEIPT',
      entityType: 'Receipt',
      receiptId: 'r-7731',
      ownerId: 'sub-aisha',
      state: 'PENDING',
      fileName: 'flight.pdf',
      declaredContentType: 'application/pdf',
      declaredSizeBytes: 52_144,
      declaredChecksumSha256: checksum,
      objectKey: 'uploads/pending/r-7731',
      uploadedAt: '2026-10-14T10:35:00.000Z',
      expiresAt: 1_792_060_500,
    });
  });

  it('encode an attached receipt with measured values and no TTL', () => {
    expect(encodeReceiptItem(attached)).toEqual({
      PK: 'RECEIPT#r-7731',
      SK: 'RECEIPT',
      entityType: 'Receipt',
      receiptId: 'r-7731',
      ownerId: 'sub-aisha',
      state: 'ATTACHED',
      fileName: 'flight.pdf',
      contentType: 'application/pdf',
      sizeBytes: 52_144,
      checksumSha256: measuredChecksum,
      objectKey: 'receipts/r-7731',
      uploadedAt: '2026-10-14T10:35:00.000Z',
      attachedClaimId: claimId,
    });
  });

  it.each(allStates.map((record) => [record.state, record] as const))(
    'round-trip a %s receipt without index attributes or undefined values',
    (_state, record) => {
      const item = encodeReceiptItem(record);

      expect(decodeReceiptItem(item)).toEqual(record);
      expect(Object.values(item)).not.toContain(undefined);
      for (const name of indexAttributes) {
        expect(item).not.toHaveProperty(name);
      }
    },
  );

  it('derive keys and object keys for each state', () => {
    expect(receiptKey('r-1')).toEqual({ PK: 'RECEIPT#r-1', SK: 'RECEIPT' });
    expect(pendingObjectKey('r-1')).toBe('uploads/pending/r-1');
    expect(receiptObjectKey('r-1')).toBe('receipts/r-1');
    expect(objectKeyFor('PENDING', 'r-1')).toBe('uploads/pending/r-1');
    for (const state of ['ATTACHED', 'REPLACED', 'REMOVED'] as const) {
      expect(objectKeyFor(state, 'r-1')).toBe('receipts/r-1');
    }
  });
});

describe('TTL helpers', () => {
  it('expire pending receipts exactly 24 hours after upload', () => {
    const uploadedAt = '2026-10-14T10:35:00.000Z';

    expect(pendingReceiptExpiresAt(uploadedAt)).toBe(
      toEpochSeconds(new Date(uploadedAt)) + 24 * 60 * 60,
    );
    expect(pendingReceiptExpiresAt(uploadedAt)).toBe(pending.expiresAt);
  });

  it('expire replaced and removed receipts exactly 30 days after the change', () => {
    const changedAt = '2026-10-20T08:00:00.000Z';

    expect(retiredReceiptExpiresAt(changedAt)).toBe(
      toEpochSeconds(new Date(changedAt)) + 30 * 24 * 60 * 60,
    );
    expect(Number.isSafeInteger(retiredReceiptExpiresAt(changedAt))).toBe(true);
  });

  it.each([-1, 1, 3600])(
    'reject a pending TTL %s seconds away from exactly 24 hours',
    (offset) => {
      const expiresAt = pending.expiresAt + offset;

      expect(() => encodeReceiptItem({ ...pending, expiresAt })).toThrow(
        ItemEncodingError,
      );
      expect(() =>
        decodeReceiptItem({ ...encodeReceiptItem(pending), expiresAt }),
      ).toThrow('expiresAt must be exactly 24 hours after uploadedAt');
    },
  );
});

describe('content types and sizes', () => {
  it.each(receiptContentTypes)('accept %s in every state', (contentType) => {
    const records: ReceiptRecord[] = [
      { ...pending, declaredContentType: contentType },
      { ...attached, contentType },
      { ...retired('REMOVED'), contentType },
    ];

    for (const record of records) {
      expect(decodeReceiptItem(encodeReceiptItem(record))).toEqual(record);
    }
  });

  it.each([1, maxReceiptSizeBytes])('accept a size of %s bytes', (size) => {
    const records: ReceiptRecord[] = [
      { ...pending, declaredSizeBytes: size },
      { ...attached, sizeBytes: size },
    ];

    for (const record of records) {
      expect(decodeReceiptItem(encodeReceiptItem(record))).toEqual(record);
    }
  });

  it.each([0, -1, 1.5, maxReceiptSizeBytes + 1, Number.MAX_SAFE_INTEGER + 2])(
    'refuse a size of %s bytes',
    (size) => {
      expect(() =>
        encodeReceiptItem({ ...pending, declaredSizeBytes: size }),
      ).toThrow(ItemEncodingError);
      expect(() => encodeReceiptItem({ ...attached, sizeBytes: size })).toThrow(
        ItemEncodingError,
      );
    },
  );
});

describe('validation', () => {
  const pendingItem = () => encodeReceiptItem(pending);
  const attachedItem = () => encodeReceiptItem(attached);
  const removedItem = () => encodeReceiptItem(retired('REMOVED'));

  it.each<[string, () => DynamoItem, DynamoItem, string]>([
    ['a wrong partition key', pendingItem, { PK: 'RECEIPT#r-other' }, 'key'],
    ['a wrong sort key', pendingItem, { SK: 'RECEIPTS' }, 'key'],
    ['a wrong entity type', pendingItem, { entityType: 'Claim' }, 'entityType'],
    ['an unknown state', pendingItem, { state: 'UPLOADED' }, 'state'],
    [
      'a receipt ID with a separator',
      pendingItem,
      { receiptId: 'r#1' },
      'receiptId',
    ],
    ['an invalid owner', pendingItem, { ownerId: '' }, 'ownerId'],
    [
      'a non-canonical upload time',
      pendingItem,
      { uploadedAt: '2026-10-14T10:35:00Z' },
      'uploadedAt',
    ],
    [
      'a TTL stored as text',
      pendingItem,
      { expiresAt: '1792060500' },
      'expiresAt',
    ],
    ['a fractional TTL', removedItem, { expiresAt: 1.5 }, 'expiresAt'],
    ['a negative TTL', removedItem, { expiresAt: -1 }, 'expiresAt'],
    [
      'an unsupported declared type',
      pendingItem,
      { declaredContentType: 'image/gif' },
      'declaredContentType',
    ],
    [
      'an unsupported measured type',
      attachedItem,
      { contentType: 'text/plain' },
      'contentType',
    ],
    [
      'a size stored as text',
      attachedItem,
      { sizeBytes: '52144' },
      'sizeBytes',
    ],
    [
      'an oversized declared size',
      pendingItem,
      { declaredSizeBytes: maxReceiptSizeBytes + 1 },
      'declaredSizeBytes',
    ],
    [
      'an upper-case checksum',
      attachedItem,
      { checksumSha256: checksum.toUpperCase() },
      'checksumSha256',
    ],
    [
      'a truncated checksum',
      pendingItem,
      { declaredChecksumSha256: '9f2c…' },
      'declaredChecksumSha256',
    ],
    [
      'an attached object key on a pending receipt',
      pendingItem,
      { objectKey: 'receipts/r-7731' },
      'objectKey',
    ],
    [
      'a pending object key on an attached receipt',
      attachedItem,
      { objectKey: 'uploads/pending/r-7731' },
      'objectKey',
    ],
    [
      'another receipt object',
      removedItem,
      { objectKey: 'receipts/r-0000' },
      'objectKey',
    ],
    [
      'an attached claim that is not an ID',
      attachedItem,
      { attachedClaimId: 'claim #1' },
      'attachedClaimId',
    ],
  ])('reject %s', (_name, build, changes, problem) => {
    const decode = () => decodeReceiptItem(changed(build(), changes));

    expect(decode).toThrow(ItemIntegrityError);
    expect(decode).toThrow(problem);
  });

  it.each<[string, () => DynamoItem, string]>([
    ['declaredSizeBytes', pendingItem, 'PENDING'],
    ['expiresAt', pendingItem, 'PENDING'],
    ['contentType', attachedItem, 'ATTACHED'],
    ['attachedClaimId', attachedItem, 'ATTACHED'],
    ['expiresAt', removedItem, 'REMOVED'],
    ['checksumSha256', removedItem, 'REMOVED'],
  ])('require %s for a %s receipt', (name, build, state) => {
    expect(() =>
      decodeReceiptItem(changed(build(), { [name]: undefined })),
    ).toThrow(`${name} is required for a ${state} receipt`);
  });

  it.each<[string, () => DynamoItem, unknown, string]>([
    ['contentType', pendingItem, 'application/pdf', 'PENDING'],
    ['attachedClaimId', pendingItem, claimId, 'PENDING'],
    ['expiresAt', attachedItem, 1_792_060_500, 'ATTACHED'],
    ['declaredChecksumSha256', attachedItem, checksum, 'ATTACHED'],
    ['declaredContentType', removedItem, 'application/pdf', 'REMOVED'],
  ])('forbid %s on a %s receipt', (name, build, value, state) => {
    expect(() => decodeReceiptItem({ ...build(), [name]: value })).toThrow(
      `${name} is not allowed for a ${state} receipt`,
    );
  });

  it.each(['GSI1PK', 'GSI4PK', 'GSI4SK'])(
    'reject the index attribute %s',
    (name) => {
      expect(() =>
        decodeReceiptItem({ ...pendingItem(), [name]: 'x' }),
      ).toThrow(`this item type must not have ${name}`);
    },
  );

  it('reject unexpected attributes', () => {
    expect(() =>
      decodeReceiptItem({ ...attachedItem(), storageClass: 'STANDARD' }),
    ).toThrow('unexpected attribute');
  });
});

describe('file names', () => {
  it.each<[string, string]>([
    ['a path', 'scans/flight.pdf'],
    ['a Windows path', 'C:\\Users\\aisha\\flight.pdf'],
    ['a control character', 'flight\u0007.pdf'],
    ['an unsafe character', 'flight<1>.pdf'],
    ['surrounding whitespace', ' flight.pdf '],
    ['a leading dot', '.flight.pdf'],
    ['an empty name', ''],
    ['more than 120 characters', `${'a'.repeat(117)}.pdf`],
  ])('refuse and reject a name with %s', (_name, fileName) => {
    for (const record of allStates) {
      expect(() => encodeReceiptItem({ ...record, fileName })).toThrow(
        ItemEncodingError,
      );
      expect(() =>
        decodeReceiptItem({ ...encodeReceiptItem(record), fileName }),
      ).toThrow('fileName is not valid');
    }
  });
});

describe('safe errors', () => {
  const secret = 'Payslip Aisha Rahman October.pdf';

  it('never reveal stored file names', () => {
    const error = errorOf(() =>
      decodeReceiptItem({
        ...encodeReceiptItem(attached),
        fileName: `/${secret}`,
      }),
    );

    expect(error).toBeInstanceOf(ItemIntegrityError);
    expect(String(error)).toContain('RECEIPT#r-7731 / RECEIPT');
    expect(String(error)).not.toContain('Payslip');
  });

  it('never reveal malformed keys', () => {
    const error = errorOf(() =>
      decodeReceiptItem({
        ...encodeReceiptItem(pending),
        PK: `RECEIPT#${secret}`,
      }),
    );

    expect(error).toBeInstanceOf(ItemIntegrityError);
    expect(String(error)).toContain(invalidKeyIdentifier);
    expect(String(error)).not.toContain('Payslip');
  });

  it('use the encoding error for invalid records', () => {
    expect(() => encodeReceiptItem({ ...pending, ownerId: 'a b' })).toThrow(
      ItemEncodingError,
    );
  });
});
