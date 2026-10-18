import { readFile } from 'node:fs/promises';

import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  maxReceiptSizeBytes,
  receiptContentTypes,
  type Claim,
  type ClaimHistoryEntry,
} from '@claimflow/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { decrementClaimCountOperation } from '../src/adapters/aws/dynamodb-category-operations.js';
import {
  deleteDraftOperation,
  updateClaimOperations,
} from '../src/adapters/aws/dynamodb-claim-operations.js';
import {
  ItemEncodingError,
  type DynamoItem,
} from '../src/adapters/aws/dynamodb-items.js';
import {
  decodeReceiptItem,
  encodeReceiptItem,
  pendingReceiptExpiresAt,
  retiredReceiptExpiresAt,
  type AttachedReceiptRecord,
  type PendingReceiptRecord,
  type RetiredReceiptRecord,
} from '../src/adapters/aws/dynamodb-receipt-items.js';
import {
  attachReceiptOperation,
  createPendingReceiptOperation,
  receiptAttachCondition,
  receiptCreateCondition,
  ReceiptOperationError,
  receiptRetireCondition,
  retireReceiptOperation,
} from '../src/adapters/aws/dynamodb-receipt-operations.js';
import {
  composeBusinessTransaction,
  type TransactionItem,
} from '../src/adapters/aws/dynamodb-transaction.js';
import type { CompletedRequest } from '../src/application/commit.js';
import { eventSource, type OutboxEvent } from '../src/application/events.js';

const tableName = 'ClaimFlow';
const claimId = '4ce0c74b-9c64-46d6-87ba-07fb71b0628c';
const secretFileName = 'Payslip Aisha Rahman October.pdf';
const uploadedAt = '2026-10-14T10:35:00.000Z';
const changedAt = '2026-10-20T08:00:00.000Z';
const key = { PK: 'RECEIPT#r-7731', SK: 'RECEIPT' };

const pending: PendingReceiptRecord = {
  receiptId: 'r-7731',
  ownerId: 'sub-aisha',
  state: 'PENDING',
  fileName: secretFileName,
  declaredContentType: 'application/pdf',
  declaredSizeBytes: 52_144,
  declaredChecksumSha256: 'a1b2'.repeat(16),
  uploadedAt,
  expiresAt: pendingReceiptExpiresAt(uploadedAt),
};

const attached: AttachedReceiptRecord = {
  receiptId: 'r-7731',
  ownerId: 'sub-aisha',
  state: 'ATTACHED',
  fileName: secretFileName,
  contentType: 'application/pdf',
  sizeBytes: 52_144,
  checksumSha256: 'a1b2'.repeat(16),
  uploadedAt,
  attachedClaimId: claimId,
};

const retired = (state: 'REPLACED' | 'REMOVED'): RetiredReceiptRecord => ({
  ...attached,
  state,
  expiresAt: retiredReceiptExpiresAt(changedAt),
});

/** Applies an `Update`'s SET and REMOVE clauses to a stored item. */
function applyUpdate(
  stored: DynamoItem,
  operation: TransactionItem,
): DynamoItem {
  const update = operation.Update!;
  const names = update.ExpressionAttributeNames ?? {};
  const values = update.ExpressionAttributeValues ?? {};
  const [, setPart = '', removePart = ''] =
    /^SET (.*?)(?: REMOVE (.*))?$/.exec(update.UpdateExpression!) ?? [];
  const result = { ...stored };
  for (const assignment of setPart.split(', ')) {
    const [name, value] = assignment.split(' = ') as [string, string];
    result[names[name]!] = values[value];
  }
  for (const name of removePart === '' ? [] : removePart.split(', ')) {
    delete result[names[name]!];
  }
  return result;
}

function errorOf(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('create pending metadata', () => {
  it('puts the codec-encoded pending item only if absent', () => {
    expect(createPendingReceiptOperation(tableName, pending)).toEqual({
      Put: {
        TableName: 'ClaimFlow',
        Item: encodeReceiptItem(pending),
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    });
    expect(receiptCreateCondition).toBe('attribute_not_exists(PK)');
  });

  it('keeps the codec’s exact 24-hour TTL and pending object key', () => {
    const item = createPendingReceiptOperation(tableName, pending).Put!.Item!;

    expect(item.expiresAt).toBe(
      Math.floor(Date.parse(uploadedAt) / 1000) + 24 * 60 * 60,
    );
    expect(item.objectKey).toBe('uploads/pending/r-7731');
    expect(() =>
      createPendingReceiptOperation(tableName, {
        ...pending,
        expiresAt: pending.expiresAt + 1,
      }),
    ).toThrow(ItemEncodingError);
  });

  it('refuses a record in another state', () => {
    expect(() =>
      createPendingReceiptOperation(
        tableName,
        attached as unknown as PendingReceiptRecord,
      ),
    ).toThrow('a new receipt must be PENDING');
  });
});

describe('attach', () => {
  it('builds the exact Update from PENDING to ATTACHED', () => {
    expect(
      attachReceiptOperation(tableName, pending, attached, 'sub-aisha'),
    ).toEqual({
      Update: {
        TableName: 'ClaimFlow',
        Key: key,
        UpdateExpression:
          'SET #state = :state, #contentType = :contentType, ' +
          '#sizeBytes = :sizeBytes, #checksumSha256 = :checksumSha256, ' +
          '#attachedClaimId = :attachedClaimId, #objectKey = :objectKey ' +
          'REMOVE #declaredContentType, #declaredSizeBytes, ' +
          '#declaredChecksumSha256, #expiresAt',
        ConditionExpression: 'ownerId = :actorId AND #state = :pending',
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
          ':contentType': 'application/pdf',
          ':sizeBytes': 52_144,
          ':checksumSha256': 'a1b2'.repeat(16),
          ':attachedClaimId': claimId,
          ':objectKey': 'receipts/r-7731',
          ':actorId': 'sub-aisha',
          ':pending': 'PENDING',
        },
      },
    });
    expect(receiptAttachCondition).toBe(
      'ownerId = :actorId AND #state = :pending',
    );
  });

  it('turns the stored pending item into exactly the encoded attached item', () => {
    const result = applyUpdate(
      encodeReceiptItem(pending),
      attachReceiptOperation(tableName, pending, attached, 'sub-aisha'),
    );

    expect(result).toEqual(encodeReceiptItem(attached));
    expect(decodeReceiptItem(result)).toEqual(attached);
    for (const name of [
      'declaredContentType',
      'declaredSizeBytes',
      'declaredChecksumSha256',
      'expiresAt',
    ]) {
      expect(result).not.toHaveProperty(name);
    }
  });

  it.each(receiptContentTypes)(
    'attaches a declared and measured %s',
    (contentType) => {
      const declared = { ...pending, declaredContentType: contentType };
      const measured = { ...attached, contentType };
      const result = applyUpdate(
        encodeReceiptItem(declared),
        attachReceiptOperation(tableName, declared, measured, 'sub-aisha'),
      );

      expect(decodeReceiptItem(result)).toEqual(measured);
    },
  );

  it.each([1, maxReceiptSizeBytes])(
    'attaches a declared and measured size of %s bytes',
    (sizeBytes) => {
      const declared = { ...pending, declaredSizeBytes: sizeBytes };
      const measured = { ...attached, sizeBytes };
      const result = applyUpdate(
        encodeReceiptItem(declared),
        attachReceiptOperation(tableName, declared, measured, 'sub-aisha'),
      );

      expect(decodeReceiptItem(result)).toEqual(measured);
    },
  );

  it.each<[string, Partial<AttachedReceiptRecord>, string]>([
    ['content type', { contentType: 'image/png' }, 'measured content type'],
    ['size', { sizeBytes: 52_145 }, 'measured size'],
    ['checksum', { checksumSha256: 'c3d4'.repeat(16) }, 'measured checksum'],
  ])(
    'refuses a measured %s that differs from the declaration',
    (_name, change, problem) => {
      const error = (() => {
        try {
          attachReceiptOperation(
            tableName,
            pending,
            { ...attached, ...change },
            'sub-aisha',
          );
        } catch (e) {
          return e;
        }
      })();

      expect(error).toBeInstanceOf(ReceiptOperationError);
      expect(String(error)).toContain(problem);
      for (const value of [
        'image/png',
        'application/pdf',
        '52145',
        '52144',
        'c3d4',
        'a1b2',
        'Payslip',
      ]) {
        expect(String(error)).not.toContain(value);
      }
    },
  );

  it.each<[string, Partial<AttachedReceiptRecord>]>([
    ['an oversized measurement', { sizeBytes: maxReceiptSizeBytes + 1 }],
    ['an empty measurement', { sizeBytes: 0 }],
    ['an unsupported type', { contentType: 'image/gif' as never }],
    ['an invalid checksum', { checksumSha256: 'xyz' }],
    ['an invalid claim', { attachedClaimId: 'claim #1' }],
  ])('refuses %s through the codec', (_name, change) => {
    expect(() =>
      attachReceiptOperation(
        tableName,
        pending,
        { ...attached, ...change },
        'sub-aisha',
      ),
    ).toThrow(ItemEncodingError);
  });

  it.each<[string, Partial<AttachedReceiptRecord>, string]>([
    ['another receipt', { receiptId: 'r-0001' }, 'different receipts'],
    ['another owner', { ownerId: 'sub-ravi' }, 'different owners'],
    ['another file name', { fileName: 'other.pdf' }, 'different file names'],
    [
      'another upload time',
      { uploadedAt: '2026-10-14T10:36:00.000Z' },
      'different upload times',
    ],
  ])('refuses records for %s', (_name, change, problem) => {
    expect(() =>
      attachReceiptOperation(
        tableName,
        pending,
        { ...attached, ...change },
        'sub-aisha',
      ),
    ).toThrow(problem);
  });

  it('refuses an actor who is not the owner, or an invalid actor', () => {
    expect(() =>
      attachReceiptOperation(tableName, pending, attached, 'sub-ravi'),
    ).toThrow('only the owner');
    expect(() =>
      attachReceiptOperation(tableName, pending, attached, 'sub aisha'),
    ).toThrow('actor ID');
  });

  it('refuses to attach anything but a pending record, or to a state other than ATTACHED', () => {
    expect(() =>
      attachReceiptOperation(
        tableName,
        attached as unknown as PendingReceiptRecord,
        attached,
        'sub-aisha',
      ),
    ).toThrow('only a PENDING receipt can be attached');
    expect(() =>
      attachReceiptOperation(
        tableName,
        pending,
        retired('REMOVED') as unknown as AttachedReceiptRecord,
        'sub-aisha',
      ),
    ).toThrow('the new state must be ATTACHED');
  });

  it('refuses an invalid pending record through the codec', () => {
    expect(() =>
      attachReceiptOperation(
        tableName,
        { ...pending, uploadedAt: '2026-10-14T10:35:00Z' },
        { ...attached, uploadedAt: '2026-10-14T10:35:00Z' },
        'sub-aisha',
      ),
    ).toThrow(ItemEncodingError);
  });
});

describe('retire', () => {
  it.each(['REPLACED', 'REMOVED'] as const)(
    'builds the exact Update from ATTACHED to %s',
    (state) => {
      expect(
        retireReceiptOperation(tableName, attached, retired(state), changedAt),
      ).toEqual({
        Update: {
          TableName: 'ClaimFlow',
          Key: key,
          UpdateExpression: 'SET #state = :state, #expiresAt = :expiresAt',
          ConditionExpression:
            '#state = :attached AND attachedClaimId = :claimId',
          ExpressionAttributeNames: {
            '#state': 'state',
            '#expiresAt': 'expiresAt',
          },
          ExpressionAttributeValues: {
            ':state': state,
            ':expiresAt': retiredReceiptExpiresAt(changedAt),
            ':attached': 'ATTACHED',
            ':claimId': claimId,
          },
        },
      });
    },
  );

  it.each(['REPLACED', 'REMOVED'] as const)(
    'changes only the state and TTL when %s',
    (state) => {
      const result = applyUpdate(
        encodeReceiptItem(attached),
        retireReceiptOperation(tableName, attached, retired(state), changedAt),
      );

      expect(result).toEqual(encodeReceiptItem(retired(state)));
      expect(result).toEqual({
        ...encodeReceiptItem(attached),
        state,
        expiresAt: retiredReceiptExpiresAt(changedAt),
      });
      expect(result.objectKey).toBe('receipts/r-7731');
    },
  );

  it('expires exactly 30 days after the change', () => {
    expect(retired('REMOVED').expiresAt).toBe(
      Math.floor(Date.parse(changedAt) / 1000) + 30 * 24 * 60 * 60,
    );
    expect(receiptRetireCondition).toBe(
      '#state = :attached AND attachedClaimId = :claimId',
    );
    for (const offset of [-1, 1, 86_400]) {
      expect(() =>
        retireReceiptOperation(
          tableName,
          attached,
          {
            ...retired('REMOVED'),
            expiresAt: retired('REMOVED').expiresAt + offset,
          },
          changedAt,
        ),
      ).toThrow('exactly 30 days after changedAt');
    }
  });

  it.each<[string, Partial<RetiredReceiptRecord>, string]>([
    ['another receipt', { receiptId: 'r-0001' }, 'different receipts'],
    ['another owner', { ownerId: 'sub-ravi' }, 'different owners'],
    ['another file name', { fileName: 'other.pdf' }, 'different file names'],
    [
      'another upload time',
      { uploadedAt: '2026-10-14T10:36:00.000Z' },
      'different upload times',
    ],
    [
      'another content type',
      { contentType: 'image/png' },
      'measured values and claim',
    ],
    ['another size', { sizeBytes: 1 }, 'measured values and claim'],
    [
      'another checksum',
      { checksumSha256: 'c3d4'.repeat(16) },
      'measured values and claim',
    ],
    [
      'another claim',
      { attachedClaimId: 'other-claim' },
      'measured values and claim',
    ],
  ])('refuses records for %s', (_name, change, problem) => {
    expect(() =>
      retireReceiptOperation(
        tableName,
        attached,
        { ...retired('REMOVED'), ...change },
        changedAt,
      ),
    ).toThrow(problem);
  });

  it.each<[string, string]>([
    ['a non-canonical time', '2026-10-20T08:00:00Z'],
    ['a date only', '2026-10-20'],
    ['an impossible time', '2026-02-30T00:00:00.000Z'],
    ['a time before the upload', '2026-10-14T10:00:00.000Z'],
  ])('refuses %s as changedAt', (_name, at) => {
    expect(() =>
      retireReceiptOperation(tableName, attached, retired('REMOVED'), at),
    ).toThrow(ReceiptOperationError);
  });

  it('refuses to retire anything but an attached record, or to another state', () => {
    expect(() =>
      retireReceiptOperation(
        tableName,
        pending as unknown as AttachedReceiptRecord,
        retired('REMOVED'),
        changedAt,
      ),
    ).toThrow('only an ATTACHED receipt can be retired');
    expect(() =>
      retireReceiptOperation(
        tableName,
        attached,
        {
          ...retired('REMOVED'),
          state: 'ATTACHED',
        } as unknown as RetiredReceiptRecord,
        changedAt,
      ),
    ).toThrow('REPLACED or REMOVED');
  });

  it('refuses an invalid TTL through the codec', () => {
    expect(() =>
      retireReceiptOperation(
        tableName,
        attached,
        { ...retired('REMOVED'), expiresAt: 1.5 },
        changedAt,
      ),
    ).toThrow(ItemEncodingError);
  });
});

describe('with claim operations and the transaction composer', () => {
  const at = (minute: number) =>
    new Date(
      Date.parse('2026-10-20T07:00:00.000Z') + minute * 60_000,
    ).toISOString();
  const domainReceipt = (receiptId: string) => ({
    receiptId,
    fileName: secretFileName,
    contentType: 'application/pdf' as const,
    sizeBytes: 52_144,
    checksumSha256: 'a1b2'.repeat(16),
    attachedAt: at(1),
  });
  const draft: Claim = {
    claimId,
    employeeId: 'sub-aisha',
    categoryId: 'travel',
    status: 'DRAFT',
    version: 3,
    createdAt: at(0),
    updatedAt: at(0),
  };
  const history = (action: ClaimHistoryEntry['action']): ClaimHistoryEntry => ({
    claimId,
    version: 4,
    action,
    fromStatus: 'DRAFT',
    toStatus: 'DRAFT',
    actorId: 'sub-aisha',
    occurredAt: changedAt,
  });
  const completed: CompletedRequest = {
    actorId: 'sub-aisha',
    key: 'receipt-key-0001',
    fingerprint: 'ab'.repeat(32),
    response: { status: 200, body: { claimId, version: 4 } },
    createdAt: changedAt,
    expiresAt: Math.floor(Date.parse(changedAt) / 1000) + 86_400,
  };
  const deletion = (receiptId: string, version: number): OutboxEvent => ({
    eventId: `event-delete-${receiptId}`,
    eventType: 'internal.receipt-object-deletion-requested',
    schemaVersion: 1,
    occurredAt: changedAt,
    source: eventSource,
    aggregate: {
      type: 'claim',
      id: claimId,
      version,
      previousEventVersion: null,
    },
    correlationId: 'trace-1',
    causationId: 'request-1',
    actorId: 'sub-aisha',
    payload: { claimId, receiptId, objectKey: `receipts/${receiptId}` },
  });
  const compose = (
    businessItems: TransactionItem[],
    events: OutboxEvent[] = [],
  ) =>
    composeBusinessTransaction({ tableName, businessItems, events, completed });

  it('composes an upload: pending metadata and idempotency', () => {
    expect(
      compose([createPendingReceiptOperation(tableName, pending)])
        .TransactItems,
    ).toHaveLength(2);
  });

  it('composes an attachment with the claim update', () => {
    const composed = compose([
      ...updateClaimOperations(
        tableName,
        {
          claim: {
            ...draft,
            version: 4,
            updatedAt: changedAt,
            receipt: domainReceipt('r-7731'),
          },
          history: history('ATTACH_RECEIPT'),
        },
        3,
        undefined,
      ),
      attachReceiptOperation(tableName, pending, attached, 'sub-aisha'),
    ]);

    expect(composed.TransactItems).toHaveLength(4);
  });

  it('composes a replacement: new receipt attached, old one replaced, cleanup event', () => {
    const newPending: PendingReceiptRecord = {
      ...pending,
      receiptId: 'r-8000',
    };
    const newAttached: AttachedReceiptRecord = {
      ...attached,
      receiptId: 'r-8000',
    };
    const composed = compose(
      [
        ...updateClaimOperations(
          tableName,
          {
            claim: {
              ...draft,
              receipt: domainReceipt('r-8000'),
              version: 4,
              updatedAt: changedAt,
            },
            history: history('REPLACE_RECEIPT'),
          },
          3,
          undefined,
        ),
        attachReceiptOperation(tableName, newPending, newAttached, 'sub-aisha'),
        retireReceiptOperation(
          tableName,
          attached,
          retired('REPLACED'),
          changedAt,
        ),
      ],
      [deletion('r-7731', 4)],
    );

    expect(composed.TransactItems).toHaveLength(6);
  });

  it('composes a removal with its cleanup event', () => {
    const composed = compose(
      [
        ...updateClaimOperations(
          tableName,
          {
            claim: { ...draft, version: 4, updatedAt: changedAt },
            history: history('REMOVE_RECEIPT'),
          },
          3,
          undefined,
        ),
        retireReceiptOperation(
          tableName,
          attached,
          retired('REMOVED'),
          changedAt,
        ),
      ],
      [deletion('r-7731', 4)],
    );

    expect(composed.TransactItems).toHaveLength(5);
  });

  it('composes a draft deletion with its counter, receipt, and both cleanup events', () => {
    const withReceipt: Claim = { ...draft, receipt: domainReceipt('r-7731') };
    const purge: OutboxEvent = {
      eventId: 'event-purge-1',
      eventType: 'internal.claim-history-purge-requested',
      schemaVersion: 1,
      occurredAt: changedAt,
      source: eventSource,
      aggregate: {
        type: 'claim',
        id: claimId,
        version: 4,
        previousEventVersion: null,
      },
      correlationId: 'trace-1',
      causationId: 'request-1',
      actorId: 'sub-aisha',
      payload: { claimId },
    };
    const composed = compose(
      [
        deleteDraftOperation(tableName, withReceipt, 'sub-aisha', 3),
        decrementClaimCountOperation(tableName, 'travel'),
        retireReceiptOperation(
          tableName,
          attached,
          retired('REMOVED'),
          changedAt,
        ),
      ],
      [purge, deletion('r-7731', 4)],
    );

    // At most 6 operations, as section 8 requires.
    expect(composed.TransactItems).toHaveLength(6);
  });
});

describe('safety', () => {
  it('never puts the file name into keys, conditions, or errors', () => {
    const operations = [
      createPendingReceiptOperation(tableName, pending),
      attachReceiptOperation(tableName, pending, attached, 'sub-aisha'),
      retireReceiptOperation(
        tableName,
        attached,
        retired('REMOVED'),
        changedAt,
      ),
    ];
    for (const operation of operations) {
      const parameters = Object.values(operation)[0] as {
        Key?: unknown;
        Item?: DynamoItem;
        ConditionExpression?: string;
      };
      const exposed = JSON.stringify([
        parameters.Key ?? { PK: parameters.Item?.PK, SK: parameters.Item?.SK },
        parameters.ConditionExpression,
      ]);
      expect(exposed).not.toContain('Payslip');
    }

    const errors = [
      errorOf(() =>
        attachReceiptOperation(
          tableName,
          pending,
          { ...attached, fileName: 'Other payslip.pdf' },
          'sub-aisha',
        ),
      ),
      errorOf(() =>
        retireReceiptOperation(
          tableName,
          attached,
          { ...retired('REMOVED'), fileName: `/${secretFileName}` },
          changedAt,
        ),
      ),
    ];
    for (const error of errors) {
      expect(error).toBeDefined();
      expect(String(error)).not.toContain('Payslip');
      expect(String(error)).not.toContain('payslip');
    }
  });

  it('refuses a missing table name', () => {
    expect(() => createPendingReceiptOperation('', pending)).toThrow(
      'table name',
    );
  });

  it('sends no DynamoDB command', () => {
    const send = vi.spyOn(DynamoDBDocumentClient.prototype, 'send');

    createPendingReceiptOperation(tableName, pending);
    attachReceiptOperation(tableName, pending, attached, 'sub-aisha');
    retireReceiptOperation(tableName, attached, retired('REPLACED'), changedAt);

    expect(send).not.toHaveBeenCalled();
  });

  it('has no AWS client, so it cannot send a DynamoDB or S3 command', async () => {
    const source = await readFile(
      new URL(
        '../src/adapters/aws/dynamodb-receipt-operations.ts',
        import.meta.url,
      ),
      'utf8',
    );

    expect(source).not.toMatch(/from '@aws-sdk\//);
    expect(source).not.toMatch(/\.send\(|S3Client|client-s3/);
  });
});
