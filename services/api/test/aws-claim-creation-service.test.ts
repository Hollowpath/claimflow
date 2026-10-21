import type {
  TransactWriteCommandInput,
  TransactWriteCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import type { Actor, Category } from '@claimflow/domain';
import { describe, expect, it } from 'vitest';

import {
  AwsClaimCreationService,
  ClaimCreationIntegrityError,
  type AwsClaimCreationServiceDependencies,
  type ClaimCreationContext,
} from '../src/adapters/aws/aws-claim-creation-service.js';
import { ClaimMutationCoordinator } from '../src/adapters/aws/claim-mutation-coordinator.js';
import { DynamoDbClaimWriter } from '../src/adapters/aws/dynamodb-claim-writer.js';
import { DynamoDbIdempotencyCoordinator } from '../src/adapters/aws/dynamodb-idempotency-coordinator.js';
import {
  decodeIdempotencyItem,
  encodeIdempotencyItem,
  idempotencyKey,
  type IdempotencyRecord,
} from '../src/adapters/aws/dynamodb-idempotency-items.js';
import { DynamoDbIdempotentTransactionCommitter } from '../src/adapters/aws/dynamodb-idempotent-transaction-committer.js';
import { ItemEncodingError } from '../src/adapters/aws/dynamodb-items.js';
import { ClaimService } from '../src/application/claim-service.js';
import { toEpochSeconds } from '../src/application/commit.js';
import type {
  CategoryRepository,
  UserProfile,
} from '../src/application/ports.js';

const tableName = 'ClaimFlow';
const claimId = '4ce0c74b-9c64-46d6-87ba-07fb71b0628c';
const now = '2026-10-14T10:41:00.000Z';
const nowEpoch = toEpochSeconds(new Date(now));

const actor: Actor = {
  userId: 'sub-aisha',
  displayName: 'Aisha Rahman',
  roles: ['EMPLOYEE'],
  managerId: 'sub-ben',
};
const travel: Category = {
  categoryId: 'travel',
  name: 'Travel',
  active: true,
  currency: 'MYR',
  maxAmountMinor: 200_000,
  receiptRequiredAboveMinor: 20_000,
  version: 3,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedBy: 'sub-dan',
};
const profiles: UserProfile[] = [
  {
    userId: 'sub-aisha',
    displayName: 'Aisha Rahman',
    title: 'Sales',
    roles: ['EMPLOYEE'],
    managerId: 'sub-ben',
  },
  {
    userId: 'sub-ben',
    displayName: 'Ben Tan',
    title: 'Manager',
    roles: ['MANAGER'],
  },
];

const categorizedInput = {
  categoryId: 'travel',
  amount: { amountMinor: 45_000, currency: 'MYR' },
  expenseDate: '2026-10-08',
  merchant: 'Regional Airline',
  businessPurpose: 'Client workshop',
};
const uncategorizedInput = {
  merchant: 'Regional Airline',
  businessPurpose: 'Client workshop',
};

const context: ClaimCreationContext = {
  idempotencyKey: '5b0d6a8e-retry-key',
  fingerprint: 'ab'.repeat(32),
  now,
  requestId: 'request-1',
};

const cancelled = () =>
  Object.assign(new Error('cancelled'), {
    name: 'TransactionCanceledException',
  });

/** Counts every dependency call, so a replay can be shown to make none. */
function build(
  overrides: {
    getStored?: () => Promise<unknown>;
    getMany?: () => Promise<readonly UserProfile[]>;
    newId?: () => string;
    execute?: (input: TransactWriteCommandInput) => Promise<void>;
    prepareCreate?: DynamoDbClaimWriter['prepareCreate'];
    /** Answers for the first idempotency lookups, before the store does. */
    finds?: (IdempotencyRecord | undefined)[];
    /** Answers for the claim rereads of recovery (default: absent). */
    claimGets?: unknown[];
    random?: number;
  } = {},
) {
  const calls = { getStored: 0, list: 0, getMany: 0, newId: 0, claimGet: 0 };
  const sleeps: number[] = [];
  const logs: { level: string; event: string; fields: unknown }[] = [];
  const claimGets = [...(overrides.claimGets ?? [])];
  const sent: TransactWriteCommandInput[] = [];
  const store = new Map<string, IdempotencyRecord>();
  const keyOf = (record: { actorId: string; key: string }) =>
    idempotencyKey(record.actorId, record.key).PK;

  const executor = {
    execute: async (input: TransactWriteCommandInput) => {
      sent.push(input);
      await overrides.execute?.(input);
      const last = input.TransactItems!.at(-1)!.Put!.Item!;
      store.set(String(last.PK), decodeIdempotencyItem(last));
      return { $metadata: {} } as TransactWriteCommandOutput;
    },
  };
  const finds = [...(overrides.finds ?? [])];
  const finder = {
    find: (actorId: string, key: string) =>
      finds.length > 0
        ? Promise.resolve(finds.shift())
        : Promise.resolve(store.get(idempotencyKey(actorId, key).PK)),
  };
  const rejectionWriter = {
    recordRejection: (
      record: Parameters<typeof keyOf>[0] & IdempotencyRecord,
    ) => {
      encodeIdempotencyItem(record);
      if (store.has(keyOf(record))) {
        return Promise.reject(
          Object.assign(new Error('exists'), {
            name: 'ConditionalCheckFailedException',
          }),
        );
      }
      store.set(keyOf(record), record);
      return Promise.resolve();
    },
  };
  const idempotency = new DynamoDbIdempotencyCoordinator({
    finder,
    rejections: rejectionWriter,
  });
  const writer = new DynamoDbClaimWriter({ executor, tableName });
  const mutations = new ClaimMutationCoordinator({
    lookup: idempotency,
    committer: new DynamoDbIdempotentTransactionCommitter({
      executor,
      lookup: idempotency,
    }),
    rejections: idempotency,
  });
  const deps: AwsClaimCreationServiceDependencies = {
    mutations,
    categories: {
      getStored: (async (categoryId: string) => {
        calls.getStored += 1;
        if (overrides.getStored !== undefined) {
          return overrides.getStored();
        }
        return categoryId === 'travel'
          ? { category: travel, metadata: { claimCount: 2 } }
          : undefined;
      }) as never,
      list: () => {
        calls.list += 1;
        return Promise.resolve([travel]);
      },
    },
    users: {
      get: () => Promise.resolve(undefined),
      getMany: () => {
        calls.getMany += 1;
        return overrides.getMany?.() ?? Promise.resolve(profiles);
      },
    },
    claims: {
      prepareCreate: (change, options) =>
        overrides.prepareCreate?.(change, options) ??
        writer.prepareCreate(change, options),
    },
    claimReader: {
      get: () => {
        calls.claimGet += 1;
        return Promise.resolve(claimGets.shift() as never);
      },
    },
    ids: {
      newId: () => {
        calls.newId += 1;
        return overrides.newId?.() ?? claimId;
      },
    },
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => overrides.random ?? 0.5,
    logger: {
      info: (event, fields) => logs.push({ level: 'info', event, fields }),
      warn: (event, fields) => logs.push({ level: 'warn', event, fields }),
      error: (event, fields) => logs.push({ level: 'error', event, fields }),
    },
  };
  return {
    calls,
    sent,
    sleeps,
    logs,
    store,
    service: new AwsClaimCreationService(deps),
    deps,
  };
}

const noCalls = (calls: ReturnType<typeof build>['calls']) =>
  expect(calls).toEqual({
    getStored: 0,
    list: 0,
    getMany: 0,
    newId: 0,
    claimGet: 0,
  });

describe('construction', () => {
  it.each([
    ['mutations', 'The mutation coordinator is missing.'],
    ['categories', 'The category reader is missing.'],
    ['users', 'The user directory is missing.'],
    ['claims', 'The claim writer is missing.'],
    ['ids', 'The ID generator is missing.'],
    ['claimReader', 'The claim reader is missing.'],
    ['sleep', 'The sleep function is missing.'],
    ['random', 'The random function is missing.'],
    ['logger', 'The logger is missing.'],
  ])('rejects missing %s', (name, message) => {
    const { deps } = build();
    expect(
      () =>
        new AwsClaimCreationService({
          ...deps,
          [name]: undefined,
        }),
    ).toThrow(new TypeError(message));
  });
});

describe('successful creation', () => {
  it('commits a categorized claim with its snapshot, guard, and no events', async () => {
    const { sent, store, service, calls } = build();

    const record = await service.create(actor, categorizedInput, context);

    expect(record).toMatchObject({
      actorId: 'sub-aisha',
      key: context.idempotencyKey,
      fingerprint: context.fingerprint,
      outcome: 'COMPLETED',
      createdAt: now,
      expiresAt: nowEpoch + 24 * 60 * 60,
      response: { status: 201 },
    });
    expect(
      store.get(idempotencyKey('sub-aisha', context.idempotencyKey).PK),
    ).toEqual(record);
    expect(sent).toHaveLength(1);
    const items = sent[0]!.TransactItems!;
    expect(items.map((item) => Object.keys(item)[0])).toEqual([
      'Put',
      'Put',
      'Update',
      'Put',
    ]);
    expect(items[0]!.Put!.Item).toMatchObject({
      PK: `CLAIM#${claimId}`,
      employeeId: 'sub-aisha',
      status: 'DRAFT',
    });
    expect(items[2]!.Update!.Key).toEqual({
      PK: 'CATEGORIES',
      SK: 'CATEGORY#travel',
    });
    expect(items[2]!.Update!.ExpressionAttributeValues).toMatchObject({
      ':readVersion': 3,
      ':true': true,
    });
    expect(JSON.stringify(items)).not.toContain('OUTBOX#');
    expect(calls).toMatchObject({ getStored: 1, newId: 1, getMany: 1 });
  });

  it('commits an uncategorized claim without a category operation', async () => {
    const { sent, service, calls } = build();

    const record = await service.create(actor, uncategorizedInput, context);

    expect(record.outcome).toBe('COMPLETED');
    expect(sent[0]!.TransactItems).toHaveLength(3);
    expect(JSON.stringify(sent[0])).not.toContain('CATEGORIES');
    expect(calls.getStored).toBe(0);
  });

  it('stores exactly the 201 body that the current create route returns', async () => {
    const { service } = build();
    const record = await service.create(actor, categorizedInput, context);

    const existing = new ClaimService({
      claims: { create: () => Promise.resolve() } as never,
      categories: {
        get: (id: string) =>
          Promise.resolve(id === 'travel' ? travel : undefined),
        list: () => Promise.resolve([travel]),
      } as unknown as CategoryRepository,
      users: {
        get: () => Promise.resolve(undefined),
        getMany: () => Promise.resolve(profiles),
      },
      receipts: {} as never,
      clock: { now: () => new Date(now) },
      ids: { newId: () => claimId },
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    }).create(actor, categorizedInput);

    expect(record.response).toEqual({ status: 201, body: await existing });
  });

  it('takes the identity only from the actor', async () => {
    const { sent, service } = build();
    await service.create(
      { ...actor, userId: 'sub-other' },
      categorizedInput,
      context,
    );
    expect(sent[0]!.TransactItems![0]!.Put!.Item!.employeeId).toBe('sub-other');

    const smuggled = build();
    const record = await smuggled.service.create(
      actor,
      { ...categorizedInput, employeeId: 'sub-ben' },
      context,
    );
    expect(record.outcome).toBe('REJECTED');
    expect(smuggled.sent).toEqual([]);
  });

  it('generates the claim ID only inside preparation', async () => {
    const { calls, service } = build();
    await service.create(actor, categorizedInput, context);
    expect(calls.newId).toBe(1);
  });
});

describe('replay', () => {
  it('returns the stored record without parsing, reading, generating, or presenting', async () => {
    const { calls, sent, service } = build();
    const first = await service.create(actor, categorizedInput, context);
    const before = { ...calls };

    const replay = await service.create(actor, { not: 'even valid' }, context);

    expect(replay).toEqual(first);
    expect(calls).toEqual(before);
    expect(sent).toHaveLength(1);
  });

  it('returns a stored rejection without running anything', async () => {
    const { calls, sent, service } = build();
    const first = await service.create(actor, { bogus: true }, context);
    expect(first.outcome).toBe('REJECTED');
    noCalls(calls);

    const replay = await service.create(actor, categorizedInput, context);

    expect(replay).toEqual(first);
    noCalls(calls);
    expect(sent).toEqual([]);
  });

  it('refuses another fingerprint under the same key', async () => {
    const { service } = build();
    await service.create(actor, categorizedInput, context);
    await expect(
      service.create(actor, categorizedInput, {
        ...context,
        fingerprint: 'cd'.repeat(32),
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
});

describe('business rejections', () => {
  it('stores a schema rejection with the safe error mapping and request ID', async () => {
    const { calls, sent, store, service } = build();

    const record = await service.create(actor, { amount: 'a lot' }, context);

    expect(record).toMatchObject({
      outcome: 'REJECTED',
      actorId: 'sub-aisha',
      key: context.idempotencyKey,
      fingerprint: context.fingerprint,
      createdAt: now,
      expiresAt: nowEpoch + 24 * 60 * 60,
      response: {
        status: 400,
        body: {
          error: {
            code: 'VALIDATION_FAILED',
            message: 'The request is not valid.',
            requestId: 'request-1',
          },
        },
      },
    });
    expect(store.size).toBe(1);
    expect(sent).toEqual([]);
    expect(calls).toEqual({
      getStored: 0,
      list: 0,
      getMany: 0,
      newId: 0,
      claimGet: 0,
    });
  });

  it('stores a domain rejection for a non-employee, without committing', async () => {
    const { sent, service } = build();

    const record = await service.create(
      { ...actor, roles: ['MANAGER'] },
      categorizedInput,
      context,
    );

    expect(record).toMatchObject({
      outcome: 'REJECTED',
      response: {
        status: 403,
        body: { error: { code: 'FORBIDDEN', requestId: 'request-1' } },
      },
    });
    expect(sent).toEqual([]);
  });

  it.each([
    ['an unknown category', { ...categorizedInput, categoryId: 'unknown' }],
    [
      'a future expense date',
      { ...categorizedInput, expenseDate: '2030-01-01' },
    ],
  ])('stores a client-error rejection for %s', async (_name, input) => {
    const { sent, service } = build();

    const record = await service.create(actor, input, context);

    expect(record.outcome).toBe('REJECTED');
    expect(record.response.status).toBeGreaterThanOrEqual(400);
    expect(record.response.status).toBeLessThan(500);
    expect(sent).toEqual([]);
  });
});

describe('concurrent winners', () => {
  it('returns the winner of a lost commit race, not this request', async () => {
    const winner: IdempotencyRecord = {
      actorId: 'sub-aisha',
      key: context.idempotencyKey,
      fingerprint: context.fingerprint,
      outcome: 'COMPLETED',
      response: { status: 201, body: { claimId: 'the-winner' } },
      createdAt: now,
      expiresAt: nowEpoch + 24 * 60 * 60,
    };
    const harness = build({
      execute: (input) => {
        harness.store.set(
          String(input.TransactItems!.at(-1)!.Put!.Item!.PK),
          winner,
        );
        return Promise.reject(cancelled());
      },
    });

    const record = await harness.service.create(
      actor,
      categorizedInput,
      context,
    );

    expect(record).toBe(winner);
    expect(harness.sent).toHaveLength(1);
  });

  it('returns a concurrent completed winner of a rejection race', async () => {
    const winner: IdempotencyRecord = {
      actorId: 'sub-aisha',
      key: context.idempotencyKey,
      fingerprint: context.fingerprint,
      outcome: 'COMPLETED',
      response: { status: 201, body: { claimId: 'the-winner' } },
      createdAt: now,
      expiresAt: nowEpoch + 24 * 60 * 60,
    };
    const harness = build();
    const original = harness.deps.categories.getStored;
    // The concurrent request commits while this one is being decided.
    (harness.deps.categories as { getStored: unknown }).getStored = (
      id: string,
    ) => {
      harness.store.set(
        idempotencyKey('sub-aisha', context.idempotencyKey).PK,
        winner,
      );
      return original(id);
    };

    const record = await harness.service.create(
      actor,
      { ...categorizedInput, categoryId: 'unknown' },
      context,
    );

    expect(record).toBe(winner);
    expect(harness.sent).toEqual([]);
  });
});

describe('infrastructure failures', () => {
  it.each([
    [
      'a category read',
      { getStored: () => Promise.reject(new Error('read failed')) },
      'read failed',
    ],
    [
      'a user read',
      { getMany: () => Promise.reject(new Error('users failed')) },
      'users failed',
    ],
    [
      'the ID generator',
      {
        newId: () => {
          throw new Error('ids failed');
        },
      },
      'ids failed',
    ],
    [
      'the claim preparation',
      {
        prepareCreate: () => {
          throw new TypeError('cannot prepare');
        },
      },
      'cannot prepare',
    ],
  ])(
    'propagates a failure of %s unchanged and stores nothing',
    async (_name, override, message) => {
      const { sent, store, service } = build(override);

      await expect(
        service.create(actor, categorizedInput, context),
      ).rejects.toThrow(message);
      expect(store.size).toBe(0);
      expect(sent).toEqual([]);
    },
  );

  it('does not turn a codec failure into a rejection', async () => {
    const { sent, store, service } = build({ newId: () => 'not a valid id!' });

    await expect(
      service.create(actor, categorizedInput, context),
    ).rejects.toBeInstanceOf(Error);
    expect(store.size).toBe(0);
    expect(sent).toEqual([]);
  });

  it('propagates a non-ambiguous transaction failure unchanged, with no rejection', async () => {
    const failure = Object.assign(new Error('bad request'), {
      name: 'ValidationException',
    });
    const { store, sent, service } = build({
      execute: () => Promise.reject(failure),
    });

    await expect(service.create(actor, categorizedInput, context)).rejects.toBe(
      failure,
    );
    expect(sent).toHaveLength(1);
    expect(store.size).toBe(0);
  });

  it('keeps ItemEncodingError out of the business catch', () => {
    expect(new ItemEncodingError('k', 'p')).not.toHaveProperty('code');
  });
});

describe('invalid requests', () => {
  it.each([
    [
      'an actor without an ID',
      { ...actor, userId: '' },
      context,
      'The actor is not valid.',
    ],
    ['a missing context', actor, undefined, 'The request context is missing.'],
    [
      'an invalid key',
      actor,
      { ...context, idempotencyKey: 'a b' },
      'The idempotency key is not valid.',
    ],
    [
      'an invalid fingerprint',
      actor,
      { ...context, fingerprint: 'abc' },
      'The request fingerprint is not valid.',
    ],
    [
      'a non-canonical time',
      actor,
      { ...context, now: '2026-10-14' },
      'The request time is not valid.',
    ],
    [
      'an invalid request ID',
      actor,
      { ...context, requestId: 'a b' },
      'The request ID is not valid.',
    ],
  ])('refuses %s before any dependency call', (_name, who, ctx, message) => {
    const { calls, sent, service } = build();

    expect(() =>
      service.create(who, categorizedInput, ctx as ClaimCreationContext),
    ).toThrow(new TypeError(message));
    noCalls(calls);
    expect(sent).toEqual([]);
  });

  it('echoes no supplied value in its messages', () => {
    const { service } = build();
    for (const bad of [
      { ...context, idempotencyKey: 'Secret Key' },
      { ...context, fingerprint: 'Secret Print' },
      { ...context, requestId: 'Secret Request' },
    ]) {
      expect(() => service.create(actor, categorizedInput, bad)).toThrow(
        expect.objectContaining({
          message: expect.not.stringContaining('Secret'),
        }),
      );
    }
  });
});

describe('cancellation recovery', () => {
  const stored = (patch: Partial<Category> = {}) => ({
    category: { ...travel, ...patch },
    metadata: { claimCount: 2 },
  });
  /** Cancels the first `count` transactions, then lets them commit. */
  const cancelFirst = (count: number) => {
    let sends = 0;
    return () => {
      sends += 1;
      return sends <= count ? Promise.reject(cancelled()) : Promise.resolve();
    };
  };
  const guardVersion = (input: TransactWriteCommandInput) =>
    input.TransactItems!.find((item) => item.Update !== undefined)!.Update!
      .ExpressionAttributeValues![':readVersion'];
  const claimIdOf = (input: TransactWriteCommandInput) =>
    input.TransactItems![0]!.Put!.Item!.claimId;
  const existingClaim = {
    claimId,
    employeeId: 'sub-other',
    status: 'DRAFT',
    version: 1,
    createdAt: now,
    updatedAt: now,
  } as never;
  const winner: IdempotencyRecord = {
    actorId: 'sub-aisha',
    key: context.idempotencyKey,
    fingerprint: context.fingerprint,
    outcome: 'COMPLETED',
    response: { status: 201, body: { claimId: 'the-winner' } },
    createdAt: now,
    expiresAt: nowEpoch + 24 * 60 * 60,
  };

  describe('unchanged state', () => {
    it('retries an uncategorized creation after a backoff and commits', async () => {
      const { calls, sent, sleeps, logs, service } = build({
        execute: cancelFirst(1),
      });

      const record = await service.create(actor, uncategorizedInput, context);

      expect(record.outcome).toBe('COMPLETED');
      expect(sent).toHaveLength(2);
      expect(claimIdOf(sent[1]!)).toBe(claimIdOf(sent[0]!));
      expect(sleeps).toEqual([37]);
      expect(calls).toMatchObject({ newId: 1, claimGet: 1, getStored: 0 });
      expect(logs).toEqual([
        {
          level: 'info',
          event: 'claim.create.retry',
          fields: { operation: 'claim.create', retries: 1 },
        },
      ]);
    });

    it('retries a categorized creation with the same category and guard', async () => {
      const { calls, sent, service } = build({
        getStored: reads2(stored(), stored()),
        execute: cancelFirst(1),
      });

      const record = await service.create(actor, categorizedInput, context);

      expect(record.outcome).toBe('COMPLETED');
      expect(sent).toHaveLength(2);
      expect(guardVersion(sent[1]!)).toBe(3);
      expect(claimIdOf(sent[1]!)).toBe(claimIdOf(sent[0]!));
      expect(calls).toMatchObject({ newId: 1, getStored: 2, claimGet: 1 });
    });

    it('rebuilds the presentation and derives the token normally on a retry', async () => {
      const { calls, sent, service } = build({
        getStored: reads2(stored(), stored()),
        execute: cancelFirst(1),
      });

      await service.create(actor, categorizedInput, context);

      expect(calls.getMany).toBe(2);
      expect(sent[1]!.ClientRequestToken).toMatch(/^[0-9a-f]{32}$/);
      // The rebuilt payload is identical, so its token is too.
      expect(sent[1]!.ClientRequestToken).toBe(sent[0]!.ClientRequestToken);
    });

    it('never commits more than three prepared transactions', async () => {
      const original = cancelled();
      const { calls, sent, sleeps, logs, service } = build({
        getStored: reads2(stored(), stored(), stored(), stored()),
        execute: () => Promise.reject(original),
      });

      await expect(
        service.create(actor, categorizedInput, context),
      ).rejects.toBe(original);

      expect(sent).toHaveLength(3);
      expect(sleeps).toHaveLength(2);
      // The creation's read, one reread per recovery, and the final check.
      expect(calls.getStored).toBe(4);
      expect(calls.claimGet).toBe(3);
      expect(logs.at(-1)).toEqual({
        level: 'warn',
        event: 'claim.create.retries_exhausted',
        fields: { operation: 'claim.create', retries: 2 },
      });
    });

    it('rethrows an unresolved cancellation unchanged, never as a version conflict', async () => {
      const failures = [cancelled(), cancelled(), cancelled()];
      let sends = 0;
      const { store, service } = build({
        getStored: reads2(stored(), stored(), stored(), stored()),
        execute: () => Promise.reject(failures[sends++] ?? cancelled()),
      });

      await expect(
        service.create(actor, categorizedInput, context),
      ).rejects.toBe(failures[2]);
      expect(store.size).toBe(0);
    });

    it('never inspects cancellation reasons', async () => {
      const withReasons = Object.assign(cancelled(), {
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
      });
      const { sent, service } = build({
        execute: () => Promise.reject(withReasons),
      });

      await expect(
        service.create(actor, uncategorizedInput, context),
      ).rejects.toBe(withReasons);
      expect(sent).toHaveLength(3);
    });

    it('does not recover other errors', async () => {
      const failure = Object.assign(new Error('bad request'), {
        name: 'ValidationException',
      });
      const { calls, sent, sleeps, service } = build({
        execute: () => Promise.reject(failure),
      });

      await expect(
        service.create(actor, categorizedInput, context),
      ).rejects.toBe(failure);
      expect(sent).toHaveLength(1);
      expect(sleeps).toEqual([]);
      expect(calls.getStored).toBe(1);
      expect(calls.claimGet).toBe(0);
    });
  });

  describe('backoff', () => {
    it.each([
      [0, [25, 50]],
      [0.5, [37, 75]],
      [0.999, [49, 99]],
    ])('is bounded and exponential for jitter %s', async (random, expected) => {
      const { sleeps, service } = build({
        random,
        execute: cancelFirst(2),
      });

      await service.create(actor, uncategorizedInput, context);

      expect(sleeps).toEqual(expected);
    });

    it('never exceeds the ceiling, whatever the random source returns', async () => {
      for (const random of [-1, 5, Number.NaN, Number.POSITIVE_INFINITY]) {
        const { sleeps, service } = build({ random, execute: cancelFirst(2) });
        await service.create(actor, uncategorizedInput, context);
        expect(sleeps).toHaveLength(2);
        expect(sleeps[0]).toBeGreaterThanOrEqual(25);
        expect(sleeps[0]).toBeLessThanOrEqual(50);
        expect(sleeps[1]).toBeGreaterThanOrEqual(50);
        expect(sleeps[1]).toBeLessThanOrEqual(100);
      }
    });

    it('does not wait when there is nothing to recover', async () => {
      const { sleeps, service } = build();
      await service.create(actor, uncategorizedInput, context);
      expect(sleeps).toEqual([]);
    });

    it('logs only the operation and the retry count', async () => {
      const { logs, service } = build({ execute: cancelFirst(2) });
      await service.create(actor, categorizedInput, context);
      expect(logs.map((entry) => entry.fields)).toEqual([
        { operation: 'claim.create', retries: 1 },
        { operation: 'claim.create', retries: 2 },
      ]);
      expect(JSON.stringify(logs)).not.toContain('sub-aisha');
      expect(JSON.stringify(logs)).not.toContain(claimId);
      expect(JSON.stringify(logs)).not.toContain(context.idempotencyKey);
    });
  });

  describe('category changes', () => {
    it('rebuilds and commits once for a changed but valid category, with the same claim ID and a new guard and token', async () => {
      const { calls, sent, service } = build({
        getStored: reads2(
          stored(),
          stored({ version: 4, maxAmountMinor: 300_000 }),
        ),
        execute: cancelFirst(1),
      });

      const record = await service.create(actor, categorizedInput, context);

      expect(record.outcome).toBe('COMPLETED');
      expect(sent).toHaveLength(2);
      expect(guardVersion(sent[0]!)).toBe(3);
      expect(guardVersion(sent[1]!)).toBe(4);
      expect(claimIdOf(sent[1]!)).toBe(claimIdOf(sent[0]!));
      expect(sent[1]!.ClientRequestToken).not.toBe(sent[0]!.ClientRequestToken);
      expect(record.response).toMatchObject({ status: 201, body: { claimId } });
      expect(record).toMatchObject({
        createdAt: now,
        expiresAt: nowEpoch + 24 * 60 * 60,
        key: context.idempotencyKey,
        fingerprint: context.fingerprint,
      });
      expect(calls).toMatchObject({ newId: 1, getStored: 2, getMany: 2 });
    });

    it.each([
      ['a deactivated category', stored({ version: 4, active: false })],
      ['a deleted category', undefined],
    ])(
      'stores the normal business rejection for %s, without another commit',
      async (_name, reread) => {
        const { calls, sent, store, service } = build({
          getStored: reads2(stored(), reread),
          execute: cancelFirst(1),
        });

        const record = await service.create(actor, categorizedInput, context);

        expect(record.outcome).toBe('REJECTED');
        expect(record.response.status).toBeGreaterThanOrEqual(400);
        expect(record.response.status).toBeLessThan(500);
        expect(
          store.get(idempotencyKey('sub-aisha', context.idempotencyKey).PK),
        ).toEqual(record);
        expect(sent).toHaveLength(1);
        expect(calls.newId).toBe(1);
      },
    );

    it('stores a version conflict when the category changes a second time', async () => {
      const { calls, sent, store, service } = build({
        getStored: reads2(
          stored(),
          stored({ version: 4 }),
          stored({ version: 5 }),
        ),
        execute: cancelFirst(2),
      });

      const record = await service.create(actor, categorizedInput, context);

      expect(record).toMatchObject({
        outcome: 'REJECTED',
        response: {
          status: 409,
          body: { error: { code: 'VERSION_CONFLICT', requestId: 'request-1' } },
        },
      });
      expect(store.size).toBe(1);
      expect(sent).toHaveLength(2);
      expect(calls.getStored).toBe(3);
      expect(calls.newId).toBe(1);
    });

    it('stores a version conflict when the category disappears after the change', async () => {
      const { sent, service } = build({
        getStored: reads2(stored(), stored({ version: 4 }), undefined),
        execute: cancelFirst(2),
      });

      const record = await service.create(actor, categorizedInput, context);

      expect(record.response.status).toBe(409);
      expect(sent).toHaveLength(2);
    });

    it('counts a category rebuild toward the three attempts, then retries unchanged state', async () => {
      const original = cancelled();
      const { calls, sent, service } = build({
        getStored: reads2(
          stored(),
          stored({ version: 4 }),
          stored({ version: 4 }),
          stored({ version: 4 }),
        ),
        execute: () => Promise.reject(original),
      });

      await expect(
        service.create(actor, categorizedInput, context),
      ).rejects.toBe(original);

      expect(sent).toHaveLength(3);
      expect(guardVersion(sent[1]!)).toBe(4);
      expect(guardVersion(sent[2]!)).toBe(4);
      expect(calls.getStored).toBe(4);
    });

    describe('a category change found at exhaustion', () => {
      const exhausted = (
        final: unknown,
        earlier: unknown[] = [stored(), stored(), stored()],
      ) => {
        const original = cancelled();
        const harness = build({
          getStored: reads2(...earlier, final),
          execute: () => Promise.reject(original),
        });
        return { original, ...harness };
      };

      it.each([
        ['a deleted category', undefined],
        ['a deactivated category', stored({ version: 4, active: false })],
      ])(
        'persists the normal business rejection for %s, not a version conflict',
        async (_name, final) => {
          const { sent, store, calls, service } = exhausted(final);

          const record = await service.create(actor, categorizedInput, context);

          expect(record.outcome).toBe('REJECTED');
          expect(record.response.status).toBeGreaterThanOrEqual(400);
          expect(record.response.status).toBeLessThan(500);
          expect(record.response).not.toMatchObject({
            body: { error: { code: 'VERSION_CONFLICT' } },
          });
          expect(store.size).toBe(1);
          expect(sent).toHaveLength(3);
          expect(calls.newId).toBe(1);
        },
      );

      it('rethrows the unresolved cancellation, with no fourth commit and no conflict, when the new category is valid', async () => {
        const { original, sent, store, logs, calls, service } = exhausted(
          stored({ version: 9, maxAmountMinor: 300_000 }),
        );

        await expect(
          service.create(actor, categorizedInput, context),
        ).rejects.toBe(original);

        expect(sent).toHaveLength(3);
        expect(store.size).toBe(0);
        expect(logs.at(-1)).toEqual({
          level: 'warn',
          event: 'claim.create.retries_exhausted',
          fields: { operation: 'claim.create', retries: 2 },
        });
        // Only the decision is re-run: nothing is presented or prepared again.
        expect(calls.getMany).toBe(3);
        expect(calls.newId).toBe(1);
      });

      it('persists a version conflict when an earlier change was already re-evaluated', async () => {
        const { sent, store, service } = exhausted(stored({ version: 9 }), [
          stored(),
          stored({ version: 4 }),
          stored({ version: 4 }),
        ]);

        const record = await service.create(actor, categorizedInput, context);

        expect(record).toMatchObject({
          outcome: 'REJECTED',
          response: {
            status: 409,
            body: { error: { code: 'VERSION_CONFLICT' } },
          },
        });
        expect(store.size).toBe(1);
        expect(sent).toHaveLength(3);
      });

      it('returns a winner before any of these decisions', async () => {
        const winner: IdempotencyRecord = {
          actorId: 'sub-aisha',
          key: context.idempotencyKey,
          fingerprint: context.fingerprint,
          outcome: 'COMPLETED',
          response: { status: 201, body: { claimId: 'the-winner' } },
          createdAt: now,
          expiresAt: nowEpoch + 24 * 60 * 60,
        };
        const { service } = build({
          getStored: reads2(stored(), stored(), stored(), undefined),
          execute: () => Promise.reject(cancelled()),
          finds: [
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            winner,
          ],
        });

        expect(await service.create(actor, categorizedInput, context)).toBe(
          winner,
        );
      });
    });
  });

  describe('claim ID collision', () => {
    it('is an integrity failure: no overwrite, no new ID, no rejection', async () => {
      const { calls, sent, store, service } = build({
        claimGets: [existingClaim],
        execute: cancelFirst(1),
      });

      const failure = await service
        .create(actor, uncategorizedInput, context)
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ClaimCreationIntegrityError);
      expect((failure as Error).message).toBe(
        'The generated claim ID is already in use.',
      );
      expect(String(failure)).not.toContain(claimId);
      expect(sent).toHaveLength(1);
      expect(store.size).toBe(0);
      expect(calls.newId).toBe(1);
    });

    it('is also detected by the final check', async () => {
      const { sent, store, service } = build({
        claimGets: [undefined, undefined, existingClaim],
        execute: () => Promise.reject(cancelled()),
      });

      await expect(
        service.create(actor, uncategorizedInput, context),
      ).rejects.toBeInstanceOf(ClaimCreationIntegrityError);
      expect(sent).toHaveLength(3);
      expect(store.size).toBe(0);
    });
  });

  describe('concurrent requests', () => {
    // Lookups, in order: the run, the committer after the cancellation, then
    // the recheck of the recovery run.
    it('returns a winner found by the recheck before any state is reread', async () => {
      const { calls, sent, service } = build({
        execute: cancelFirst(1),
        finds: [undefined, undefined, winner],
      });

      expect(await service.create(actor, categorizedInput, context)).toBe(
        winner,
      );
      expect(sent).toHaveLength(1);
      expect(calls.getStored).toBe(1);
      expect(calls.claimGet).toBe(0);
    });

    it('lets a fingerprint conflict found by the recheck propagate', async () => {
      const { calls, service } = build({
        execute: cancelFirst(1),
        finds: [
          undefined,
          undefined,
          { ...winner, fingerprint: 'cd'.repeat(32) },
        ],
      });

      await expect(
        service.create(actor, categorizedInput, context),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      expect(calls.getStored).toBe(1);
    });

    it('returns a winner found after the final cancellation, before exhaustion', async () => {
      const { calls, sent, logs, service } = build({
        getStored: reads2(stored(), stored(), stored()),
        execute: () => Promise.reject(cancelled()),
        // run, committer, recovery 1, committer, recovery 2, committer, final.
        finds: [
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          winner,
        ],
      });

      expect(await service.create(actor, categorizedInput, context)).toBe(
        winner,
      );
      expect(sent).toHaveLength(3);
      expect(calls.getStored).toBe(3);
      expect(logs.map((entry) => entry.event)).not.toContain(
        'claim.create.retries_exhausted',
      );
    });

    it('returns a concurrent rejection found by the recheck intact', async () => {
      const rejection: IdempotencyRecord = {
        ...winner,
        outcome: 'REJECTED',
        response: {
          status: 409,
          body: { error: { code: 'VERSION_CONFLICT' } },
        },
      };
      const { service } = build({
        execute: cancelFirst(1),
        finds: [undefined, undefined, rejection],
      });

      expect(await service.create(actor, categorizedInput, context)).toBe(
        rejection,
      );
    });
  });

  describe('dependency failures during recovery', () => {
    it('propagates a claim reread failure unchanged, storing nothing', async () => {
      const failure = new Error('claim read failed');
      const harness = build({ execute: cancelFirst(1) });
      (harness.deps.claimReader as { get: unknown }).get = () =>
        Promise.reject(failure);

      await expect(
        harness.service.create(actor, categorizedInput, context),
      ).rejects.toBe(failure);
      expect(harness.sent).toHaveLength(1);
      expect(harness.store.size).toBe(0);
    });

    it('propagates a category reread failure unchanged, storing nothing', async () => {
      const failure = new Error('read failed');
      let count = 0;
      const { sent, store, service } = build({
        getStored: () =>
          ++count === 1 ? Promise.resolve(stored()) : Promise.reject(failure),
        execute: cancelFirst(1),
      });

      await expect(
        service.create(actor, categorizedInput, context),
      ).rejects.toBe(failure);
      expect(sent).toHaveLength(1);
      expect(store.size).toBe(0);
    });

    it('propagates a presentation failure while rebuilding, storing nothing', async () => {
      const failure = new Error('users failed');
      let count = 0;
      const { sent, store, service } = build({
        getStored: reads2(stored(), stored({ version: 4 })),
        getMany: () =>
          ++count === 1 ? Promise.resolve(profiles) : Promise.reject(failure),
        execute: cancelFirst(1),
      });

      await expect(
        service.create(actor, categorizedInput, context),
      ).rejects.toBe(failure);
      expect(sent).toHaveLength(1);
      expect(store.size).toBe(0);
    });

    it('propagates a preparation failure while rebuilding, storing nothing', async () => {
      const failure = new TypeError('cannot prepare');
      let prepared = 0;
      const harness = build({
        getStored: reads2(stored(), stored({ version: 4 })),
        execute: cancelFirst(1),
        prepareCreate: (change, options) => {
          if (++prepared === 2) {
            throw failure;
          }
          return new DynamoDbClaimWriter({
            executor: { execute: () => Promise.resolve({ $metadata: {} }) },
            tableName,
          }).prepareCreate(change, options);
        },
      });

      await expect(
        harness.service.create(actor, categorizedInput, context),
      ).rejects.toBe(failure);
      expect(harness.store.size).toBe(0);
    });

    it('propagates a sleep failure unchanged', async () => {
      const failure = new Error('sleep failed');
      const harness = build({ execute: cancelFirst(1) });
      (harness.deps as { sleep: unknown }).sleep = () =>
        Promise.reject(failure);

      await expect(
        harness.service.create(actor, uncategorizedInput, context),
      ).rejects.toBe(failure);
    });

    it('propagates a final check failure unchanged', async () => {
      const failure = new Error('read failed');
      let count = 0;
      const { sent, store, service } = build({
        getStored: () => {
          count += 1;
          return count <= 3
            ? Promise.resolve(stored())
            : Promise.reject(failure);
        },
        execute: () => Promise.reject(cancelled()),
      });

      await expect(
        service.create(actor, categorizedInput, context),
      ).rejects.toBe(failure);
      expect(sent).toHaveLength(3);
      expect(store.size).toBe(0);
    });
  });
});

function reads2(...answers: unknown[]) {
  const queue = [...answers];
  return () => Promise.resolve(queue.shift());
}
