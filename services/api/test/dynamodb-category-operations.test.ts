import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { Category } from '@claimflow/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  categoryCreateCondition,
  categoryDeleteCondition,
  categoryGuardCheckOperation,
  categoryGuardCondition,
  CategoryOperationError,
  categoryVersionCondition,
  claimCountDecrementCondition,
  createCategoryOperation,
  decrementClaimCountOperation,
  deleteCategoryOperation,
  incrementClaimCountOperation,
  updateCategoryOperation,
} from '../src/adapters/aws/dynamodb-category-operations.js';
import {
  decodeCategoryItem,
  encodeCategoryItem,
  ItemEncodingError,
} from '../src/adapters/aws/dynamodb-items.js';
import {
  composeBusinessTransaction,
  type TransactionItem,
} from '../src/adapters/aws/dynamodb-transaction.js';
import type {
  CategoryGuard,
  CompletedRequest,
} from '../src/application/commit.js';
import { eventSource, type OutboxEvent } from '../src/application/events.js';

const tableName = 'ClaimFlow';
const key = { PK: 'CATEGORIES', SK: 'CATEGORY#travel' };

const created: Category = {
  categoryId: 'travel',
  name: 'Travel',
  active: true,
  currency: 'MYR',
  maxAmountMinor: 200_000,
  receiptRequiredAboveMinor: 20_000,
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedBy: 'sub-dan',
};

const updated: Category = {
  ...created,
  name: 'Travel and lodging',
  active: false,
  currency: 'SGD',
  maxAmountMinor: 250_000,
  receiptRequiredAboveMinor: 0,
  version: 4,
  updatedAt: '2026-09-30T08:00:00.000Z',
  updatedBy: 'sub-erin',
};

/** An update that publishes an event, as most do. */
const updateWithEvent = (
  table: string,
  category: Category,
  expectedVersion: number,
) => updateCategoryOperation(table, category, expectedVersion, true);

const guard: CategoryGuard = {
  categoryId: 'travel',
  readVersion: 3,
  mustBeActive: true,
};

afterEach(() => {
  vi.restoreAllMocks();
});

/** Every attribute name an operation's expressions refer to. */
function touchedAttributes(item: TransactionItem): string[] {
  const operation = Object.values(item)[0] as {
    ExpressionAttributeNames?: Record<string, string>;
    UpdateExpression?: string;
  };
  const named = Object.values(operation.ExpressionAttributeNames ?? {});
  const bare = (operation.UpdateExpression ?? '')
    .replace(/^(SET|ADD)\s+/, '')
    .split(',')
    .map((part) => part.trim().split(/\s|=/)[0]!)
    .filter((name) => !name.startsWith('#'));
  return [...named, ...bare];
}

describe('create', () => {
  it('puts the full encoded item, unused, guarded against overwriting', () => {
    expect(createCategoryOperation(tableName, created)).toEqual({
      Put: {
        TableName: 'ClaimFlow',
        Item: encodeCategoryItem(created, {
          claimCount: 0,
          lastEventVersion: 1,
        }),
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    });
    expect(categoryCreateCondition).toBe('attribute_not_exists(PK)');
  });

  it('starts with no claims and creation as the latest event', () => {
    const item = createCategoryOperation(tableName, created).Put!.Item!;

    expect(item).toMatchObject({ ...key, claimCount: 0, lastEventVersion: 1 });
    expect(decodeCategoryItem(item)).toEqual({
      category: created,
      metadata: { claimCount: 0, lastEventVersion: 1 },
    });
  });

  it.each([0, 2, 1.5])('refuses a new category at version %s', (version) => {
    expect(() =>
      createCategoryOperation(tableName, { ...created, version }),
    ).toThrow(CategoryOperationError);
  });

  it.each<[string, Partial<Category>]>([
    ['an invalid ID', { categoryId: 'travel#2' }],
    ['an untrimmed name', { name: ' Travel' }],
    ['an invalid currency', { currency: 'myr' }],
    ['a zero maximum', { maxAmountMinor: 0 }],
    ['a non-canonical time', { createdAt: '2026-01-01T00:00:00Z' }],
  ])('refuses %s through the codec', (_name, change) => {
    expect(() =>
      createCategoryOperation(tableName, { ...created, ...change }),
    ).toThrow(ItemEncodingError);
  });
});

describe('update', () => {
  it('records lastEventVersion only when the update publishes an event', () => {
    const silent = updateCategoryOperation(
      tableName,
      updated,
      3,
      false,
    ).Update!;
    const published = updateCategoryOperation(
      tableName,
      updated,
      3,
      true,
    ).Update!;

    expect(silent.UpdateExpression).not.toContain('lastEventVersion');
    expect(silent.ExpressionAttributeNames).not.toHaveProperty(
      '#lastEventVersion',
    );
    expect(silent.ExpressionAttributeValues).not.toHaveProperty(
      ':lastEventVersion',
    );
    expect(silent.UpdateExpression).toContain('#version = :version');
    expect(silent.ConditionExpression).toBe('#version = :expectedVersion');
    expect(published.UpdateExpression).toContain(
      '#lastEventVersion = :lastEventVersion',
    );
    expect(published.ExpressionAttributeValues![':lastEventVersion']).toBe(4);
  });

  it('sets every mutable field and the version, conditioned on the expected version', () => {
    expect(updateWithEvent(tableName, updated, 3)).toEqual({
      Update: {
        TableName: 'ClaimFlow',
        Key: key,
        UpdateExpression:
          'SET #name = :name, #active = :active, #currency = :currency, ' +
          '#maxAmountMinor = :maxAmountMinor, ' +
          '#receiptRequiredAboveMinor = :receiptRequiredAboveMinor, ' +
          '#version = :version, #updatedAt = :updatedAt, ' +
          '#updatedBy = :updatedBy, #lastEventVersion = :lastEventVersion',
        ConditionExpression: '#version = :expectedVersion',
        ExpressionAttributeNames: {
          '#name': 'name',
          '#active': 'active',
          '#currency': 'currency',
          '#maxAmountMinor': 'maxAmountMinor',
          '#receiptRequiredAboveMinor': 'receiptRequiredAboveMinor',
          '#version': 'version',
          '#updatedAt': 'updatedAt',
          '#updatedBy': 'updatedBy',
          '#lastEventVersion': 'lastEventVersion',
        },
        ExpressionAttributeValues: {
          ':name': 'Travel and lodging',
          ':active': false,
          ':currency': 'SGD',
          ':maxAmountMinor': 250_000,
          ':receiptRequiredAboveMinor': 0,
          ':version': 4,
          ':updatedAt': '2026-09-30T08:00:00.000Z',
          ':updatedBy': 'sub-erin',
          ':lastEventVersion': 4,
          ':expectedVersion': 3,
        },
      },
    });
    expect(categoryVersionCondition).toBe('#version = :expectedVersion');
  });

  it('never sets claimCount, createdAt, keys, identity, or indexes', () => {
    const touched = touchedAttributes(updateWithEvent(tableName, updated, 3));

    for (const preserved of [
      'claimCount',
      'createdAt',
      'PK',
      'SK',
      'categoryId',
      'entityType',
    ]) {
      expect(touched).not.toContain(preserved);
    }
    expect(touched.some((name) => name.startsWith('GSI'))).toBe(false);
    expect(touched.sort()).toEqual(
      [
        'active',
        'currency',
        'lastEventVersion',
        'maxAmountMinor',
        'name',
        'receiptRequiredAboveMinor',
        'updatedAt',
        'updatedBy',
        'version',
      ].sort(),
    );
  });

  it.each([
    ['the same version', 3, 3],
    ['a skipped version', 3, 5],
    ['an older version', 3, 2],
  ])('refuses %s', (_name, expectedVersion, version) => {
    expect(() =>
      updateWithEvent(tableName, { ...updated, version }, expectedVersion),
    ).toThrow('one more than expectedVersion');
  });

  it('accepts the largest safe next version and refuses an unsafe one', () => {
    const max = Number.MAX_SAFE_INTEGER;

    expect(
      updateWithEvent(tableName, { ...updated, version: max }, max - 1).Update!
        .ExpressionAttributeValues,
    ).toMatchObject({ ':version': max, ':expectedVersion': max - 1 });
    expect(() =>
      updateWithEvent(tableName, { ...updated, version: max + 1 }, max),
    ).toThrow();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'refuses an expected version of %s',
    (expectedVersion) => {
      expect(() =>
        updateWithEvent(tableName, updated, expectedVersion),
      ).toThrow(CategoryOperationError);
    },
  );

  it.each<[string, Partial<Category>]>([
    ['an invalid ID', { categoryId: '' }],
    ['an empty name', { name: '' }],
    ['a negative threshold', { receiptRequiredAboveMinor: -1 }],
    ['an invalid updater', { updatedBy: 'sub erin' }],
  ])('refuses %s through the codec', (_name, change) => {
    expect(() =>
      updateWithEvent(tableName, { ...updated, ...change }, 3),
    ).toThrow(ItemEncodingError);
  });
});

describe('delete', () => {
  it('deletes at the expected version only while no claim uses the category', () => {
    expect(deleteCategoryOperation(tableName, 'travel', 4)).toEqual({
      Delete: {
        TableName: 'ClaimFlow',
        Key: key,
        ConditionExpression:
          '#version = :expectedVersion AND (attribute_not_exists(claimCount) OR claimCount = :zero)',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':expectedVersion': 4, ':zero': 0 },
      },
    });
    expect(categoryDeleteCondition).toContain('claimCount = :zero');
  });

  it('accepts the version boundaries and refuses invalid versions and IDs', () => {
    expect(() => deleteCategoryOperation(tableName, 'travel', 1)).not.toThrow();
    expect(() =>
      deleteCategoryOperation(tableName, 'travel', Number.MAX_SAFE_INTEGER),
    ).not.toThrow();
    for (const version of [0, 2.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        deleteCategoryOperation(tableName, 'travel', version),
      ).toThrow(CategoryOperationError);
    }
    for (const id of ['', 'travel#x', 'Travel and lodging', 'x'.repeat(65)]) {
      expect(() => deleteCategoryOperation(tableName, id, 4)).toThrow(
        'the category ID is not valid',
      );
    }
  });
});

describe('claim counter', () => {
  it('increments with the version and active guard on the same operation', () => {
    expect(incrementClaimCountOperation(tableName, guard)).toEqual({
      Update: {
        TableName: 'ClaimFlow',
        Key: key,
        UpdateExpression: 'ADD claimCount :one',
        ConditionExpression: '#version = :readVersion AND #active = :true',
        ExpressionAttributeNames: {
          '#version': 'version',
          '#active': 'active',
        },
        ExpressionAttributeValues: {
          ':one': 1,
          ':readVersion': 3,
          ':true': true,
        },
      },
    });
  });

  it('decrements only an existing counter that is at least one', () => {
    expect(decrementClaimCountOperation(tableName, 'travel')).toEqual({
      Update: {
        TableName: 'ClaimFlow',
        Key: key,
        UpdateExpression: 'ADD claimCount :minusOne',
        ConditionExpression: 'attribute_exists(PK) AND claimCount >= :one',
        ExpressionAttributeValues: { ':minusOne': -1, ':one': 1 },
      },
    });
    expect(claimCountDecrementCondition).toBe(
      'attribute_exists(PK) AND claimCount >= :one',
    );
  });

  it('never changes the version or the latest event version', () => {
    for (const item of [
      incrementClaimCountOperation(tableName, guard),
      decrementClaimCountOperation(tableName, 'travel'),
    ]) {
      expect(item.Update!.UpdateExpression).not.toMatch(/version|SET/i);
      expect(touchedAttributes(item)).toEqual(
        item.Update!.ExpressionAttributeNames === undefined
          ? ['claimCount']
          : ['version', 'active', 'claimCount'],
      );
    }
  });
});

describe('category guard check', () => {
  it('checks the version and active state without writing', () => {
    expect(categoryGuardCheckOperation(tableName, guard)).toEqual({
      ConditionCheck: {
        TableName: 'ClaimFlow',
        Key: key,
        ConditionExpression: '#version = :readVersion AND #active = :true',
        ExpressionAttributeNames: {
          '#version': 'version',
          '#active': 'active',
        },
        ExpressionAttributeValues: { ':readVersion': 3, ':true': true },
      },
    });
    expect(categoryGuardCondition).toBe(
      '#version = :readVersion AND #active = :true',
    );
  });

  it.each<[string, Partial<CategoryGuard>, string]>([
    ['an invalid category ID', { categoryId: 'travel#x' }, 'category ID'],
    ['a zero read version', { readVersion: 0 }, 'readVersion'],
    [
      'an unsafe read version',
      { readVersion: Number.MAX_SAFE_INTEGER + 1 },
      'readVersion',
    ],
    ['no active requirement', { mustBeActive: false }, 'active category'],
  ])(
    'refuses a guard with %s, for checks and increments',
    (_name, change, problem) => {
      for (const build of [
        categoryGuardCheckOperation,
        incrementClaimCountOperation,
      ]) {
        expect(() => build(tableName, { ...guard, ...change })).toThrow(
          problem,
        );
      }
    },
  );
});

describe('every builder', () => {
  const all = (): TransactionItem[] => [
    createCategoryOperation(tableName, created),
    updateWithEvent(tableName, updated, 3),
    deleteCategoryOperation(tableName, 'travel', 4),
    incrementClaimCountOperation(tableName, guard),
    decrementClaimCountOperation(tableName, 'travel'),
    categoryGuardCheckOperation(tableName, guard),
  ];

  it('targets the injected table and the category key, with no index attributes', () => {
    for (const item of all()) {
      const operation = Object.values(item)[0] as {
        TableName: string;
        Key?: Record<string, unknown>;
        Item?: Record<string, unknown>;
      };
      const target: Record<string, unknown> = operation.Key ?? {
        PK: operation.Item!.PK,
        SK: operation.Item!.SK,
      };
      expect(operation.TableName).toBe('ClaimFlow');
      expect(target).toEqual(key);
      expect(JSON.stringify(item)).not.toContain('GSI');
    }
  });

  it('refuses a missing table name', () => {
    expect(() => createCategoryOperation('', created)).toThrow('table name');
    expect(() => decrementClaimCountOperation('', 'travel')).toThrow(
      'table name',
    );
  });

  it('never puts free text in conditions or errors', () => {
    const conditions = all().map(
      (item) =>
        (Object.values(item)[0] as { ConditionExpression: string })
          .ConditionExpression,
    );
    for (const condition of conditions) {
      expect(condition).not.toContain('Travel');
    }
    const error = (() => {
      try {
        deleteCategoryOperation(tableName, 'Secret Travel Budget', 1);
      } catch (e) {
        return e;
      }
    })();
    expect(String(error)).not.toContain('Secret');
  });

  it('sends no DynamoDB command', () => {
    const send = vi.spyOn(DynamoDBDocumentClient.prototype, 'send');

    all();

    expect(send).not.toHaveBeenCalled();
  });
});

describe('with the transaction composer', () => {
  const completed: CompletedRequest = {
    actorId: 'sub-dan',
    key: 'category-key-0001',
    fingerprint: 'cd'.repeat(32),
    response: { status: 201, body: { categoryId: 'travel', version: 1 } },
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: 1_767_312_000,
  };
  const createdEvent: OutboxEvent = {
    eventId: 'event-created-1',
    eventType: 'category.created',
    schemaVersion: 1,
    occurredAt: '2026-01-01T00:00:00.000Z',
    source: eventSource,
    aggregate: {
      type: 'category',
      id: 'travel',
      version: 1,
      previousEventVersion: null,
    },
    correlationId: 'trace-1',
    causationId: 'request-1',
    actorId: 'sub-dan',
    payload: {
      categoryId: 'travel',
      version: 1,
      active: true,
      currency: 'MYR',
      maxAmountMinor: 200_000,
      receiptRequiredAboveMinor: 20_000,
    },
  };

  it('composes a category creation with its event and idempotency record', () => {
    const composed = composeBusinessTransaction({
      tableName,
      businessItems: [createCategoryOperation(tableName, created)],
      events: [createdEvent],
      completed,
    });

    expect(composed.TransactItems).toHaveLength(3);
    expect(composed.TransactItems![0]).toEqual(
      createCategoryOperation(tableName, created),
    );
    expect(composed.ClientRequestToken).toMatch(/^[0-9a-f]{32}$/);
  });

  it('composes counter changes on two categories with a claim operation', () => {
    const composed = composeBusinessTransaction({
      tableName,
      businessItems: [
        decrementClaimCountOperation(tableName, 'meals'),
        incrementClaimCountOperation(tableName, guard),
      ],
      events: [],
      completed,
    });

    expect(composed.TransactItems).toHaveLength(3);
  });

  it('refuses a counter change and a guard check on the same category', () => {
    expect(() =>
      composeBusinessTransaction({
        tableName,
        businessItems: [
          incrementClaimCountOperation(tableName, guard),
          categoryGuardCheckOperation(tableName, guard),
        ],
        events: [],
        completed,
      }),
    ).toThrow('touches the same item');
  });
});
