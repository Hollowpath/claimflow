import { describe, expect, it } from 'vitest';

import {
  invalidKeyIdentifier,
  ItemEncodingError,
  ItemIntegrityError,
  type DynamoItem,
} from '../src/adapters/aws/dynamodb-items.js';
import {
  decodeOutboxItem,
  encodeOutboxItem,
  outboxKey,
  pendingState,
  publishedState,
  type OutboxState,
} from '../src/adapters/aws/dynamodb-outbox-items.js';
import { toEpochSeconds } from '../src/application/commit.js';
import {
  eventCatalog,
  eventSource,
  outboxEventTypes,
  type EventPayloads,
  type OutboxEvent,
  type OutboxEventEnvelope,
  type OutboxEventType,
} from '../src/application/events.js';

const claimId = '4ce0c74b-9c64-46d6-87ba-07fb71b0628c';
const at = '2026-10-14T10:41:00.000Z';

const claimPayload = {
  claimId,
  employeeId: 'sub-aisha',
  assignedManagerId: 'sub-ben',
  categoryId: 'travel',
  amount: { amountMinor: 45_000, currency: 'MYR' },
};

function event<T extends OutboxEventType>(
  eventType: T,
  aggregate: OutboxEventEnvelope<T>['aggregate'],
  payload: EventPayloads[T],
  eventId = `event-${eventType.replace(/[^a-z]/g, '')}`,
): OutboxEventEnvelope<T> {
  return {
    eventId,
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

const onClaim = (version: number, previous: number | null) => ({
  type: 'claim' as const,
  id: claimId,
  version,
  previousEventVersion: previous,
});
const onCategory = (version: number, previous: number | null) => ({
  type: 'category' as const,
  id: 'travel',
  version,
  previousEventVersion: previous,
});

/** The approved example events (section 7). */
const submitted = event(
  'claim.submitted',
  onClaim(4, null),
  { ...claimPayload, submittedAt: at },
  '8f3d2c1e-5a7b-4c1d-9e2f-0a1b2c3d4e5f',
);
const receiptDeletion = {
  ...event(
    'internal.receipt-object-deletion-requested',
    { type: 'claim', id: claimId, version: 6, previousEventVersion: null },
    { claimId, receiptId: 'r-7731', objectKey: 'receipts/r-7731' },
    '1c9e7b2a-3d4f-4e5a-8b6c-7d8e9f0a1b2c',
  ),
  occurredAt: '2026-10-14T11:05:00.000Z',
  correlationId: 'c0ffee00-1111-2222-3333-444455556667',
  causationId: 'request-8a41',
};

/** One event of every approved type. */
const events: readonly OutboxEvent[] = [
  submitted,
  event('claim.review-started', onClaim(5, 4), claimPayload),
  event('claim.approved', onClaim(6, 5), { ...claimPayload, reviewedAt: at }),
  event('claim.rejected', onClaim(6, 5), { ...claimPayload, reviewedAt: at }),
  event('claim.reopened', onClaim(7, 6), claimPayload),
  event('claim.paid', onClaim(7, 6), {
    ...claimPayload,
    paidBy: 'sub-dan',
    paidAt: at,
  }),
  event('category.created', onCategory(1, null), {
    categoryId: 'travel',
    version: 1,
    active: true,
    currency: 'MYR',
    maxAmountMinor: 200_000,
    receiptRequiredAboveMinor: 0,
  }),
  event('category.policy-changed', onCategory(2, 1), {
    categoryId: 'travel',
    version: 2,
    maxAmountMinor: 250_000,
  }),
  event('category.deactivated', onCategory(3, 2), {
    categoryId: 'travel',
    version: 3,
  }),
  event('category.activated', onCategory(4, 3), {
    categoryId: 'travel',
    version: 4,
  }),
  event('category.deleted', onCategory(5, 4), {
    categoryId: 'travel',
    version: 5,
  }),
  receiptDeletion,
  event(
    'internal.claim-history-purge-requested',
    { type: 'claim', id: claimId, version: 2, previousEventVersion: null },
    { claimId },
  ),
];

const published = publishedState('2026-10-14T12:00:00.000Z');

function errorOf(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('outbox items', () => {
  it('encode the approved claim event item exactly', () => {
    expect(encodeOutboxItem(submitted)).toEqual({
      PK: `CLAIM#${claimId}`,
      SK: 'OUTBOX#2026-10-14T10:41:00.000Z#8f3d2c1e-5a7b-4c1d-9e2f-0a1b2c3d4e5f',
      entityType: 'OutboxEvent',
      eventId: '8f3d2c1e-5a7b-4c1d-9e2f-0a1b2c3d4e5f',
      eventType: 'claim.submitted',
      schemaVersion: 1,
      occurredAt: at,
      source: 'claimflow.api',
      aggregate: {
        type: 'claim',
        id: claimId,
        version: 4,
        previousEventVersion: null,
      },
      correlationId: 'c0ffee00-1111-2222-3333-444455556666',
      causationId: 'request-7d3e',
      actorId: 'sub-aisha',
      payload: {
        claimId,
        employeeId: 'sub-aisha',
        assignedManagerId: 'sub-ben',
        categoryId: 'travel',
        amount: { amountMinor: 45_000, currency: 'MYR' },
        submittedAt: at,
      },
      state: 'PENDING',
      GSI4PK: 'OUTBOX#PENDING',
      GSI4SK: `${at}#8f3d2c1e-5a7b-4c1d-9e2f-0a1b2c3d4e5f`,
    });
  });

  it('encode the approved cleanup event item exactly', () => {
    expect(encodeOutboxItem(receiptDeletion)).toEqual({
      PK: `CLAIM#${claimId}`,
      SK: 'OUTBOX#2026-10-14T11:05:00.000Z#1c9e7b2a-3d4f-4e5a-8b6c-7d8e9f0a1b2c',
      entityType: 'OutboxEvent',
      eventId: '1c9e7b2a-3d4f-4e5a-8b6c-7d8e9f0a1b2c',
      eventType: 'internal.receipt-object-deletion-requested',
      schemaVersion: 1,
      occurredAt: '2026-10-14T11:05:00.000Z',
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
      state: 'PENDING',
      GSI4PK: 'OUTBOX#PENDING',
      GSI4SK: '2026-10-14T11:05:00.000Z#1c9e7b2a-3d4f-4e5a-8b6c-7d8e9f0a1b2c',
    });
  });

  it('cover every approved event type', () => {
    expect(events.map((e) => e.eventType).sort()).toEqual(
      [...outboxEventTypes].sort(),
    );
  });

  it.each(events.map((e) => [e.eventType, e] as const))(
    'route %s to its aggregate partition',
    (eventType, outboxEvent) => {
      const key = outboxKey(outboxEvent);

      expect(key.PK).toBe(
        eventCatalog[eventType].aggregateType === 'category'
          ? 'CATEGORIES'
          : `CLAIM#${claimId}`,
      );
      expect(key.SK).toBe(
        `OUTBOX#${outboxEvent.occurredAt}#${outboxEvent.eventId}`,
      );
    },
  );

  it.each(events.map((e) => [e.eventType, e] as const))(
    'round-trip %s while pending and once published',
    (_type, outboxEvent) => {
      for (const state of [pendingState, published]) {
        const item = encodeOutboxItem(outboxEvent, state);

        expect(Object.values(item)).not.toContain(undefined);
        expect(decodeOutboxItem(item)).toEqual({ event: outboxEvent, state });
      }
    },
  );

  it('keep pending events in GSI4 without publication data', () => {
    const item = encodeOutboxItem(submitted, pendingState);

    expect(item.state).toBe('PENDING');
    expect(item.GSI4PK).toBe('OUTBOX#PENDING');
    expect(item.GSI4SK).toBe(`${at}#${submitted.eventId}`);
    expect(item).not.toHaveProperty('publishedAt');
    expect(item).not.toHaveProperty('expiresAt');
    for (const name of ['GSI1PK', 'GSI2PK', 'GSI3PK']) {
      expect(item).not.toHaveProperty(name);
    }
  });

  it('remove published events from every index and expire them after 7 days', () => {
    const item = encodeOutboxItem(submitted, published);

    expect(item.state).toBe('PUBLISHED');
    expect(item.publishedAt).toBe('2026-10-14T12:00:00.000Z');
    expect(item.expiresAt).toBe(
      toEpochSeconds(new Date('2026-10-14T12:00:00.000Z')) + 7 * 86_400,
    );
    expect(Number.isInteger(item.expiresAt)).toBe(true);
    expect(Object.keys(item).filter((k) => k.startsWith('GSI'))).toEqual([]);
  });

  it.each<[string, OutboxState]>([
    [
      'a TTL other than 7 days',
      {
        ...published,
        expiresAt: (published as { expiresAt: number }).expiresAt - 86_400,
      } as OutboxState,
    ],
    [
      'publication before the event occurred',
      publishedState('2026-10-14T10:00:00.000Z'),
    ],
    [
      'a non-canonical publication time',
      { state: 'PUBLISHED', publishedAt: '2026-10-14T10:45:00Z', expiresAt: 1 },
    ],
  ])('refuse to encode %s', (_name, state) => {
    expect(() => encodeOutboxItem(submitted, state)).toThrow(ItemEncodingError);
  });

  it('refuse to encode an event with free text in its payload', () => {
    const withMerchant = {
      ...submitted,
      payload: { ...submitted.payload, merchant: 'Regional Airline' },
    } as OutboxEvent;

    expect(() => encodeOutboxItem(withMerchant)).toThrow(ItemEncodingError);
  });

  const valid = () => encodeOutboxItem(submitted);
  const withAggregate = (changes: DynamoItem) => ({
    aggregate: { ...(valid().aggregate as DynamoItem), ...changes },
  });
  const withPayload = (changes: DynamoItem) => ({
    payload: { ...(valid().payload as DynamoItem), ...changes },
  });

  it.each<[string, DynamoItem, string]>([
    ['a category partition for a claim event', { PK: 'CATEGORIES' }, 'key'],
    [
      'a sort key for another time',
      { SK: `OUTBOX#2026-10-14T10:40:00.000Z#${submitted.eventId}` },
      'key',
    ],
    ['a wrong entity type', { entityType: 'Claim' }, 'entityType'],
    ['an unknown event type', { eventType: 'claim.archived' }, 'eventType'],
    ['schema version 2', { schemaVersion: 2 }, 'schemaVersion'],
    ['another source', { source: 'claimflow.web' }, 'source'],
    ['an event ID with a separator', { eventId: 'a#b' }, 'eventId'],
    [
      'a non-canonical occurrence time',
      { occurredAt: '2026-10-14T10:41:00Z' },
      'occurredAt',
    ],
    [
      'an invalid correlation ID',
      { correlationId: 'trace 1' },
      'correlationId',
    ],
    [
      'an overlong causation ID',
      { causationId: 'c'.repeat(129) },
      'causationId',
    ],
    ['a missing actor', { actorId: undefined }, 'actorId'],
    ['an aggregate that is not a map', { aggregate: 'claim' }, 'aggregate'],
    [
      'an aggregate of the wrong type',
      withAggregate({ type: 'category' }),
      'aggregate.type',
    ],
    [
      'an extra aggregate field',
      withAggregate({ name: 'x' }),
      'aggregate has an unexpected field',
    ],
    [
      'an aggregate version of zero',
      withAggregate({ version: 0 }),
      'aggregate.version',
    ],
    [
      'a missing previous event version',
      withAggregate({ previousEventVersion: undefined }),
      'previousEventVersion',
    ],
    [
      'a previous event version not below the version',
      withAggregate({ previousEventVersion: 4 }),
      'previousEventVersion',
    ],
    [
      'a payload for another claim',
      withPayload({ claimId: 'other-claim' }),
      'payload.claimId',
    ],
    [
      'a missing payload field',
      withPayload({ submittedAt: undefined }),
      'payload.submittedAt',
    ],
    [
      'an invalid amount',
      withPayload({ amount: { amountMinor: -1, currency: 'MYR' } }),
      'payload.amount',
    ],
    ['a payload that is not a map', { payload: [] }, 'payload'],
    ['a pending event with publication data', { publishedAt: at }, 'pending'],
    [
      'a pending event without GSI4',
      { GSI4PK: undefined, GSI4SK: undefined },
      'GSI4PK is missing',
    ],
    [
      'a pending event with the wrong GSI4 sort key',
      { GSI4SK: `${at}#other` },
      'GSI4SK',
    ],
    [
      'a pending event in another index',
      { GSI3PK: 'STATUS#SUBMITTED' },
      'GSI3PK must be absent',
    ],
    ['an unknown state', { state: 'FAILED' }, 'state'],
    [
      'an unexpected attribute',
      { lastEventVersion: 4 },
      'unexpected attribute',
    ],
  ])('reject an item with %s', (_name, changes, problem) => {
    const item: DynamoItem = { ...valid(), ...changes };
    for (const [name, value] of Object.entries(changes)) {
      if (value === undefined) {
        delete item[name];
      }
    }
    for (const nestedName of ['aggregate', 'payload']) {
      const nestedValue = item[nestedName];
      if (typeof nestedValue === 'object' && nestedValue !== null) {
        for (const [name, value] of Object.entries(nestedValue)) {
          if (value === undefined) {
            delete (nestedValue as DynamoItem)[name];
          }
        }
      }
    }
    const decode = () => decodeOutboxItem(item);

    expect(decode).toThrow(ItemIntegrityError);
    expect(decode).toThrow(problem);
  });

  it.each<[string, DynamoItem, string]>([
    [
      'index attributes',
      { GSI4PK: 'OUTBOX#PENDING', GSI4SK: `${at}#x` },
      'must not have GSI4PK',
    ],
    ['a TTL other than 7 days', { expiresAt: 1 }, 'expiresAt must be 7 days'],
    [
      'a TTL stored as text',
      {
        expiresAt: String(
          published.state === 'PUBLISHED' ? published.expiresAt : 0,
        ),
      },
      'expiresAt must be 7 days',
    ],
    ['no publication time', { publishedAt: undefined }, 'publishedAt'],
  ])('reject a published item with %s', (_name, changes, problem) => {
    const item: DynamoItem = {
      ...encodeOutboxItem(submitted, published),
      ...changes,
    };
    for (const [name, value] of Object.entries(changes)) {
      if (value === undefined) {
        delete item[name];
      }
    }

    expect(() => decodeOutboxItem(item)).toThrow(problem);
  });

  it('require null previous event versions on internal events', () => {
    const item = encodeOutboxItem(receiptDeletion);

    expect(() =>
      decodeOutboxItem({
        ...item,
        aggregate: {
          ...(item.aggregate as DynamoItem),
          previousEventVersion: 5,
        },
      }),
    ).toThrow('must be null for this event');
  });

  it('match category payloads to the aggregate', () => {
    const created = events.find((e) => e.eventType === 'category.created')!;
    const item = encodeOutboxItem(created);
    const payload = item.payload as DynamoItem;

    for (const changes of [{ categoryId: 'meals' }, { version: 2 }]) {
      expect(() =>
        decodeOutboxItem({ ...item, payload: { ...payload, ...changes } }),
      ).toThrow(ItemIntegrityError);
    }
    expect(() => decodeOutboxItem({ ...item, PK: `CLAIM#${claimId}` })).toThrow(
      'key',
    );
  });

  it('require at least one valid field in a policy change', () => {
    const changed = events.find(
      (e) => e.eventType === 'category.policy-changed',
    )!;
    const item = encodeOutboxItem(changed);

    expect(() =>
      decodeOutboxItem({
        ...item,
        payload: { categoryId: 'travel', version: 2 },
      }),
    ).toThrow('at least one changed policy field');
    expect(() =>
      decodeOutboxItem({
        ...item,
        payload: { categoryId: 'travel', version: 2, currency: 'myr' },
      }),
    ).toThrow('payload.currency');
  });

  it('require the cleanup object key to be the receipt object', () => {
    const item = encodeOutboxItem(receiptDeletion);

    expect(() =>
      decodeOutboxItem({
        ...item,
        payload: {
          claimId,
          receiptId: 'r-7731',
          objectKey: 'uploads/pending/x',
        },
      }),
    ).toThrow('payload.objectKey');
  });
});

describe('free text', () => {
  const prohibited = [
    'merchant',
    'businessPurpose',
    'comment',
    'fileName',
    'displayName',
    'title',
    'description',
    'notes',
    'name',
  ];
  const secret = 'Dinner with Aisha at Hotel Rahman';

  it('appears in no encoded outbox item', () => {
    const keys = new Set<string>();
    const collect = (value: unknown): void => {
      if (typeof value === 'object' && value !== null) {
        for (const [key, inner] of Object.entries(value)) {
          keys.add(key);
          collect(inner);
        }
      }
    };
    for (const outboxEvent of events) {
      collect(encodeOutboxItem(outboxEvent));
      collect(encodeOutboxItem(outboxEvent, published));
    }

    for (const field of prohibited) {
      expect(keys).not.toContain(field);
    }
  });

  it.each(prohibited)(
    'is rejected as a %s payload field without echoing its value',
    (field) => {
      const item = encodeOutboxItem(submitted);
      const error = errorOf(() =>
        decodeOutboxItem({
          ...item,
          payload: { ...(item.payload as DynamoItem), [field]: secret },
        }),
      );

      expect(error).toBeInstanceOf(ItemIntegrityError);
      expect(String(error)).toContain('payload has an unexpected field');
      expect(String(error)).not.toContain(secret);
    },
  );

  it('and malformed keys are never echoed', () => {
    const item = encodeOutboxItem(submitted);
    const errors = [
      errorOf(() => decodeOutboxItem({ ...item, PK: `CLAIM#${secret}` })),
      errorOf(() =>
        decodeOutboxItem({ ...item, SK: `OUTBOX#${at}#${secret}` }),
      ),
    ];

    for (const error of errors) {
      expect(error).toBeInstanceOf(ItemIntegrityError);
      expect(String(error)).toContain(invalidKeyIdentifier);
      expect(String(error)).not.toContain('Aisha');
    }
  });
});
