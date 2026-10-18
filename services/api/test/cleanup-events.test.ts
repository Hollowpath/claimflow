import { describe, expect, it } from 'vitest';

import { ItemEncodingError } from '../src/adapters/aws/dynamodb-items.js';
import {
  decodeOutboxItem,
  encodeOutboxItem,
} from '../src/adapters/aws/dynamodb-outbox-items.js';
import { receiptObjectKey } from '../src/adapters/aws/dynamodb-receipt-items.js';
import {
  composeBusinessTransaction,
  type TransactionItem,
} from '../src/adapters/aws/dynamodb-transaction.js';
import {
  buildHistoryPurgeEvent,
  buildReceiptDeletionEvent,
  CleanupEventError,
  type CleanupEventContext,
  type HistoryPurgeRequest,
  type ReceiptDeletionRequest,
} from '../src/application/cleanup-events.js';
import type { CompletedRequest } from '../src/application/commit.js';

const claimId = '4ce0c74b-9c64-46d6-87ba-07fb71b0628c';
const at = '2026-10-14T11:05:00.000Z';

const context: CleanupEventContext = {
  eventId: '1c9e7b2a-3d4f-4e5a-8b6c-7d8e9f0a1b2c',
  correlationId: 'c0ffee00-1111-2222-3333-444455556667',
  causationId: 'request-8a41',
  actorId: 'sub-aisha',
  occurredAt: at,
  claimVersion: 6,
};

const deletion: ReceiptDeletionRequest = {
  ...context,
  claimId,
  receiptId: 'r-7731',
  objectKey: 'receipts/r-7731',
};
const purge: HistoryPurgeRequest = { ...context, claimId };

function errorOf(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('receipt deletion event', () => {
  it('builds the approved envelope exactly', () => {
    expect(buildReceiptDeletionEvent(deletion)).toEqual({
      eventId: '1c9e7b2a-3d4f-4e5a-8b6c-7d8e9f0a1b2c',
      eventType: 'internal.receipt-object-deletion-requested',
      schemaVersion: 1,
      occurredAt: at,
      source: 'claimflow.api',
      aggregate: {
        type: 'claim',
        id: claimId,
        version: 6,
        previousEventVersion: null,
      },
      correlationId: 'c0ffee00-1111-2222-3333-444455556667',
      causationId: 'request-8a41',
      actorId: 'sub-aisha',
      payload: { claimId, receiptId: 'r-7731', objectKey: 'receipts/r-7731' },
    });
  });

  it('carries only the claim, receipt, and object key, using the receipt key helper', () => {
    const event = buildReceiptDeletionEvent(deletion);

    expect(Object.keys(event.payload).sort()).toEqual([
      'claimId',
      'objectKey',
      'receiptId',
    ]);
    expect(event.payload.objectKey).toBe(receiptObjectKey('r-7731'));
  });

  it('copies the request rather than aliasing it', () => {
    const request = { ...deletion };
    const event = buildReceiptDeletionEvent(request);

    expect(event).not.toBe(request);
    expect(Object.keys(event)).not.toContain('claimVersion');
    expect(Object.keys(event)).not.toContain('claimId');
  });

  it.each<[string, Partial<ReceiptDeletionRequest>]>([
    ['an invalid event ID', { eventId: 'a#b' }],
    ['an invalid actor', { actorId: 'sub aisha' }],
    ['an invalid correlation ID', { correlationId: 'not valid!' }],
    ['an overlong causation ID', { causationId: 'c'.repeat(129) }],
    ['a date-only time', { occurredAt: '2026-10-14' }],
    ['a non-canonical time', { occurredAt: '2026-10-14T11:05:00Z' }],
    ['an impossible time', { occurredAt: '2026-02-30T00:00:00.000Z' }],
    ['version zero', { claimVersion: 0 }],
    ['a fractional version', { claimVersion: 1.5 }],
    ['an unsafe version', { claimVersion: Number.MAX_SAFE_INTEGER + 1 }],
    ['an invalid claim ID', { claimId: 'claim #1' }],
    ['an invalid receipt ID', { receiptId: 'r/1', objectKey: 'receipts/r/1' }],
    ['a pending object key', { objectKey: 'uploads/pending/r-7731' }],
    ['another receipt object key', { objectKey: 'receipts/r-0001' }],
    ['a padded object key', { objectKey: 'receipts/r-7731/' }],
  ])('rejects %s', (_name, change) => {
    const build = () => buildReceiptDeletionEvent({ ...deletion, ...change });

    expect(build).toThrow(CleanupEventError);
  });

  it('accepts the version boundaries', () => {
    for (const claimVersion of [1, Number.MAX_SAFE_INTEGER]) {
      expect(
        buildReceiptDeletionEvent({ ...deletion, claimVersion }).aggregate
          .version,
      ).toBe(claimVersion);
    }
  });
});

describe('history purge event', () => {
  it('builds the approved envelope exactly', () => {
    expect(buildHistoryPurgeEvent(purge)).toEqual({
      eventId: '1c9e7b2a-3d4f-4e5a-8b6c-7d8e9f0a1b2c',
      eventType: 'internal.claim-history-purge-requested',
      schemaVersion: 1,
      occurredAt: at,
      source: 'claimflow.api',
      aggregate: {
        type: 'claim',
        id: claimId,
        version: 6,
        previousEventVersion: null,
      },
      correlationId: 'c0ffee00-1111-2222-3333-444455556667',
      causationId: 'request-8a41',
      actorId: 'sub-aisha',
      payload: { claimId },
    });
  });

  it('carries only the claim ID', () => {
    expect(Object.keys(buildHistoryPurgeEvent(purge).payload)).toEqual([
      'claimId',
    ]);
  });

  it.each<[string, Partial<HistoryPurgeRequest>]>([
    ['an invalid claim ID', { claimId: '' }],
    ['an invalid event ID', { eventId: '' }],
    ['a non-canonical time', { occurredAt: 'yesterday' }],
    ['version zero', { claimVersion: 0 }],
    ['a negative version', { claimVersion: -3 }],
  ])('rejects %s', (_name, change) => {
    expect(() => buildHistoryPurgeEvent({ ...purge, ...change })).toThrow(
      CleanupEventError,
    );
  });
});

describe('safe errors', () => {
  it('never echo supplied values', () => {
    const secret = 'Salary review for Aisha Rahman';
    const errors = [
      errorOf(() =>
        buildReceiptDeletionEvent({ ...deletion, claimId: secret }),
      ),
      errorOf(() =>
        buildReceiptDeletionEvent({ ...deletion, receiptId: secret }),
      ),
      errorOf(() =>
        buildReceiptDeletionEvent({ ...deletion, objectKey: secret }),
      ),
      errorOf(() =>
        buildReceiptDeletionEvent({ ...deletion, eventId: secret }),
      ),
      errorOf(() =>
        buildReceiptDeletionEvent({ ...deletion, actorId: secret }),
      ),
      errorOf(() =>
        buildReceiptDeletionEvent({ ...deletion, correlationId: secret }),
      ),
      errorOf(() =>
        buildReceiptDeletionEvent({ ...deletion, causationId: secret }),
      ),
      errorOf(() =>
        buildReceiptDeletionEvent({ ...deletion, occurredAt: secret }),
      ),
      errorOf(() => buildHistoryPurgeEvent({ ...purge, claimId: secret })),
    ];

    for (const error of errors) {
      expect(error).toBeInstanceOf(CleanupEventError);
      const text = (error as Error).message;
      expect(text).not.toContain('Salary');
      expect(text).not.toContain('Aisha');
      expect(text).not.toContain(claimId);
      expect(text).not.toContain('r-7731');
      expect(text).not.toContain('receipts/');
    }
  });
});

describe('with the outbox codec and the transaction composer', () => {
  it('round-trips both events through the outbox codec', () => {
    for (const event of [
      buildReceiptDeletionEvent(deletion),
      buildHistoryPurgeEvent(purge),
    ]) {
      expect(decodeOutboxItem(encodeOutboxItem(event))).toEqual({
        event,
        state: { state: 'PENDING' },
      });
    }
  });

  it('is refused by the codec if a payload would carry anything else', () => {
    const event = buildReceiptDeletionEvent(deletion);
    const tampered = {
      ...event,
      payload: { ...event.payload, fileName: 'Payslip.pdf' },
    } as unknown as typeof event;

    expect(() => encodeOutboxItem(tampered)).toThrow(ItemEncodingError);
  });

  const completed: CompletedRequest = {
    actorId: 'sub-aisha',
    key: 'cleanup-key-0001',
    fingerprint: 'ab'.repeat(32),
    response: { status: 204, body: undefined },
    createdAt: at,
    expiresAt: Math.floor(Date.parse(at) / 1000) + 86_400,
  };
  const claimDelete: TransactionItem = {
    Delete: {
      TableName: 'ClaimFlow',
      Key: { PK: `CLAIM#${claimId}`, SK: 'CLAIM' },
    },
  };

  it('composes a draft deletion with both cleanup events as separate outbox items', () => {
    const composed = composeBusinessTransaction({
      tableName: 'ClaimFlow',
      businessItems: [claimDelete],
      events: [
        buildHistoryPurgeEvent(purge),
        buildReceiptDeletionEvent({
          ...deletion,
          eventId: '2d0f8c3b-4e5f-4f6b-9c7d-8e9f0a1b2c3d',
        }),
      ],
      completed,
    });

    expect(composed.TransactItems).toHaveLength(4);
    expect(
      composed
        .TransactItems!.slice(1, 3)
        .map((item) => item.Put!.Item!.eventType),
    ).toEqual([
      'internal.claim-history-purge-requested',
      'internal.receipt-object-deletion-requested',
    ]);
    expect(composed.TransactItems![1]!.Put!.Item!.PK).toBe(`CLAIM#${claimId}`);
  });

  it('refuses two events with the same ID', () => {
    expect(() =>
      composeBusinessTransaction({
        tableName: 'ClaimFlow',
        businessItems: [claimDelete],
        events: [
          buildHistoryPurgeEvent(purge),
          buildReceiptDeletionEvent(deletion),
        ],
        completed,
      }),
    ).toThrow('touches the same item');
  });
});
