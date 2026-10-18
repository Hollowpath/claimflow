import type { Category } from '@claimflow/domain';
import { describe, expect, it } from 'vitest';

import {
  createCategoryOperation,
  deleteCategoryOperation,
  updateCategoryOperation,
} from '../src/adapters/aws/dynamodb-category-operations.js';
import { ItemEncodingError } from '../src/adapters/aws/dynamodb-items.js';
import {
  decodeOutboxItem,
  encodeOutboxItem,
} from '../src/adapters/aws/dynamodb-outbox-items.js';
import { composeBusinessTransaction } from '../src/adapters/aws/dynamodb-transaction.js';
import {
  buildCategoryCreatedEvent,
  buildCategoryDeletedEvent,
  buildCategoryUpdateEvents,
  CategoryEventError,
  type CategoryEventContext,
} from '../src/application/category-events.js';
import type { CompletedRequest } from '../src/application/commit.js';

const at = '2026-09-30T08:00:00.000Z';
const secretName = 'Executive Retreat Budget';

const base: Category = {
  categoryId: 'travel',
  name: secretName,
  active: true,
  currency: 'MYR',
  maxAmountMinor: 200_000,
  receiptRequiredAboveMinor: 20_000,
  version: 3,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  updatedBy: 'sub-dan',
};

const context: CategoryEventContext = {
  correlationId: 'c0ffee00-1111-2222-3333-444455556666',
  causationId: 'request-9b12',
  actorId: 'sub-dan',
  occurredAt: at,
  storedLastEventVersion: 2,
};
const updateIds = {
  ...context,
  policyEventId: 'event-policy-0001',
  activationEventId: 'event-activation-0001',
};

const next = (change: Partial<Category>): Category => ({
  ...base,
  version: 4,
  updatedAt: at,
  ...change,
});

const envelope = (
  eventType: string,
  payload: object,
  version = 4,
  previous: number | null = 2,
) => ({
  schemaVersion: 1,
  eventType,
  occurredAt: at,
  source: 'claimflow.api',
  aggregate: {
    type: 'category',
    id: 'travel',
    version,
    previousEventVersion: previous,
  },
  correlationId: context.correlationId,
  causationId: context.causationId,
  actorId: 'sub-dan',
  payload,
});

function errorOf(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('created', () => {
  const created: Category = { ...base, version: 1, updatedAt: base.createdAt };

  it('builds the exact event with all policy fields and the active state', () => {
    expect(
      buildCategoryCreatedEvent(created, {
        ...context,
        eventId: 'event-created-0001',
        storedLastEventVersion: undefined,
      }),
    ).toEqual({
      eventId: 'event-created-0001',
      ...envelope(
        'category.created',
        {
          categoryId: 'travel',
          version: 1,
          active: true,
          currency: 'MYR',
          maxAmountMinor: 200_000,
          receiptRequiredAboveMinor: 20_000,
        },
        1,
        null,
      ),
    });
  });

  it('reports an inactive category as inactive', () => {
    const event = buildCategoryCreatedEvent(
      { ...created, active: false },
      {
        ...context,
        eventId: 'event-created-0001',
        storedLastEventVersion: undefined,
      },
    );

    expect(event.payload.active).toBe(false);
  });

  it.each([0, 2, 1.5])('refuses a new category at version %s', (version) => {
    expect(() =>
      buildCategoryCreatedEvent(
        { ...created, version },
        {
          ...context,
          eventId: 'event-created-0001',
          storedLastEventVersion: undefined,
        },
      ),
    ).toThrow('version 1');
  });

  it('never contains the name', () => {
    const event = buildCategoryCreatedEvent(created, {
      ...context,
      eventId: 'event-created-0001',
      storedLastEventVersion: undefined,
    });

    expect(JSON.stringify(event)).not.toContain('Executive');
    expect(Object.keys(event.payload)).not.toContain('name');
  });
});

describe('updated', () => {
  it('produces nothing for a name-only change', () => {
    expect(
      buildCategoryUpdateEvents(
        base,
        next({ name: 'Renamed budget' }),
        updateIds,
      ),
    ).toEqual([]);
  });

  it('produces nothing when only metadata changes', () => {
    expect(
      buildCategoryUpdateEvents(
        base,
        next({ updatedBy: 'sub-erin' }),
        updateIds,
      ),
    ).toEqual([]);
  });

  it.each<[string, Partial<Category>, object]>([
    ['the currency', { currency: 'SGD' }, { currency: 'SGD' }],
    ['the maximum', { maxAmountMinor: 250_000 }, { maxAmountMinor: 250_000 }],
    [
      'the threshold',
      { receiptRequiredAboveMinor: 0 },
      { receiptRequiredAboveMinor: 0 },
    ],
    [
      'two policy fields',
      { maxAmountMinor: 1, receiptRequiredAboveMinor: 5 },
      { maxAmountMinor: 1, receiptRequiredAboveMinor: 5 },
    ],
  ])(
    'builds a policy event with only the changed %s',
    (_name, change, fields) => {
      const events = buildCategoryUpdateEvents(base, next(change), updateIds);

      expect(events).toEqual([
        {
          eventId: 'event-policy-0001',
          ...envelope('category.policy-changed', {
            categoryId: 'travel',
            version: 4,
            ...fields,
          }),
        },
      ]);
    },
  );

  it('ignores a policy field that is set to the same value', () => {
    const [event] = buildCategoryUpdateEvents(
      base,
      next({ currency: 'MYR', maxAmountMinor: 1 }),
      updateIds,
    );

    expect(event!.payload).toEqual({
      categoryId: 'travel',
      version: 4,
      maxAmountMinor: 1,
    });
  });

  it.each([
    [false, 'category.deactivated'],
    [true, 'category.activated'],
  ] as const)('builds %s activation as %s', (active, eventType) => {
    const events = buildCategoryUpdateEvents(
      { ...base, active: !active },
      next({ active }),
      updateIds,
    );

    expect(events).toEqual([
      {
        eventId: 'event-activation-0001',
        ...envelope(eventType, { categoryId: 'travel', version: 4 }),
      },
    ]);
  });

  it('builds both events in a fixed order, at the same version, with distinct IDs', () => {
    const events = buildCategoryUpdateEvents(
      base,
      next({ active: false, maxAmountMinor: 90_000, name: 'Ignored' }),
      updateIds,
    );

    expect(events.map((e) => e.eventType)).toEqual([
      'category.policy-changed',
      'category.deactivated',
    ]);
    expect(events.map((e) => e.eventId)).toEqual([
      'event-policy-0001',
      'event-activation-0001',
    ]);
    expect(events.map((e) => e.aggregate.version)).toEqual([4, 4]);
    expect(events.map((e) => e.aggregate.previousEventVersion)).toEqual([2, 2]);
    expect(JSON.stringify(events)).not.toContain('Ignored');
  });

  it('is deterministic', () => {
    const change = next({ active: false, currency: 'USD' });

    expect(buildCategoryUpdateEvents(base, change, updateIds)).toEqual(
      buildCategoryUpdateEvents(base, change, updateIds),
    );
  });

  it.each<[string, Category, string]>([
    ['another category', next({ categoryId: 'meals' }), 'different'],
    ['the same version', { ...base }, 'exactly one'],
    ['a skipped version', next({ version: 5 }), 'exactly one'],
    ['an older version', next({ version: 2 }), 'exactly one'],
    [
      'a changed creation time',
      next({ createdAt: '2026-01-02T00:00:00.000Z' }),
      'creation time',
    ],
  ])('rejects %s', (_name, after, problem) => {
    expect(() => buildCategoryUpdateEvents(base, after, updateIds)).toThrow(
      problem,
    );
  });

  it('rejects equal or invalid event IDs', () => {
    expect(() =>
      buildCategoryUpdateEvents(base, next({ active: false }), {
        ...updateIds,
        activationEventId: updateIds.policyEventId,
      }),
    ).toThrow('distinct');
    expect(() =>
      buildCategoryUpdateEvents(base, next({}), {
        ...updateIds,
        policyEventId: 'a#b',
      }),
    ).toThrow(CategoryEventError);
    expect(() =>
      buildCategoryUpdateEvents(base, next({}), {
        ...updateIds,
        activationEventId: '',
      }),
    ).toThrow(CategoryEventError);
  });

  it('accepts the largest safe version step', () => {
    const max = Number.MAX_SAFE_INTEGER;

    expect(
      buildCategoryUpdateEvents(
        { ...base, version: max - 1 },
        next({ version: max, active: false }),
        { ...updateIds, storedLastEventVersion: max - 1 },
      )[0]!.aggregate,
    ).toMatchObject({ version: max, previousEventVersion: max - 1 });
    expect(() =>
      buildCategoryUpdateEvents(
        { ...base, version: max },
        next({ version: max + 1 }),
        updateIds,
      ),
    ).toThrow(CategoryEventError);
  });
});

describe('deleted', () => {
  const request = { ...context, eventId: 'event-deleted-0001' };

  it('uses the next version after the stored category', () => {
    expect(buildCategoryDeletedEvent(base, request)).toEqual({
      eventId: 'event-deleted-0001',
      ...envelope('category.deleted', { categoryId: 'travel', version: 4 }),
    });
  });

  it('has no name and no policy fields', () => {
    const event = buildCategoryDeletedEvent(base, request);

    expect(Object.keys(event.payload).sort()).toEqual([
      'categoryId',
      'version',
    ]);
    expect(JSON.stringify(event)).not.toContain('Executive');
  });

  it('accepts the last safe version step and rejects overflow', () => {
    const max = Number.MAX_SAFE_INTEGER;

    expect(
      buildCategoryDeletedEvent(
        { ...base, version: max - 1 },
        { ...request, storedLastEventVersion: 1 },
      ).aggregate.version,
    ).toBe(max);
    expect(() =>
      buildCategoryDeletedEvent({ ...base, version: max }, request),
    ).toThrow('version');
    expect(() =>
      buildCategoryDeletedEvent({ ...base, version: 0 }, request),
    ).toThrow('version');
  });
});

describe('previous event versions', () => {
  it.each([undefined, 0])('are null when never published (%s)', (stored) => {
    const [event] = buildCategoryUpdateEvents(base, next({ active: false }), {
      ...updateIds,
      storedLastEventVersion: stored,
    });

    expect(event!.aggregate.previousEventVersion).toBeNull();
  });

  it.each([4, 5, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'reject %s for a change to version 4',
    (stored) => {
      expect(() =>
        buildCategoryUpdateEvents(base, next({ active: false }), {
          ...updateIds,
          storedLastEventVersion: stored,
        }),
      ).toThrow('previous event version');
    },
  );

  it('are checked for deletion too', () => {
    expect(() =>
      buildCategoryDeletedEvent(base, {
        ...context,
        eventId: 'event-deleted-0001',
        storedLastEventVersion: 4,
      }),
    ).toThrow('previous event version');
  });
});

describe('malformed inputs and safe errors', () => {
  const created: Category = { ...base, version: 1 };
  const request = {
    ...context,
    eventId: 'event-created-0001',
    storedLastEventVersion: undefined,
  };

  it.each<[string, Partial<CategoryEventContext & { eventId: string }>]>([
    ['an invalid actor', { actorId: 'sub dan' }],
    ['an invalid correlation ID', { correlationId: 'bad id!' }],
    ['an overlong causation ID', { causationId: 'c'.repeat(129) }],
    ['a date-only time', { occurredAt: '2026-09-30' }],
    ['a non-canonical time', { occurredAt: '2026-09-30T08:00:00Z' }],
    ['an impossible time', { occurredAt: '2026-02-30T00:00:00.000Z' }],
    ['an invalid event ID', { eventId: 'a#b' }],
  ])('rejects %s', (_name, change) => {
    expect(() =>
      buildCategoryCreatedEvent(created, { ...request, ...change }),
    ).toThrow(CategoryEventError);
  });

  it('never echoes supplied values', () => {
    const secret = 'Salary review for Aisha Rahman';
    const errors = [
      errorOf(() =>
        buildCategoryCreatedEvent({ ...created, categoryId: secret }, request),
      ),
      errorOf(() =>
        buildCategoryCreatedEvent(created, { ...request, actorId: secret }),
      ),
      errorOf(() =>
        buildCategoryCreatedEvent(created, {
          ...request,
          correlationId: secret,
        }),
      ),
      errorOf(() =>
        buildCategoryCreatedEvent(created, { ...request, occurredAt: secret }),
      ),
      errorOf(() =>
        buildCategoryUpdateEvents(
          base,
          next({ categoryId: secret }),
          updateIds,
        ),
      ),
      errorOf(() =>
        buildCategoryDeletedEvent(
          { ...base, categoryId: secret },
          { ...context, eventId: 'event-d-0001' },
        ),
      ),
    ];

    for (const error of errors) {
      expect(error).toBeInstanceOf(CategoryEventError);
      expect((error as Error).message).not.toContain('Salary');
      expect((error as Error).message).not.toContain('travel');
      expect((error as Error).message).not.toContain(secretName);
    }
  });
});

describe('with the outbox codec, operation builders, and composer', () => {
  const created: Category = { ...base, version: 1, updatedAt: base.createdAt };
  const all = () => [
    buildCategoryCreatedEvent(created, {
      ...context,
      eventId: 'event-created-0001',
      storedLastEventVersion: undefined,
    }),
    ...buildCategoryUpdateEvents(
      base,
      next({ active: false, maxAmountMinor: 1 }),
      updateIds,
    ),
    ...buildCategoryUpdateEvents(base, next({ active: false }), updateIds),
    buildCategoryDeletedEvent(base, {
      ...context,
      eventId: 'event-deleted-0001',
    }),
  ];

  it('round-trips every event through the outbox codec', () => {
    for (const event of all()) {
      expect(decodeOutboxItem(encodeOutboxItem(event))).toEqual({
        event,
        state: { state: 'PENDING' },
      });
    }
  });

  it('is refused by the codec if a payload would carry the name', () => {
    const [event] = buildCategoryUpdateEvents(
      base,
      next({ active: false }),
      updateIds,
    );
    const tampered = {
      ...event,
      payload: { ...event!.payload, name: secretName },
    } as unknown as typeof event & object;

    expect(() => encodeOutboxItem(tampered as never)).toThrow(
      ItemEncodingError,
    );
  });

  const completed: CompletedRequest = {
    actorId: 'sub-dan',
    key: 'category-key-0001',
    fingerprint: 'cd'.repeat(32),
    response: { status: 200, body: { categoryId: 'travel' } },
    createdAt: at,
    expiresAt: Math.floor(Date.parse(at) / 1000) + 86_400,
  };

  it('composes a double-event update with the update operation', () => {
    const after = next({ active: false, maxAmountMinor: 1 });
    const events = buildCategoryUpdateEvents(base, after, updateIds);
    const composed = composeBusinessTransaction({
      tableName: 'ClaimFlow',
      businessItems: [
        updateCategoryOperation('ClaimFlow', after, 3, events.length > 0),
      ],
      events,
      completed,
    });

    expect(composed.TransactItems).toHaveLength(4);
    expect(
      composed.TransactItems![0]!.Update!.ExpressionAttributeValues![
        ':lastEventVersion'
      ],
    ).toBe(4);
  });

  it('does not record an event version for a name-only update', () => {
    const after = next({ name: 'Renamed' });
    const events = buildCategoryUpdateEvents(base, after, updateIds);
    const composed = composeBusinessTransaction({
      tableName: 'ClaimFlow',
      businessItems: [
        updateCategoryOperation('ClaimFlow', after, 3, events.length > 0),
      ],
      events,
      completed,
    });

    expect(events).toEqual([]);
    expect(composed.TransactItems![0]!.Update!.UpdateExpression).not.toContain(
      'lastEventVersion',
    );
    expect(composed.TransactItems).toHaveLength(2);
  });

  it('composes creation and deletion consistently with their events', () => {
    const createdEvent = buildCategoryCreatedEvent(created, {
      ...context,
      eventId: 'event-created-0001',
      storedLastEventVersion: undefined,
    });
    const creation = createCategoryOperation('ClaimFlow', created);
    const deletion = deleteCategoryOperation('ClaimFlow', 'travel', 3);
    const deletedEvent = buildCategoryDeletedEvent(base, {
      ...context,
      eventId: 'event-deleted-0001',
    });

    expect(creation.Put!.Item!.lastEventVersion).toBe(
      createdEvent.aggregate.version,
    );
    expect(deletedEvent.aggregate.version).toBe(4);
    for (const [item, event] of [
      [creation, createdEvent],
      [deletion, deletedEvent],
    ] as const) {
      expect(
        composeBusinessTransaction({
          tableName: 'ClaimFlow',
          businessItems: [item],
          events: [event],
          completed,
        }).TransactItems,
      ).toHaveLength(3);
    }
  });
});
