import type {
  TransactWriteCommandInput,
  TransactWriteCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';

import {
  DynamoDbIdempotentTransactionCommitter,
  type CommitExecutor,
  type IdempotencyLookup,
} from '../src/adapters/aws/dynamodb-idempotent-transaction-committer.js';
import type { IdempotencyRecord } from '../src/adapters/aws/dynamodb-idempotency-items.js';
import { composeBusinessTransaction } from '../src/adapters/aws/dynamodb-transaction.js';
import {
  toEpochSeconds,
  type CompletedRequest,
} from '../src/application/commit.js';
import { IdempotencyConflictError } from '../src/application/errors.js';

const tableName = 'ClaimFlow';
const createdAt = '2026-10-14T10:41:00.000Z';
const nowEpoch = toEpochSeconds(new Date(createdAt));

const completed: CompletedRequest = {
  actorId: 'sub-aisha',
  key: '5b0d6a8e-retry-key',
  fingerprint: 'ab'.repeat(32),
  response: { status: 201, body: { claimId: 'claim-1' } },
  createdAt,
  expiresAt: nowEpoch + 24 * 60 * 60,
};

const transaction: TransactWriteCommandInput = composeBusinessTransaction({
  tableName,
  businessItems: [
    {
      Put: {
        TableName: tableName,
        Item: { PK: 'CLAIM#claim-1', SK: 'CLAIM', note: 'x' },
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    },
  ],
  events: [],
  completed,
});

const record: IdempotencyRecord = { ...completed, outcome: 'COMPLETED' };
const rejectedWinner: IdempotencyRecord = {
  ...completed,
  outcome: 'REJECTED',
  response: { status: 409, body: { error: { code: 'VERSION_CONFLICT' } } },
};
const referenceWinner: IdempotencyRecord = {
  ...completed,
  response: { status: 201, resultRef: { receiptId: 'r-7731' } },
  outcome: 'COMPLETED',
};

const named = (name: string) => Object.assign(new Error(name), { name });
const coded = (code: string) =>
  Object.assign(new Error('Network failure'), { code });
const cancelled = () => named('TransactionCanceledException');

type Event =
  | { readonly kind: 'execute'; readonly input: unknown }
  | { readonly kind: 'lookup'; readonly args: unknown[] };

/** Scripted fakes that share one call log; `undefined` means success. */
function setup(
  executions: (Error | undefined)[] = [undefined],
  lookups: (IdempotencyRecord | undefined | Error)[] = [],
) {
  const events: Event[] = [];
  const executor: CommitExecutor = {
    execute: (input) => {
      events.push({ kind: 'execute', input });
      const next = executions.shift();
      return next === undefined
        ? Promise.resolve({ $metadata: {} } as TransactWriteCommandOutput)
        : Promise.reject(next);
    },
  };
  const lookup: IdempotencyLookup = {
    lookup: (...args) => {
      events.push({ kind: 'lookup', args });
      const next = lookups.shift();
      return next instanceof Error
        ? Promise.reject(next)
        : Promise.resolve(next);
    },
  };
  return {
    events,
    committer: new DynamoDbIdempotentTransactionCommitter({ executor, lookup }),
  };
}

const kinds = (events: Event[]) => events.map((event) => event.kind);
const commit = (committer: DynamoDbIdempotentTransactionCommitter) =>
  committer.commit(transaction, completed, nowEpoch);

describe('construction', () => {
  it.each([undefined, null, {}, { execute: 'x' }])(
    'rejects the executor %j',
    (executor) => {
      expect(
        () =>
          new DynamoDbIdempotentTransactionCommitter({
            executor: executor as unknown as CommitExecutor,
            lookup: { lookup: () => Promise.resolve(undefined) },
          }),
      ).toThrow(new TypeError('The transaction executor is missing.'));
    },
  );

  it.each([undefined, null, {}, { lookup: 1 }])(
    'rejects the lookup %j',
    (lookup) => {
      expect(
        () =>
          new DynamoDbIdempotentTransactionCommitter({
            executor: { execute: () => Promise.resolve({ $metadata: {} }) },
            lookup: lookup as unknown as IdempotencyLookup,
          }),
      ).toThrow(new TypeError('The idempotency lookup is missing.'));
    },
  );

  it('exposes only commit', () => {
    expect(
      Object.getOwnPropertyNames(
        DynamoDbIdempotentTransactionCommitter.prototype,
      ),
    ).toEqual(['constructor', 'commit', 'find']);
  });
});

describe('success', () => {
  it('sends the supplied transaction once and returns the completed record', async () => {
    const { events, committer } = setup();

    expect(await commit(committer)).toEqual(record);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ kind: 'execute', input: transaction });
    expect((events[0] as { input: unknown }).input).toBe(transaction);
  });

  it('returns a result reference record as completed', async () => {
    const reference: CompletedRequest = {
      ...completed,
      response: { status: 201, resultRef: { receiptId: 'r-7731' } },
    };
    const composed = composeBusinessTransaction({
      tableName,
      businessItems: [
        {
          Put: {
            TableName: tableName,
            Item: { PK: 'RECEIPT#r-7731', SK: 'RECEIPT' },
          },
        },
      ],
      events: [],
      completed: reference,
    });
    const { committer } = setup();

    expect(await committer.commit(composed, reference, nowEpoch)).toEqual(
      referenceWinner,
    );
  });
});

describe('cancellation', () => {
  it.each([
    ['a completed', { ...record, response: { status: 201, body: {} } }],
    ['a rejected', rejectedWinner],
    ['a reference', referenceWinner],
  ])('returns %s concurrent winner intact', async (_name, winner) => {
    const { events, committer } = setup([cancelled()], [winner]);

    expect(await commit(committer)).toBe(winner);

    expect(kinds(events)).toEqual(['execute', 'lookup']);
    expect(events[1]).toEqual({
      kind: 'lookup',
      args: ['sub-aisha', completed.key, completed.fingerprint, nowEpoch],
    });
  });

  it('lets a fingerprint conflict propagate', async () => {
    const conflict = new IdempotencyConflictError('conflict');
    const { events, committer } = setup([cancelled()], [conflict]);

    await expect(commit(committer)).rejects.toBe(conflict);
    expect(kinds(events)).toEqual(['execute', 'lookup']);
  });

  it('rethrows the original cancellation when there is no winner, without a retry', async () => {
    const failure = cancelled();
    const { events, committer } = setup([failure], [undefined]);

    await expect(commit(committer)).rejects.toBe(failure);
    expect(kinds(events)).toEqual(['execute', 'lookup']);
  });

  it('inspects no cancellation reason', async () => {
    const failure = Object.assign(cancelled(), {
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
    });
    const { events, committer } = setup([failure], [undefined]);

    await expect(commit(committer)).rejects.toBe(failure);
    expect(kinds(events)).toEqual(['execute', 'lookup']);
  });

  it('propagates a lookup error unchanged', async () => {
    const failure = new Error('ThrottlingException on read');
    const { committer } = setup([cancelled()], [failure]);
    await expect(commit(committer)).rejects.toBe(failure);
  });
});

describe('ambiguous failures', () => {
  const ambiguous = [
    named('InternalServerError'),
    named('ServiceUnavailable'),
    named('ServiceUnavailableException'),
    named('TimeoutError'),
    named('RequestTimeout'),
    named('ThrottlingException'),
    named('ProvisionedThroughputExceededException'),
    named('RequestLimitExceeded'),
    coded('ECONNRESET'),
    coded('ETIMEDOUT'),
    coded('EPIPE'),
    coded('ECONNABORTED'),
  ];

  it.each(
    ambiguous.map(
      (error) =>
        [error.name + (error as { code?: string }).code, error] as const,
    ),
  )(
    'resolves %s through a winner found by the first lookup, without a retry',
    async (_name, failure) => {
      const { events, committer } = setup([failure], [rejectedWinner]);

      expect(await commit(committer)).toBe(rejectedWinner);
      expect(kinds(events)).toEqual(['execute', 'lookup']);
    },
  );

  it.each(
    ambiguous.map(
      (error) =>
        [error.name + (error as { code?: string }).code, error] as const,
    ),
  )(
    'retries the identical transaction once after %s when there is no winner',
    async (_name, failure) => {
      const { events, committer } = setup([failure], [undefined]);

      expect(await commit(committer)).toEqual(record);

      expect(kinds(events)).toEqual(['execute', 'lookup', 'execute']);
      const [first, , second] = events as {
        input: TransactWriteCommandInput;
      }[];
      expect(second!.input).toBe(first!.input);
      expect(second!.input.ClientRequestToken).toBe(
        transaction.ClientRequestToken,
      );
    },
  );

  it('lets a fingerprint conflict from the first lookup propagate without a retry', async () => {
    const conflict = new IdempotencyConflictError('conflict');
    const { events, committer } = setup(
      [named('InternalServerError')],
      [conflict],
    );

    await expect(commit(committer)).rejects.toBe(conflict);
    expect(kinds(events)).toEqual(['execute', 'lookup']);
  });

  it('propagates the first lookup error unchanged, without a retry', async () => {
    const failure = new Error('lookup failed');
    const { events, committer } = setup([named('TimeoutError')], [failure]);

    await expect(commit(committer)).rejects.toBe(failure);
    expect(kinds(events)).toEqual(['execute', 'lookup']);
  });

  it.each([
    ['a cancellation', cancelled()],
    ['another ambiguous failure', named('InternalServerError')],
  ])(
    'does a final lookup when the retry ends in %s and returns a winner',
    async (_n, retry) => {
      const { events, committer } = setup(
        [named('TimeoutError'), retry],
        [undefined, referenceWinner],
      );

      expect(await commit(committer)).toBe(referenceWinner);
      expect(kinds(events)).toEqual(['execute', 'lookup', 'execute', 'lookup']);
    },
  );

  it.each([
    ['a cancellation', cancelled()],
    ['another ambiguous failure', named('ServiceUnavailable')],
  ])(
    'rethrows the retry failure unchanged when the final lookup finds nothing after %s',
    async (_n, retry) => {
      const { events, committer } = setup(
        [named('TimeoutError'), retry],
        [undefined, undefined],
      );

      await expect(commit(committer)).rejects.toBe(retry);
      expect(kinds(events)).toEqual(['execute', 'lookup', 'execute', 'lookup']);
    },
  );

  it('lets a conflict from the final lookup propagate', async () => {
    const conflict = new IdempotencyConflictError('conflict');
    const { committer } = setup(
      [named('TimeoutError'), cancelled()],
      [undefined, conflict],
    );
    await expect(commit(committer)).rejects.toBe(conflict);
  });

  it('propagates a final lookup error unchanged', async () => {
    const failure = new Error('lookup failed');
    const { committer } = setup(
      [named('TimeoutError'), named('TimeoutError')],
      [undefined, failure],
    );
    await expect(commit(committer)).rejects.toBe(failure);
  });

  it('propagates a non-ambiguous retry failure without a final lookup', async () => {
    const failure = named('ValidationException');
    const { events, committer } = setup(
      [named('TimeoutError'), failure],
      [undefined],
    );

    await expect(commit(committer)).rejects.toBe(failure);
    expect(kinds(events)).toEqual(['execute', 'lookup', 'execute']);
  });

  it('retries at most once', async () => {
    const { events, committer } = setup(
      [named('TimeoutError'), named('TimeoutError'), undefined],
      [undefined, undefined, undefined],
    );

    await expect(commit(committer)).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    expect(events.filter((event) => event.kind === 'execute')).toHaveLength(2);
  });
});

describe('failures that are neither cancellations nor ambiguous', () => {
  it.each([
    ['a validation error', named('ValidationException')],
    ['a token mismatch', named('IdempotentParameterMismatchException')],
    ['an access error', named('AccessDeniedException')],
    ['a missing table', named('ResourceNotFoundException')],
    ['a programming error', new TypeError('boom')],
    ['an unknown error', new Error('anything at all')],
    ['an error only named in its message', new Error('InternalServerError')],
    ['an unrelated transport code', coded('ENOTFOUND')],
  ])(
    'propagates %s unchanged without a lookup or retry',
    async (_name, failure) => {
      const { events, committer } = setup([failure], [rejectedWinner]);

      await expect(commit(committer)).rejects.toBe(failure);
      expect(kinds(events)).toEqual(['execute']);
    },
  );

  it('propagates a non-error rejection unchanged', async () => {
    const { events, committer } = setup(['boom' as unknown as Error]);
    await expect(commit(committer)).rejects.toBe('boom');
    expect(kinds(events)).toEqual(['execute']);
  });
});

describe('invalid inputs', () => {
  const withItems = (
    change: (
      items: NonNullable<TransactWriteCommandInput['TransactItems']>,
    ) => void,
  ): TransactWriteCommandInput => {
    const copy = structuredClone(transaction);
    change(copy.TransactItems!);
    return copy;
  };

  it.each([
    [
      'a missing transaction',
      undefined,
      completed,
      nowEpoch,
      'The transaction is missing.',
    ],
    [
      'a missing completed request',
      transaction,
      undefined,
      nowEpoch,
      'The completed request is missing.',
    ],
    [
      'a transaction with extra input',
      { ...transaction, ReturnConsumedCapacity: 'TOTAL' },
      completed,
      nowEpoch,
      'The transaction is not a composed transaction.',
    ],
    [
      'a transaction without a token',
      { TransactItems: transaction.TransactItems },
      completed,
      nowEpoch,
      'The transaction is not a composed transaction.',
    ],
    [
      'a transaction without items',
      { TransactItems: [], ClientRequestToken: 'x' },
      completed,
      nowEpoch,
      'The transaction is not a composed transaction.',
    ],
    [
      'a token that does not match',
      { ...transaction, ClientRequestToken: 'f'.repeat(32) },
      completed,
      nowEpoch,
      'The transaction request token is not correct.',
    ],
    [
      'a record for another fingerprint',
      transaction,
      { ...completed, fingerprint: 'cd'.repeat(32) },
      nowEpoch,
      'The transaction does not end with the completed idempotency record.',
    ],
    [
      'a record with another response',
      transaction,
      { ...completed, response: { status: 201, body: { claimId: 'other' } } },
      nowEpoch,
      'The transaction does not end with the completed idempotency record.',
    ],
    [
      'a record for another key',
      transaction,
      { ...completed, key: 'another-key-0001' },
      nowEpoch,
      'The transaction does not end with the completed idempotency record.',
    ],
  ])('refuses %s before any call', async (_name, tx, request, now, message) => {
    const { events, committer } = setup();

    await expect(
      committer.commit(
        tx as TransactWriteCommandInput,
        request as CompletedRequest,
        now,
      ),
    ).rejects.toThrow(new TypeError(message));
    expect(events).toEqual([]);
  });

  it('refuses a transaction whose last item is not the idempotency record', async () => {
    const { events, committer } = setup();
    const reordered = withItems((items) => items.reverse());

    await expect(
      committer.commit(reordered, completed, nowEpoch),
    ).rejects.toThrow(
      new TypeError(
        'The transaction does not end with the completed idempotency record.',
      ),
    );
    expect(events).toEqual([]);
  });

  it('refuses a transaction whose idempotency condition was changed', async () => {
    const { events, committer } = setup();
    const changed = withItems((items) => {
      items[items.length - 1]!.Put!.ConditionExpression =
        'attribute_exists(PK)';
    });

    await expect(
      committer.commit(changed, completed, nowEpoch),
    ).rejects.toBeInstanceOf(TypeError);
    expect(events).toEqual([]);
  });

  it('refuses a business change that the token does not cover', async () => {
    const { events, committer } = setup();
    const tampered = withItems((items) => {
      items[0]!.Put!.Item = { PK: 'CLAIM#claim-1', SK: 'CLAIM', note: 'y' };
    });

    await expect(
      committer.commit(tampered, completed, nowEpoch),
    ).rejects.toThrow(
      new TypeError('The transaction request token is not correct.'),
    );
    expect(events).toEqual([]);
  });

  it('refuses a payload that cannot be canonicalized, with a fixed message', async () => {
    const { events, committer } = setup();
    const odd = withItems((items) => {
      (items[0]!.Put!.Item as Record<string, unknown>).when = () => 1;
    });

    await expect(
      committer.commit(odd, completed, nowEpoch),
    ).rejects.toBeInstanceOf(TypeError);
    expect(events).toEqual([]);
  });

  it('refuses a record the idempotency codec refuses', async () => {
    const { events, committer } = setup();
    await expect(
      committer.commit(transaction, { ...completed, expiresAt: 5 }, nowEpoch),
    ).rejects.toBeInstanceOf(Error);
    expect(events).toEqual([]);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses the time %s before any call',
    async (bad) => {
      const { events, committer } = setup();
      await expect(
        committer.commit(transaction, completed, bad),
      ).rejects.toThrow(
        new RangeError('nowEpoch must be whole Unix epoch seconds.'),
      );
      expect(events).toEqual([]);
    },
  );

  it('refuses an expired record before any call', async () => {
    const { events, committer } = setup([undefined], [rejectedWinner]);

    await expect(
      committer.commit(transaction, completed, completed.expiresAt + 1),
    ).rejects.toThrow(
      new RangeError('The idempotency record has already expired.'),
    );
    expect(events).toEqual([]);
  });

  it('accepts a record expiring exactly now', async () => {
    const { events, committer } = setup();

    expect(
      await committer.commit(transaction, completed, completed.expiresAt),
    ).toEqual(record);
    expect(kinds(events)).toEqual(['execute']);
  });

  it('echoes no supplied value in its messages', async () => {
    const { committer } = setup();
    const failures = await Promise.allSettled([
      committer.commit(
        transaction,
        { ...completed, key: 'Secret Key' },
        nowEpoch,
      ),
      committer.commit(
        { ...transaction, ClientRequestToken: 'Secret Token' },
        completed,
        nowEpoch,
      ),
      committer.commit(
        transaction,
        { ...completed, response: { status: 201, body: 'Secret Body' } },
        nowEpoch,
      ),
    ]);
    for (const failure of failures) {
      expect(failure.status).toBe('rejected');
      expect(String((failure as PromiseRejectedResult).reason)).not.toContain(
        'Secret',
      );
    }
  });
});
