import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  expiresAfter,
  toEpochSeconds,
  type CategoryGuard,
  type CommitOptions,
  type CompletedRequest,
  type EpochSeconds,
} from '../src/application/commit.js';
import {
  eventCatalog,
  eventSource,
  outboxEventTypes,
  type EventPayloads,
  type OutboxEvent,
  type OutboxEventEnvelope,
  type OutboxEventType,
} from '../src/application/events.js';

const day = 24 * 60 * 60 * 1000;
const claimId = '4ce0c74b-9c64-46d6-87ba-07fb71b0628c';
const at = '2026-10-14T10:41:00.000Z';

const claimPayload = {
  claimId,
  employeeId: 'sub-aisha',
  assignedManagerId: 'sub-ben',
  categoryId: 'travel',
  amount: { amountMinor: 45_000, currency: 'MYR' },
};

function envelope<T extends OutboxEventType>(
  eventType: T,
  aggregate: OutboxEventEnvelope<T>['aggregate'],
  payload: EventPayloads[T],
): OutboxEventEnvelope<T> {
  return {
    eventId: `event-${eventType}`,
    eventType,
    schemaVersion: 1,
    occurredAt: at,
    source: eventSource,
    aggregate,
    correlationId: 'c0ffee00-1111-2222-3333-444455556666',
    causationId: 'request-7d3e',
    actorId: 'sub-aisha',
    payload,
  };
}

const claimAggregate = (version: number, previous: number | null) => ({
  type: 'claim' as const,
  id: claimId,
  version,
  previousEventVersion: previous,
});
const categoryAggregate = (version: number, previous: number | null) => ({
  type: 'category' as const,
  id: 'travel',
  version,
  previousEventVersion: previous,
});

/** One event of every approved type. */
const fixtures: readonly OutboxEvent[] = [
  envelope('claim.submitted', claimAggregate(4, null), {
    ...claimPayload,
    submittedAt: at,
  }),
  envelope('claim.review-started', claimAggregate(5, 4), claimPayload),
  envelope('claim.approved', claimAggregate(6, 5), {
    ...claimPayload,
    reviewedAt: at,
  }),
  envelope('claim.rejected', claimAggregate(6, 5), {
    ...claimPayload,
    reviewedAt: at,
  }),
  envelope('claim.reopened', claimAggregate(7, 6), claimPayload),
  envelope('claim.paid', claimAggregate(7, 6), {
    ...claimPayload,
    paidBy: 'sub-dan',
    paidAt: at,
  }),
  envelope('category.created', categoryAggregate(1, null), {
    categoryId: 'travel',
    version: 1,
    active: true,
    currency: 'MYR',
    maxAmountMinor: 200_000,
    receiptRequiredAboveMinor: 20_000,
  }),
  envelope('category.policy-changed', categoryAggregate(2, 1), {
    categoryId: 'travel',
    version: 2,
    maxAmountMinor: 250_000,
  }),
  envelope('category.deactivated', categoryAggregate(3, 2), {
    categoryId: 'travel',
    version: 3,
  }),
  envelope('category.activated', categoryAggregate(4, 3), {
    categoryId: 'travel',
    version: 4,
  }),
  envelope('category.deleted', categoryAggregate(5, 4), {
    categoryId: 'travel',
    version: 5,
  }),
  envelope(
    'internal.receipt-object-deletion-requested',
    { type: 'claim', id: claimId, version: 6, previousEventVersion: null },
    { claimId, receiptId: 'r-7731', objectKey: 'receipts/r-7731' },
  ),
  envelope(
    'internal.claim-history-purge-requested',
    { type: 'claim', id: claimId, version: 2, previousEventVersion: null },
    { claimId },
  ),
];

describe('TTL values', () => {
  it('are whole Unix epoch seconds, rounded down', () => {
    expect(toEpochSeconds(new Date('2026-10-14T10:41:00.999Z'))).toBe(
      1_791_974_460,
    );
    expect(toEpochSeconds(new Date(0))).toBe(0);
  });

  it('count from the given time', () => {
    const now = new Date('2026-10-14T10:41:00.000Z');
    const expiresAt = expiresAfter(now, day);

    expect(expiresAt).toBe(toEpochSeconds(now) + 86_400);
    expect(Number.isInteger(expiresAt)).toBe(true);
  });

  it('reject invalid dates', () => {
    expect(() => toEpochSeconds(new Date('not a date'))).toThrow(RangeError);
  });

  it('are numbers in the type system, never ISO strings', () => {
    expectTypeOf<EpochSeconds>().toEqualTypeOf<number>();
    expectTypeOf<CompletedRequest['expiresAt']>().toEqualTypeOf<number>();
  });
});

describe('commit envelope', () => {
  const now = new Date(at);
  const completed: CompletedRequest = {
    actorId: 'sub-aisha',
    key: '5b0d6a8e-retry-key',
    fingerprint: 'a'.repeat(64),
    response: { status: 200, body: { claimId, version: 4 } },
    createdAt: now.toISOString(),
    expiresAt: expiresAfter(now, day),
  };
  const guard: CategoryGuard = {
    categoryId: 'travel',
    readVersion: 3,
    mustBeActive: true,
  };

  it('carries every completed-request field with a numeric TTL', () => {
    expect(completed).toEqual({
      actorId: 'sub-aisha',
      key: '5b0d6a8e-retry-key',
      fingerprint: 'a'.repeat(64),
      response: { status: 200, body: { claimId, version: 4 } },
      createdAt: '2026-10-14T10:41:00.000Z',
      expiresAt: 1_792_060_860,
    });
    expect(typeof completed.expiresAt).toBe('number');
  });

  it('has exactly the approved fields', () => {
    expectTypeOf<keyof CompletedRequest>().toEqualTypeOf<
      'actorId' | 'key' | 'fingerprint' | 'response' | 'createdAt' | 'expiresAt'
    >();
    expectTypeOf<keyof CategoryGuard>().toEqualTypeOf<
      'categoryId' | 'readVersion' | 'mustBeActive'
    >();
    expectTypeOf<keyof CommitOptions>().toEqualTypeOf<
      'events' | 'idempotency' | 'categoryGuard'
    >();
  });

  it('combines events with an optional completed request and category guard', () => {
    const full: CommitOptions = {
      events: [fixtures[0]!],
      idempotency: completed,
      categoryGuard: guard,
    };
    const minimal: CommitOptions = { events: [] };

    expect(full.events[0]?.eventType).toBe('claim.submitted');
    expect(full.categoryGuard).toEqual({
      categoryId: 'travel',
      readVersion: 3,
      mustBeActive: true,
    });
    expect(minimal).not.toHaveProperty('idempotency');
    expect(minimal).not.toHaveProperty('categoryGuard');
  });
});

describe('outbox events', () => {
  it('cover exactly the approved event types', () => {
    expect([...outboxEventTypes].sort()).toEqual(
      [
        'claim.submitted',
        'claim.review-started',
        'claim.approved',
        'claim.rejected',
        'claim.reopened',
        'claim.paid',
        'category.created',
        'category.policy-changed',
        'category.deactivated',
        'category.activated',
        'category.deleted',
        'internal.receipt-object-deletion-requested',
        'internal.claim-history-purge-requested',
      ].sort(),
    );
    expect(fixtures.map((e) => e.eventType).sort()).toEqual(
      [...outboxEventTypes].sort(),
    );
  });

  it('route claim and category events as publishable and cleanup events as internal', () => {
    for (const type of outboxEventTypes) {
      const { kind, aggregateType } = eventCatalog[type];
      expect(kind).toBe(
        type.startsWith('internal.') ? 'internal' : 'publishable',
      );
      expect(aggregateType).toBe(
        type.startsWith('category.') ? 'category' : 'claim',
      );
    }
  });

  it('carry the envelope fields and matching aggregate metadata', () => {
    for (const event of fixtures) {
      expect(Object.keys(event).sort()).toEqual(
        [
          'eventId',
          'eventType',
          'schemaVersion',
          'occurredAt',
          'source',
          'aggregate',
          'correlationId',
          'causationId',
          'actorId',
          'payload',
        ].sort(),
      );
      expect(event.schemaVersion).toBe(1);
      expect(event.source).toBe('claimflow.api');
      expect(Object.keys(event.aggregate).sort()).toEqual([
        'id',
        'previousEventVersion',
        'type',
        'version',
      ]);
      expect(event.aggregate.type).toBe(
        eventCatalog[event.eventType].aggregateType,
      );
      if (eventCatalog[event.eventType].kind === 'internal') {
        expect(event.aggregate.previousEventVersion).toBeNull();
      }
    }
  });

  it('type previousEventVersion as a number or null, and null for internal events', () => {
    expectTypeOf<
      OutboxEventEnvelope<'claim.submitted'>['aggregate']['previousEventVersion']
    >().toEqualTypeOf<number | null>();
    expectTypeOf<
      OutboxEventEnvelope<'category.deleted'>['aggregate']['previousEventVersion']
    >().toEqualTypeOf<number | null>();
    expectTypeOf<
      OutboxEventEnvelope<'internal.claim-history-purge-requested'>['aggregate']['previousEventVersion']
    >().toEqualTypeOf<null>();
    expectTypeOf<
      OutboxEventEnvelope<'category.created'>['aggregate']['type']
    >().toEqualTypeOf<'category'>();
    expectTypeOf<
      OutboxEventEnvelope<'internal.receipt-object-deletion-requested'>['aggregate']['type']
    >().toEqualTypeOf<'claim'>();
  });
});

describe('free text', () => {
  /** Fields that hold user-entered free text or personal data. */
  type FreeTextField =
    | 'merchant'
    | 'businessPurpose'
    | 'comment'
    | 'decisionComment'
    | 'description'
    | 'notes'
    | 'name'
    | 'displayName'
    | 'title'
    | 'email'
    | 'fileName';
  const freeTextFields: readonly FreeTextField[] = [
    'merchant',
    'businessPurpose',
    'comment',
    'decisionComment',
    'description',
    'notes',
    'name',
    'displayName',
    'title',
    'email',
    'fileName',
  ];

  type PayloadKey = {
    [T in OutboxEventType]: keyof EventPayloads[T];
  }[OutboxEventType];

  it('is not part of any event payload type', () => {
    expectTypeOf<Extract<PayloadKey, FreeTextField>>().toBeNever();
  });

  it('appears nowhere in the event fixtures', () => {
    const keys = new Set<string>();
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(collect);
      } else if (typeof value === 'object' && value !== null) {
        for (const [key, inner] of Object.entries(value)) {
          keys.add(key);
          collect(inner);
        }
      }
    };
    collect(fixtures);

    for (const field of freeTextFields) {
      expect(keys).not.toContain(field);
    }
  });
});
