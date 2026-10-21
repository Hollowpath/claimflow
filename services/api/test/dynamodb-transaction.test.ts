import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { encodeIdempotencyItem } from '../src/adapters/aws/dynamodb-idempotency-items.js';
import { ItemEncodingError } from '../src/adapters/aws/dynamodb-items.js';
import { encodeOutboxItem } from '../src/adapters/aws/dynamodb-outbox-items.js';
import {
  composeBusinessTransaction,
  maxTransactionOperations,
  TransactionCompositionError,
  type BusinessTransactionInput,
  type TransactionItem,
} from '../src/adapters/aws/dynamodb-transaction.js';
import {
  canonicalJson,
  transactionRequestToken,
} from '../src/adapters/aws/transaction-token.js';
import type { CompletedRequest } from '../src/application/commit.js';
import { eventSource, type OutboxEvent } from '../src/application/events.js';

const tableName = 'ClaimFlow';
const claimId = '4ce0c74b-9c64-46d6-87ba-07fb71b0628c';
const at = '2026-10-14T10:41:00.000Z';
const atEpoch = 1_791_974_460;

/** A representative claim update supplied by a repository builder. */
function claimUpdate(expectedVersion = 3): TransactionItem {
  return {
    Update: {
      TableName: tableName,
      Key: { PK: `CLAIM#${claimId}`, SK: 'CLAIM' },
      UpdateExpression: 'SET #status = :submitted, #version = :next',
      ConditionExpression: '#version = :expected AND employeeId = :actor',
      ExpressionAttributeNames: { '#status': 'status', '#version': 'version' },
      ExpressionAttributeValues: {
        ':submitted': 'SUBMITTED',
        ':next': expectedVersion + 1,
        ':expected': expectedVersion,
        ':actor': 'sub-aisha',
      },
    },
  };
}

function historyPut(version = 4): TransactionItem {
  return {
    Put: {
      TableName: tableName,
      Item: {
        PK: `CLAIM#${claimId}`,
        SK: `HISTORY#${String(version).padStart(10, '0')}`,
        entityType: 'ClaimHistory',
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    },
  };
}

function submittedEvent(
  eventId = '8f3d2c1e-5a7b-4c1d-9e2f-0a1b2c3d4e5f',
): OutboxEvent {
  return {
    eventId,
    eventType: 'claim.submitted',
    schemaVersion: 1,
    occurredAt: at,
    source: eventSource,
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
  };
}

const completed: CompletedRequest = {
  actorId: 'sub-aisha',
  key: '5b0d6a8e-retry-key',
  fingerprint: 'ab'.repeat(32),
  response: { status: 200, body: { claimId, version: 4 } },
  createdAt: at,
  expiresAt: 1_792_060_860,
};

function input(
  overrides: Partial<BusinessTransactionInput> = {},
): BusinessTransactionInput {
  return {
    tableName,
    businessItems: [claimUpdate(), historyPut()],
    events: [submittedEvent()],
    completed,
    ...overrides,
  };
}

const idempotencyPut = (
  request: CompletedRequest = completed,
): TransactionItem => ({
  Put: {
    TableName: tableName,
    Item: encodeIdempotencyItem({ ...request, outcome: 'COMPLETED' }),
    ConditionExpression: 'attribute_not_exists(PK) OR expiresAt < :nowEpoch',
    ExpressionAttributeValues: { ':nowEpoch': atEpoch },
  },
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('composeBusinessTransaction', () => {
  it('composes business items, pending outbox Puts, and the idempotency Put, with a token', () => {
    const composed = composeBusinessTransaction(input());

    expect(composed.TransactItems).toEqual([
      claimUpdate(),
      historyPut(),
      {
        Put: {
          TableName: 'ClaimFlow',
          Item: encodeOutboxItem(submittedEvent()),
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
      {
        Put: {
          TableName: 'ClaimFlow',
          Item: {
            PK: 'IDEMPOTENCY#sub-aisha#5b0d6a8e-retry-key',
            SK: 'IDEMPOTENCY',
            entityType: 'IdempotencyRecord',
            fingerprint: 'ab'.repeat(32),
            outcome: 'COMPLETED',
            response: { status: 200, body: { claimId, version: 4 } },
            createdAt: at,
            expiresAt: 1_792_060_860,
          },
          ConditionExpression:
            'attribute_not_exists(PK) OR expiresAt < :nowEpoch',
          ExpressionAttributeValues: { ':nowEpoch': atEpoch },
        },
      },
    ]);
    expect(composed.ClientRequestToken).toMatch(/^[0-9a-f]{32}$/);
    expect(Object.keys(composed).sort()).toEqual([
      'ClientRequestToken',
      'TransactItems',
    ]);
  });

  it('writes outbox items as pending, with no publication or TTL attributes', () => {
    const outbox =
      composeBusinessTransaction(input()).TransactItems![2]!.Put!.Item!;

    expect(outbox).toMatchObject({
      state: 'PENDING',
      GSI4PK: 'OUTBOX#PENDING',
      GSI4SK: `${at}#8f3d2c1e-5a7b-4c1d-9e2f-0a1b2c3d4e5f`,
    });
    expect(outbox).not.toHaveProperty('publishedAt');
    expect(outbox).not.toHaveProperty('expiresAt');
  });

  it('derives the token from the payload without the token', () => {
    const composed = composeBusinessTransaction(input());

    expect(composed.ClientRequestToken).toBe(
      transactionRequestToken({
        actorId: 'sub-aisha',
        idempotencyKey: '5b0d6a8e-retry-key',
        fingerprint: 'ab'.repeat(32),
        transaction: { TransactItems: composed.TransactItems },
      }),
    );
    expect(canonicalJson(composed.TransactItems)).not.toContain(
      composed.ClientRequestToken,
    );
  });

  it('stores a 204 response without a body', () => {
    const noContent = {
      ...completed,
      response: { status: 204, body: undefined },
    };
    const items = composeBusinessTransaction(
      input({ completed: noContent }),
    ).TransactItems!;

    expect(items.at(-1)!.Put!.Item!.response).toEqual({ status: 204 });
  });

  it('accepts zero events, putting idempotency right after the business items', () => {
    const items = composeBusinessTransaction(
      input({ events: [] }),
    ).TransactItems!;

    expect(items).toEqual([claimUpdate(), historyPut(), idempotencyPut()]);
  });

  it('keeps several events in order', () => {
    const first = submittedEvent('event-0001');
    const second = submittedEvent('event-0002');
    const items = composeBusinessTransaction(
      input({ events: [second, first] }),
    ).TransactItems!;

    expect(items.map((item) => item.Put?.Item?.eventId)).toEqual([
      undefined,
      undefined,
      'event-0002',
      'event-0001',
      undefined,
    ]);
  });

  it('produces the same token for a rebuilt identical input', () => {
    const one = composeBusinessTransaction(input());
    const two = composeBusinessTransaction(
      JSON.parse(JSON.stringify(input())) as BusinessTransactionInput,
    );

    expect(two).toEqual(one);
    expect(two.ClientRequestToken).toBe(one.ClientRequestToken);
  });

  it.each<[string, Partial<BusinessTransactionInput>]>([
    ['a business value', { businessItems: [claimUpdate(4), historyPut()] }],
    ['an event', { events: [submittedEvent('event-other')] }],
    ['no event', { events: [] }],
    [
      'the stored response',
      {
        completed: {
          ...completed,
          response: { status: 200, body: { claimId, version: 5 } },
        },
      },
    ],
    [
      'the business item order',
      { businessItems: [historyPut(), claimUpdate()] },
    ],
  ])('changes the token when %s changes', (_name, change) => {
    expect(
      composeBusinessTransaction(input(change)).ClientRequestToken,
    ).not.toBe(composeBusinessTransaction(input()).ClientRequestToken);
  });

  it('rejects an invalid completed response through the codec', () => {
    for (const response of [
      { status: 409, body: {} },
      { status: 204, body: {} },
      { status: 200, body: undefined },
    ]) {
      expect(() =>
        composeBusinessTransaction(
          input({ completed: { ...completed, response } }),
        ),
      ).toThrow(ItemEncodingError);
    }
  });

  it('rejects an invalid outbox event through the codec', () => {
    const event = {
      ...submittedEvent(),
      source: 'elsewhere',
    } as unknown as OutboxEvent;

    expect(() =>
      composeBusinessTransaction(input({ events: [event] })),
    ).toThrow(ItemEncodingError);
  });
});

describe('validation', () => {
  const rejects = (
    overrides: Partial<BusinessTransactionInput>,
    problem: string,
  ) => {
    const compose = () => composeBusinessTransaction(input(overrides));
    expect(compose).toThrow(TransactionCompositionError);
    expect(compose).toThrow(problem);
  };

  it('requires at least one business item and a table name', () => {
    rejects({ businessItems: [] }, 'there are no business items');
    rejects({ tableName: '' }, 'the table name is missing');
  });

  it('requires every operation to target the supplied table', () => {
    const elsewhere: TransactionItem = {
      Update: { ...claimUpdate().Update!, TableName: 'Other' },
    };

    rejects(
      { businessItems: [elsewhere] },
      "operation 1 does not target the transaction's table",
    );
    // The second business item still targets ClaimFlow.
    rejects(
      { tableName: 'Other', businessItems: [elsewhere, historyPut()] },
      'operation 2 does not target',
    );
  });

  it.each<[string, unknown, string]>([
    [
      'an empty operation',
      {},
      'exactly one of Put, Update, Delete, or ConditionCheck',
    ],
    [
      'two operation types',
      { ...claimUpdate(), ...historyPut() },
      'exactly one of',
    ],
    [
      'an unsupported operation',
      { Get: { TableName: tableName, Key: { PK: 'A', SK: 'B' } } },
      'exactly one of',
    ],
    [
      'operation parameters that are not an object',
      { Delete: 'CLAIM' },
      'has no parameters',
    ],
    [
      'a Put without an item',
      { Put: { TableName: tableName } },
      'exactly PK and SK',
    ],
    [
      'a key without SK',
      { Delete: { TableName: tableName, Key: { PK: 'CLAIM#x' } } },
      'exactly PK and SK',
    ],
    [
      'a key with extra attributes',
      {
        ConditionCheck: {
          TableName: tableName,
          Key: { PK: 'A', SK: 'B', GSI1PK: 'C' },
          ConditionExpression: 'x',
        },
      },
      'exactly PK and SK',
    ],
    [
      'a numeric key value',
      { Delete: { TableName: tableName, Key: { PK: 'CLAIM#x', SK: 1 } } },
      'string PK and SK',
    ],
    [
      'an empty key value',
      { Put: { TableName: tableName, Item: { PK: '', SK: 'CLAIM' } } },
      'string PK and SK',
    ],
  ])('rejects %s', (_name, operation, problem) => {
    rejects({ businessItems: [operation as TransactionItem] }, problem);
  });

  it('rejects two business operations on the same item', () => {
    const check: TransactionItem = {
      ConditionCheck: {
        TableName: tableName,
        Key: { PK: `CLAIM#${claimId}`, SK: 'CLAIM' },
        ConditionExpression: 'attribute_exists(PK)',
      },
    };

    rejects(
      { businessItems: [claimUpdate(), check] },
      'operation 2 touches the same item as operation 1',
    );
  });

  it('rejects business items that collide with an outbox or idempotency item', () => {
    const outboxItem = encodeOutboxItem(submittedEvent());
    const sameOutbox: TransactionItem = {
      Put: {
        TableName: tableName,
        Item: { PK: outboxItem.PK, SK: outboxItem.SK },
      },
    };
    const sameIdempotency: TransactionItem = {
      Delete: {
        TableName: tableName,
        Key: {
          PK: 'IDEMPOTENCY#sub-aisha#5b0d6a8e-retry-key',
          SK: 'IDEMPOTENCY',
        },
      },
    };

    rejects(
      { businessItems: [sameOutbox] },
      'operation 2 touches the same item as operation 1',
    );
    rejects(
      { businessItems: [sameIdempotency], events: [] },
      'operation 2 touches the same item as operation 1',
    );
  });

  it('rejects two identical events', () => {
    rejects(
      { events: [submittedEvent(), submittedEvent()] },
      'operation 4 touches the same item as operation 3',
    );
  });

  it('accepts exactly 100 operations and rejects 101', () => {
    const checks = (count: number): TransactionItem[] =>
      Array.from({ length: count }, (_, i) => ({
        ConditionCheck: {
          TableName: tableName,
          Key: { PK: `CLAIM#claim-${i}`, SK: 'CLAIM' },
          ConditionExpression: 'attribute_exists(PK)',
        },
      }));

    const full = composeBusinessTransaction(
      input({ businessItems: checks(98) }),
    );
    expect(full.TransactItems).toHaveLength(maxTransactionOperations);
    expect(maxTransactionOperations).toBe(100);
    rejects(
      { businessItems: checks(99) },
      'it has 101 operations; the limit is 100',
    );
  });

  it('never names key values in its errors', () => {
    const secret = 'CLAIM#Salary review for Aisha';
    const compose = () =>
      composeBusinessTransaction(
        input({
          businessItems: [
            {
              Delete: {
                TableName: tableName,
                Key: { PK: secret, SK: 'CLAIM' },
              },
            },
            {
              Delete: {
                TableName: tableName,
                Key: { PK: secret, SK: 'CLAIM' },
              },
            },
          ],
        }),
      );

    expect(compose).toThrow(TransactionCompositionError);
    try {
      compose();
    } catch (error) {
      expect(String(error)).not.toContain('Salary');
    }
  });
});

it('sends no DynamoDB command', () => {
  const send = vi.spyOn(DynamoDBDocumentClient.prototype, 'send');

  const composed = composeBusinessTransaction(input());
  expect(() =>
    composeBusinessTransaction(input({ businessItems: [] })),
  ).toThrow();

  expect(send).not.toHaveBeenCalled();
  expect(Object.getPrototypeOf(composed)).toBe(Object.prototype);
});

describe('result references', () => {
  const reference: CompletedRequest = {
    ...completed,
    response: { status: 201, resultRef: { receiptId: 'r-7731' } },
  };

  it('stores a result reference as the idempotency item, without a body', () => {
    const composed = composeBusinessTransaction(
      input({ events: [], completed: reference }),
    );

    expect(composed.TransactItems!.at(-1)).toEqual(idempotencyPut(reference));
    expect(composed.TransactItems!.at(-1)!.Put!.Item!.response).toEqual({
      status: 201,
      resultRef: { receiptId: 'r-7731' },
    });
  });

  it('has a deterministic token that differs from the snapshot form', () => {
    const first = composeBusinessTransaction(input({ completed: reference }));
    const second = composeBusinessTransaction(input({ completed: reference }));
    const snapshot = composeBusinessTransaction(input());

    expect(first.ClientRequestToken).toBe(second.ClientRequestToken);
    expect(first.ClientRequestToken).not.toBe(snapshot.ClientRequestToken);
  });

  it('refuses a malformed reference before building anything', () => {
    for (const response of [
      { status: 201, resultRef: { receiptId: 'r-7731' }, body: {} },
      { status: 201, resultRef: { receiptId: '' } },
      { status: 201, resultRef: { receiptId: 'r-7731', extra: 1 } },
      { status: 200, resultRef: { receiptId: 'r-7731' } },
    ]) {
      expect(() =>
        composeBusinessTransaction(
          input({
            completed: {
              ...completed,
              response,
            } as unknown as CompletedRequest,
          }),
        ),
      ).toThrow(ItemEncodingError);
    }
  });
});
