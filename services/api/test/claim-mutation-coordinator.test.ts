import type {
  TransactWriteCommandInput,
  TransactWriteCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import type { ClaimChange } from '@claimflow/domain';
import { describe, expect, it } from 'vitest';

import {
  ClaimMutationCoordinator,
  type ClaimMutationRequest,
  type MutationCommitter,
  type MutationLookup,
  type MutationRejections,
  type PreparedClaimMutation,
  type PreparedClaimRejection,
} from '../src/adapters/aws/claim-mutation-coordinator.js';
import { DynamoDbClaimWriter } from '../src/adapters/aws/dynamodb-claim-writer.js';
import { DynamoDbIdempotentTransactionCommitter } from '../src/adapters/aws/dynamodb-idempotent-transaction-committer.js';
import type { IdempotencyRecord } from '../src/adapters/aws/dynamodb-idempotency-items.js';
import type { RejectedIdempotencyRecord } from '../src/adapters/aws/dynamodb-idempotency-writer.js';
import { composeBusinessTransaction } from '../src/adapters/aws/dynamodb-transaction.js';
import {
  toEpochSeconds,
  type CompletedRequest,
} from '../src/application/commit.js';
import { IdempotencyConflictError } from '../src/application/errors.js';

const tableName = 'ClaimFlow';
const claimId = '4ce0c74b-9c64-46d6-87ba-07fb71b0628c';
const createdAt = '2026-10-14T10:41:00.000Z';
const nowEpoch = toEpochSeconds(new Date(createdAt));

const request: ClaimMutationRequest = {
  actorId: 'sub-aisha',
  key: '5b0d6a8e-retry-key',
  fingerprint: 'ab'.repeat(32),
  nowEpoch,
};

const completed: CompletedRequest = {
  actorId: request.actorId,
  key: request.key,
  fingerprint: request.fingerprint,
  response: { status: 201, body: { claimId } },
  createdAt,
  expiresAt: nowEpoch + 24 * 60 * 60,
};
const record: IdempotencyRecord = { ...completed, outcome: 'COMPLETED' };
const rejection: IdempotencyRecord = {
  ...completed,
  outcome: 'REJECTED',
  response: { status: 409, body: { error: { code: 'VERSION_CONFLICT' } } },
};

const transaction: TransactWriteCommandInput = composeBusinessTransaction({
  tableName,
  businessItems: [
    {
      Put: {
        TableName: tableName,
        Item: { PK: `CLAIM#${claimId}`, SK: 'CLAIM' },
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    },
  ],
  events: [],
  completed,
});
const prepared: PreparedClaimMutation = { transaction, completed };

type Event = { readonly kind: string; readonly args: unknown[] };

interface Script {
  readonly lookups?: (IdempotencyRecord | undefined | Error)[];
  readonly commits?: (IdempotencyRecord | Error)[];
  readonly prepared?: PreparedClaimMutation | PreparedClaimRejection | Error;
  readonly rejections?: (IdempotencyRecord | Error)[];
}

function setup(script: Script = {}) {
  const events: Event[] = [];
  const lookups = [...(script.lookups ?? [undefined])];
  const commits = [...(script.commits ?? [record])];
  const lookup: MutationLookup = {
    lookup: (...args) => {
      events.push({ kind: 'lookup', args });
      const next = lookups.shift();
      return next instanceof Error
        ? Promise.reject(next)
        : Promise.resolve(next);
    },
  };
  const committer: MutationCommitter = {
    commit: (...args) => {
      events.push({ kind: 'commit', args });
      const next = commits.shift() ?? record;
      return next instanceof Error
        ? Promise.reject(next)
        : Promise.resolve(next);
    },
  };
  const queuedRejections = [...(script.rejections ?? [])];
  const rejections: MutationRejections = {
    recordRejection: (...args) => {
      events.push({ kind: 'reject', args });
      const next = queuedRejections.shift() ?? args[0];
      return next instanceof Error
        ? Promise.reject(next)
        : Promise.resolve(next);
    },
  };
  const prepare = () => {
    events.push({ kind: 'prepare', args: [] });
    const value = 'prepared' in script ? script.prepared : prepared;
    return value instanceof Error
      ? Promise.reject(value)
      : Promise.resolve(value);
  };
  return {
    events,
    prepare,
    coordinator: new ClaimMutationCoordinator({
      lookup,
      committer,
      rejections,
    }),
  };
}

const kinds = (events: Event[]) => events.map((event) => event.kind);

describe('construction', () => {
  it.each([undefined, null, {}, { lookup: 1 }])(
    'rejects the lookup %j',
    (lookup) => {
      expect(
        () =>
          new ClaimMutationCoordinator({
            lookup: lookup as unknown as MutationLookup,
            committer: { commit: () => Promise.resolve(record) },
            rejections: { recordRejection: () => Promise.resolve(record) },
          }),
      ).toThrow(new TypeError('The idempotency lookup is missing.'));
    },
  );

  it.each([undefined, null, {}, { commit: 1 }])(
    'rejects the committer %j',
    (committer) => {
      expect(
        () =>
          new ClaimMutationCoordinator({
            lookup: { lookup: () => Promise.resolve(undefined) },
            committer: committer as unknown as MutationCommitter,
            rejections: { recordRejection: () => Promise.resolve(record) },
          }),
      ).toThrow(new TypeError('The transaction committer is missing.'));
    },
  );

  it.each([undefined, null, {}, { recordRejection: 1 }])(
    'rejects the rejection recorder %j',
    (rejections) => {
      expect(
        () =>
          new ClaimMutationCoordinator({
            lookup: { lookup: () => Promise.resolve(undefined) },
            committer: { commit: () => Promise.resolve(record) },
            rejections: rejections as unknown as MutationRejections,
          }),
      ).toThrow(new TypeError('The rejection recorder is missing.'));
    },
  );

  it('exposes only run', () => {
    expect(
      Object.getOwnPropertyNames(ClaimMutationCoordinator.prototype),
    ).toEqual(['constructor', 'run']);
  });
});

describe('run', () => {
  it('looks up, prepares once, then commits the exact prepared values once', async () => {
    const { events, prepare, coordinator } = setup();

    expect(await coordinator.run(request, prepare)).toBe(record);

    expect(kinds(events)).toEqual(['lookup', 'prepare', 'commit']);
    expect(events[0]!.args).toEqual([
      'sub-aisha',
      request.key,
      request.fingerprint,
      nowEpoch,
    ]);
    expect(events[2]!.args[0]).toBe(transaction);
    expect(events[2]!.args[1]).toBe(completed);
    expect(events[2]!.args[2]).toBe(nowEpoch);
  });

  it('returns a stored record without preparing or committing', async () => {
    const { events, prepare, coordinator } = setup({ lookups: [rejection] });

    expect(await coordinator.run(request, prepare)).toBe(rejection);
    expect(kinds(events)).toEqual(['lookup']);
  });

  it('lets a fingerprint conflict propagate without preparing', async () => {
    const conflict = new IdempotencyConflictError('conflict');
    const { events, prepare, coordinator } = setup({ lookups: [conflict] });

    await expect(coordinator.run(request, prepare)).rejects.toBe(conflict);
    expect(kinds(events)).toEqual(['lookup']);
  });

  it.each([
    ['a concurrent rejection', rejection],
    [
      'a concurrent success',
      {
        ...record,
        response: { status: 201, body: { claimId: 'other' } },
      },
    ],
  ])('returns the actual winner for %s intact', async (_name, winner) => {
    const { events, prepare, coordinator } = setup({ commits: [winner] });

    expect(await coordinator.run(request, prepare)).toBe(winner);
    expect(kinds(events)).toEqual(['lookup', 'prepare', 'commit']);
  });

  it('prepares at most once and commits at most once', async () => {
    const { events, prepare, coordinator } = setup();
    await coordinator.run(request, prepare);
    expect(events.filter((e) => e.kind === 'prepare')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'commit')).toHaveLength(1);
  });
});

describe('invalid requests', () => {
  const never = () => Promise.reject(new Error('never prepared'));

  it.each([
    ['a missing request', undefined, 'The mutation request is missing.'],
    [
      'an empty actor',
      { ...request, actorId: '' },
      'The actor ID is not valid.',
    ],
    [
      'an unsafe actor',
      { ...request, actorId: 'a b' },
      'The actor ID is not valid.',
    ],
    [
      'an empty key',
      { ...request, key: '' },
      'The idempotency key is not valid.',
    ],
    [
      'an unsafe key',
      { ...request, key: 'a b' },
      'The idempotency key is not valid.',
    ],
    [
      'a short fingerprint',
      { ...request, fingerprint: 'abc' },
      'The request fingerprint is not valid.',
    ],
    [
      'an upper-case fingerprint',
      { ...request, fingerprint: 'AB'.repeat(32) },
      'The request fingerprint is not valid.',
    ],
    [
      'a negative time',
      { ...request, nowEpoch: -1 },
      'nowEpoch must be whole Unix epoch seconds.',
    ],
    [
      'a fractional time',
      { ...request, nowEpoch: 1.5 },
      'nowEpoch must be whole Unix epoch seconds.',
    ],
  ])('refuses %s before any call', async (_name, bad, message) => {
    const { events, coordinator } = setup();

    await expect(
      coordinator.run(bad as unknown as ClaimMutationRequest, never),
    ).rejects.toThrow(message);
    expect(events).toEqual([]);
  });

  it('refuses a missing preparation callback before any call', async () => {
    const { events, coordinator } = setup();
    await expect(coordinator.run(request, undefined as never)).rejects.toThrow(
      new TypeError('The mutation preparation is missing.'),
    );
    expect(events).toEqual([]);
  });

  it('echoes no supplied value in its messages', async () => {
    const { prepare, coordinator } = setup();
    const failures = await Promise.allSettled([
      coordinator.run({ ...request, actorId: 'Secret Actor' }, prepare),
      coordinator.run({ ...request, key: 'Secret Key' }, prepare),
      coordinator.run({ ...request, fingerprint: 'Secret Print' }, prepare),
    ]);
    for (const failure of failures) {
      expect(failure.status).toBe('rejected');
      expect(String((failure as PromiseRejectedResult).reason)).not.toContain(
        'Secret',
      );
    }
  });
});

describe('invalid prepared mutations', () => {
  const withCompleted = (change: object): PreparedClaimMutation => ({
    transaction,
    completed: { ...completed, ...change },
  });

  it.each([
    [
      'another actor',
      withCompleted({ actorId: 'sub-ben' }),
      'The completed request is not for this request.',
    ],
    [
      'another key',
      withCompleted({ key: 'another-key-0001' }),
      'The completed request is not for this request.',
    ],
    [
      'another fingerprint',
      withCompleted({ fingerprint: 'cd'.repeat(32) }),
      'The completed request is not for this request.',
    ],
    [
      'a receipt reference',
      withCompleted({
        response: { status: 201, resultRef: { receiptId: 'r-7731' } },
      }),
      'A claim mutation stores a response snapshot.',
    ],
    [
      'a missing completed request',
      { transaction } as unknown as PreparedClaimMutation,
      'The completed request is missing.',
    ],
    [
      'a missing transaction',
      { completed } as unknown as PreparedClaimMutation,
      'The prepared transaction is missing.',
    ],
    [
      'a missing result',
      undefined as unknown as PreparedClaimMutation,
      'The prepared mutation is missing.',
    ],
  ])('refuses %s before committing', async (_name, bad, message) => {
    const { events, prepare, coordinator } = setup({ prepared: bad });

    await expect(coordinator.run(request, prepare)).rejects.toThrow(message);
    expect(kinds(events)).toEqual(['lookup', 'prepare']);
  });

  it('refuses an expired result before committing', async () => {
    const expired = { ...request, nowEpoch: completed.expiresAt + 1 };
    const { events, prepare, coordinator } = setup();

    await expect(coordinator.run(expired, prepare)).rejects.toThrow(
      new RangeError('The idempotency record has already expired.'),
    );
    expect(kinds(events)).toEqual(['lookup', 'prepare']);
  });

  it('accepts a result expiring exactly now', async () => {
    const exact = { ...request, nowEpoch: completed.expiresAt };
    const { events, prepare, coordinator } = setup();

    await coordinator.run(exact, prepare);
    expect(kinds(events)).toEqual(['lookup', 'prepare', 'commit']);
  });

  it.each([
    ['a malformed fingerprint', { fingerprint: 'short' }],
    ['a wrong TTL', { expiresAt: 5 }],
    ['an invalid status', { response: { status: 100, body: {} } }],
  ])(
    'refuses %s through the codec before committing',
    async (_name, change) => {
      const bad = withCompleted(change);
      const sameRequest = {
        ...request,
        fingerprint: bad.completed.fingerprint,
      };
      const { events, prepare, coordinator } = setup({ prepared: bad });

      await expect(
        coordinator.run(sameRequest, prepare),
      ).rejects.toBeInstanceOf(Error);
      expect(kinds(events)).not.toContain('commit');
    },
  );
});

describe('dependency errors', () => {
  it('propagates a lookup error unchanged, without preparing', async () => {
    const failure = new Error('lookup failed');
    const { events, prepare, coordinator } = setup({ lookups: [failure] });

    await expect(coordinator.run(request, prepare)).rejects.toBe(failure);
    expect(kinds(events)).toEqual(['lookup']);
  });

  it('propagates a preparation error unchanged, without committing', async () => {
    const failure = new Error('domain refusal');
    const { events, prepare, coordinator } = setup({ prepared: failure });

    await expect(coordinator.run(request, prepare)).rejects.toBe(failure);
    expect(kinds(events)).toEqual(['lookup', 'prepare']);
  });

  it.each([
    [
      'a cancellation',
      Object.assign(new Error('c'), { name: 'TransactionCanceledException' }),
    ],
    ['a conflict', new IdempotencyConflictError('conflict')],
    ['a programming error', new TypeError('boom')],
  ])(
    'propagates a commit error unchanged (%s), with no retry',
    async (_name, failure) => {
      const { events, prepare, coordinator } = setup({ commits: [failure] });

      await expect(coordinator.run(request, prepare)).rejects.toBe(failure);
      expect(kinds(events)).toEqual(['lookup', 'prepare', 'commit']);
    },
  );
});

describe('with the real claim writer and committer', () => {
  const change: ClaimChange = {
    claim: {
      claimId,
      employeeId: 'sub-aisha',
      categoryId: 'travel',
      amount: { amountMinor: 45_000, currency: 'MYR' },
      merchant: 'Regional Airline',
      status: 'DRAFT',
      version: 1,
      createdAt,
      updatedAt: createdAt,
    },
    history: {
      claimId,
      version: 1,
      action: 'CREATE',
      toStatus: 'DRAFT',
      actorId: 'sub-aisha',
      occurredAt: createdAt,
    },
  };

  function integration(lookups: (IdempotencyRecord | undefined)[]) {
    const sent: TransactWriteCommandInput[] = [];
    const executor = {
      execute: (input: TransactWriteCommandInput) => {
        sent.push(input);
        return Promise.resolve({ $metadata: {} } as TransactWriteCommandOutput);
      },
    };
    const queue = [...lookups];
    const lookup: MutationLookup = {
      lookup: () => Promise.resolve(queue.shift()),
    };
    const writer = new DynamoDbClaimWriter({ executor, tableName });
    const coordinator = new ClaimMutationCoordinator({
      rejections: { recordRejection: () => Promise.resolve(rejection) },
      lookup,
      committer: new DynamoDbIdempotentTransactionCommitter({
        executor,
        lookup,
      }),
    });
    return { sent, writer, coordinator };
  }

  const prepareCreate = (writer: DynamoDbClaimWriter) => () =>
    Promise.resolve({
      transaction: writer.prepareCreate(change, {
        events: [],
        idempotency: completed,
        categoryGuard: {
          categoryId: 'travel',
          readVersion: 3,
          mustBeActive: true,
        },
      }),
      completed,
    });

  it('commits a prepared claim creation through the real committer once', async () => {
    const { sent, writer, coordinator } = integration([undefined]);

    const result = await coordinator.run(request, prepareCreate(writer));

    expect(result).toEqual(record);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.TransactItems).toHaveLength(4);
    expect(sent[0]!.ClientRequestToken).toMatch(/^[0-9a-f]{32}$/);
  });

  it('replays a stored result without sending anything', async () => {
    const { sent, writer, coordinator } = integration([record]);

    expect(await coordinator.run(request, prepareCreate(writer))).toBe(record);
    expect(sent).toEqual([]);
  });
});

describe('prepared business rejections', () => {
  const rejected: RejectedIdempotencyRecord = {
    actorId: request.actorId,
    key: request.key,
    fingerprint: request.fingerprint,
    outcome: 'REJECTED',
    response: { status: 409, body: { error: { code: 'VERSION_CONFLICT' } } },
    createdAt,
    expiresAt: nowEpoch + 24 * 60 * 60,
  };
  const preparedRejection: PreparedClaimRejection = { rejection: rejected };

  it('stores the rejection once, after the lookup and one preparation, with no commit', async () => {
    const { events, prepare, coordinator } = setup({
      prepared: preparedRejection,
    });

    const result = await coordinator.run(request, prepare);

    expect(result).toBe(rejected);
    expect(kinds(events)).toEqual(['lookup', 'prepare', 'reject']);
    expect(events[2]!.args[0]).toBe(rejected);
    expect(events[2]!.args[1]).toBe(nowEpoch);
  });

  it('returns the actual record of the rejection race, including a completed winner', async () => {
    const { events, prepare, coordinator } = setup({
      prepared: preparedRejection,
      rejections: [record],
    });

    expect(await coordinator.run(request, prepare)).toBe(record);
    expect(kinds(events)).toEqual(['lookup', 'prepare', 'reject']);
  });

  it('returns a concurrent rejection winner intact', async () => {
    const other = {
      ...rejection,
      response: { status: 404, body: {} },
    } as IdempotencyRecord;
    const { prepare, coordinator } = setup({
      prepared: preparedRejection,
      rejections: [other],
    });
    expect(await coordinator.run(request, prepare)).toBe(other);
  });

  it('skips preparation and storage when a record already exists', async () => {
    const { events, prepare, coordinator } = setup({
      lookups: [rejection],
      prepared: preparedRejection,
    });

    expect(await coordinator.run(request, prepare)).toBe(rejection);
    expect(kinds(events)).toEqual(['lookup']);
  });

  it('lets a lookup conflict propagate without preparing or storing', async () => {
    const conflict = new IdempotencyConflictError('conflict');
    const { events, prepare, coordinator } = setup({
      lookups: [conflict],
      prepared: preparedRejection,
    });

    await expect(coordinator.run(request, prepare)).rejects.toBe(conflict);
    expect(kinds(events)).toEqual(['lookup']);
  });

  it('lets a rejection-race conflict propagate unchanged, with no retry', async () => {
    const conflict = new IdempotencyConflictError('conflict');
    const { events, prepare, coordinator } = setup({
      prepared: preparedRejection,
      rejections: [conflict],
    });

    await expect(coordinator.run(request, prepare)).rejects.toBe(conflict);
    expect(kinds(events)).toEqual(['lookup', 'prepare', 'reject']);
  });

  it('propagates an unresolved conditional failure unchanged, with no extra lookup', async () => {
    const failure = Object.assign(new Error('conditional'), {
      name: 'ConditionalCheckFailedException',
    });
    const { events, prepare, coordinator } = setup({
      prepared: preparedRejection,
      rejections: [failure],
    });

    await expect(coordinator.run(request, prepare)).rejects.toBe(failure);
    expect(kinds(events)).toEqual(['lookup', 'prepare', 'reject']);
  });

  it('propagates other recorder errors unchanged', async () => {
    const failure = new Error('ThrottlingException');
    const { prepare, coordinator } = setup({
      prepared: preparedRejection,
      rejections: [failure],
    });
    await expect(coordinator.run(request, prepare)).rejects.toBe(failure);
  });

  describe('refuses before any write', () => {
    it.each([
      [
        'a completed record',
        { ...rejected, outcome: 'COMPLETED' },
        'The prepared rejection must be a rejected request.',
      ],
      [
        'a missing outcome',
        { ...rejected, outcome: undefined },
        'The prepared rejection must be a rejected request.',
      ],
      [
        'another actor',
        { ...rejected, actorId: 'sub-ben' },
        'The prepared rejection is not for this request.',
      ],
      [
        'another key',
        { ...rejected, key: 'another-key-0001' },
        'The prepared rejection is not for this request.',
      ],
      [
        'another fingerprint',
        { ...rejected, fingerprint: 'cd'.repeat(32) },
        'The prepared rejection is not for this request.',
      ],
      [
        'a non-object rejection',
        'rejected',
        'The prepared rejection is missing.',
      ],
    ])('%s', async (_name, bad, message) => {
      const { events, prepare, coordinator } = setup({
        prepared: { rejection: bad } as unknown as PreparedClaimRejection,
      });

      await expect(coordinator.run(request, prepare)).rejects.toThrow(message);
      expect(kinds(events)).toEqual(['lookup', 'prepare']);
    });

    it.each([
      ['a success status', { response: { status: 200, body: {} } }],
      [
        'a reference',
        { response: { status: 201, resultRef: { receiptId: 'r-7731' } } },
      ],
      ['a short fingerprint', { fingerprint: 'short' }],
      ['a wrong TTL', { expiresAt: 5 }],
    ])('%s through the codec', async (_name, change) => {
      const bad = { ...rejected, ...change };
      const { events, prepare, coordinator } = setup({
        prepared: { rejection: bad } as unknown as PreparedClaimRejection,
      });

      await expect(coordinator.run(request, prepare)).rejects.toBeInstanceOf(
        Error,
      );
      expect(kinds(events)).toEqual(['lookup', 'prepare']);
    });

    it('an expired rejection, while accepting one expiring exactly now', async () => {
      const expired = setup({ prepared: preparedRejection });
      await expect(
        expired.coordinator.run(
          { ...request, nowEpoch: rejected.expiresAt + 1 },
          expired.prepare,
        ),
      ).rejects.toThrow(
        new RangeError('The idempotency record has already expired.'),
      );
      expect(kinds(expired.events)).toEqual(['lookup', 'prepare']);

      const exact = setup({ prepared: preparedRejection });
      await exact.coordinator.run(
        { ...request, nowEpoch: rejected.expiresAt },
        exact.prepare,
      );
      expect(kinds(exact.events)).toEqual(['lookup', 'prepare', 'reject']);
    });

    it.each([
      [
        'a rejection mixed with a transaction',
        { rejection: rejected, transaction },
      ],
      [
        'a rejection mixed with a completed request',
        { rejection: rejected, completed },
      ],
      [
        'a rejection mixed with a full mutation',
        { rejection: rejected, transaction, completed },
      ],
    ])('%s', async (_name, mixed) => {
      const { events, prepare, coordinator } = setup({
        prepared: mixed as unknown as PreparedClaimRejection,
      });

      await expect(coordinator.run(request, prepare)).rejects.toThrow(
        'The prepared mutation mixes a rejection and a transaction.',
      );
      expect(kinds(events)).toEqual(['lookup', 'prepare']);
    });

    it('an empty preparation, as before', async () => {
      const { events, prepare, coordinator } = setup({
        prepared: {} as unknown as PreparedClaimMutation,
      });

      await expect(coordinator.run(request, prepare)).rejects.toThrow(
        'The prepared transaction is missing.',
      );
      expect(kinds(events)).toEqual(['lookup', 'prepare']);
    });

    it('echoes no supplied value in its messages', async () => {
      const failures = await Promise.allSettled(
        [
          { ...rejected, actorId: 'Secret Actor' },
          { ...rejected, key: 'Secret Key' },
          { ...rejected, outcome: 'Secret Outcome' },
        ].map((bad) => {
          const { prepare, coordinator } = setup({
            prepared: { rejection: bad } as unknown as PreparedClaimRejection,
          });
          return coordinator.run(request, prepare);
        }),
      );
      for (const failure of failures) {
        expect(failure.status).toBe('rejected');
        expect(String((failure as PromiseRejectedResult).reason)).not.toContain(
          'Secret',
        );
      }
    });
  });

  it('leaves the success path unchanged: a transaction is committed and nothing is stored as a rejection', async () => {
    const { events, prepare, coordinator } = setup();

    expect(await coordinator.run(request, prepare)).toBe(record);
    expect(kinds(events)).toEqual(['lookup', 'prepare', 'commit']);
  });
});
