import type {
  TransactWriteCommandInput,
  TransactWriteCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import type { Actor, Category, Claim } from '@claimflow/domain';
import { describe, expect, it } from 'vitest';

import {
  AwsClaimDraftEditingService,
  ClaimEditIntegrityError,
  type AwsClaimDraftEditingServiceDependencies,
} from '../src/adapters/aws/aws-claim-draft-editing-service.js';
import type { ClaimCreationContext } from '../src/adapters/aws/aws-claim-creation-service.js';
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
const category = (patch: Partial<Category> = {}): Category => ({
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
  ...patch,
});
const travel = category();
const meals = category({ categoryId: 'meals', name: 'Meals', version: 2 });
const retired = category({
  categoryId: 'retired',
  name: 'Retired',
  version: 5,
  active: false,
});
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

const draft: Claim = {
  claimId,
  employeeId: 'sub-aisha',
  categoryId: 'travel',
  amount: { amountMinor: 45_000, currency: 'MYR' },
  expenseDate: '2026-10-08',
  merchant: 'Regional Airline',
  businessPurpose: 'Client workshop',
  status: 'DRAFT',
  version: 2,
  createdAt: '2026-10-14T10:00:00.000Z',
  updatedAt: '2026-10-14T10:10:00.000Z',
};
const uncategorizedDraft: Claim = (() => {
  const { categoryId: _c, ...rest } = draft;
  return rest;
})();

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

interface Options {
  claim?: Claim | undefined;
  lastEventVersion?: number;
  categories?: Category[];
  getStoredClaim?: () => Promise<unknown>;
  getStoredCategory?: () => Promise<unknown>;
  getMany?: () => Promise<readonly UserProfile[]>;
  prepareUpdateDraft?: DynamoDbClaimWriter['prepareUpdateDraft'];
  execute?: (input: TransactWriteCommandInput) => Promise<void>;
  finds?: (IdempotencyRecord | undefined)[];
  /** Answers for the first claim reads, then the default claim. */
  claimScript?: (Claim | undefined)[];
  /** Answers per category for its first reads, then the default category. */
  categoryScript?: Record<
    string,
    ({ category: Category; claimCount?: number } | undefined)[]
  >;
  random?: number;
}

function build(options: Options = {}) {
  const claim = 'claim' in options ? options.claim : draft;
  const known = options.categories ?? [travel, meals, retired];
  const calls = { claimGet: 0, categoryGet: 0, list: 0, getMany: 0 };
  const sleeps: number[] = [];
  const logs: { level: string; event: string; fields: unknown }[] = [];
  const claimScript = [...(options.claimScript ?? [])];
  const categoryScript: Record<string, unknown[]> = {};
  for (const [id, answers] of Object.entries(options.categoryScript ?? {})) {
    categoryScript[id] = [...answers];
  }
  const sent: TransactWriteCommandInput[] = [];
  const store = new Map<string, IdempotencyRecord>();
  const keyOf = (record: { actorId: string; key: string }) =>
    idempotencyKey(record.actorId, record.key).PK;

  const executor = {
    execute: async (input: TransactWriteCommandInput) => {
      sent.push(input);
      await options.execute?.(input);
      const last = input.TransactItems!.at(-1)!.Put!.Item!;
      store.set(String(last.PK), decodeIdempotencyItem(last));
      return { $metadata: {} } as TransactWriteCommandOutput;
    },
  };
  const finds = [...(options.finds ?? [])];
  const finder = {
    find: (actorId: string, key: string) =>
      finds.length > 0
        ? Promise.resolve(finds.shift())
        : Promise.resolve(store.get(idempotencyKey(actorId, key).PK)),
  };
  const rejectionWriter = {
    recordRejection: (record: IdempotencyRecord) => {
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
  const deps: AwsClaimDraftEditingServiceDependencies = {
    mutations,
    claimReader: {
      getStored: (() => {
        calls.claimGet += 1;
        if (options.getStoredClaim !== undefined) {
          return options.getStoredClaim();
        }
        const current = claimScript.length > 0 ? claimScript.shift() : claim;
        return Promise.resolve(
          current === undefined
            ? undefined
            : {
                claim: current,
                metadata:
                  options.lastEventVersion === undefined
                    ? {}
                    : { lastEventVersion: options.lastEventVersion },
              },
        );
      }) as never,
    },
    categories: {
      getStored: ((categoryId: string) => {
        calls.categoryGet += 1;
        if (options.getStoredCategory !== undefined) {
          return options.getStoredCategory();
        }
        const scripted = categoryScript[categoryId];
        if (scripted !== undefined && scripted.length > 0) {
          const answer = scripted.shift() as
            { category: Category; claimCount?: number } | undefined;
          return Promise.resolve(
            answer === undefined
              ? undefined
              : {
                  category: answer.category,
                  metadata: { claimCount: answer.claimCount ?? 1 },
                },
          );
        }
        const found = known.find((c) => c.categoryId === categoryId);
        return Promise.resolve(
          found === undefined
            ? undefined
            : { category: found, metadata: { claimCount: 1 } },
        );
      }) as never,
      list: () => {
        calls.list += 1;
        return Promise.resolve(known);
      },
    },
    users: {
      get: () => Promise.resolve(undefined),
      getMany: () => {
        calls.getMany += 1;
        return options.getMany?.() ?? Promise.resolve(profiles);
      },
    },
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => options.random ?? 0.5,
    logger: {
      info: (event, fields) => logs.push({ level: 'info', event, fields }),
      warn: (event, fields) => logs.push({ level: 'warn', event, fields }),
      error: (event, fields) => logs.push({ level: 'error', event, fields }),
    },
    claims: {
      prepareUpdateDraft: (...args) =>
        options.prepareUpdateDraft?.(...args) ??
        writer.prepareUpdateDraft(...args),
    },
  };
  return {
    calls,
    sent,
    sleeps,
    logs,
    store,
    deps,
    service: new AwsClaimDraftEditingService(deps),
  };
}

const edit = (patch: object, expectedVersion = 2) => ({
  expectedVersion,
  ...patch,
});
const kinds = (input: TransactWriteCommandInput) =>
  input.TransactItems!.map((item) => Object.keys(item)[0]);
const keyList = (input: TransactWriteCommandInput) =>
  input.TransactItems!.map((item) => {
    const op = Object.values(item)[0] as {
      Item?: Record<string, unknown>;
      Key?: Record<string, unknown>;
    };
    const key = op.Item ?? op.Key!;
    return `${String(key.PK)} ${String(key.SK)}`;
  });
const noReads = (calls: ReturnType<typeof build>['calls']) =>
  expect(calls).toEqual({ claimGet: 0, categoryGet: 0, list: 0, getMany: 0 });

describe('construction', () => {
  it.each([
    ['mutations', 'The mutation coordinator is missing.'],
    ['claimReader', 'The claim reader is missing.'],
    ['categories', 'The category reader is missing.'],
    ['users', 'The user directory is missing.'],
    ['claims', 'The claim writer is missing.'],
    ['sleep', 'The sleep function is missing.'],
    ['random', 'The random function is missing.'],
    ['logger', 'The logger is missing.'],
  ])('rejects missing %s', (name, message) => {
    const { deps } = build();
    expect(
      () =>
        new AwsClaimDraftEditingService({
          ...deps,
          [name]: undefined,
        }),
    ).toThrow(new TypeError(message));
  });
});

describe('successful edits', () => {
  it('edits a categorized draft in place, keeping the stored event version', async () => {
    const { calls, sent, store, service } = build({ lastEventVersion: 1 });

    const record = await service.update(
      actor,
      claimId,
      edit({ merchant: 'Metro Airlines' }),
      context,
    );

    expect(record).toMatchObject({
      outcome: 'COMPLETED',
      actorId: 'sub-aisha',
      key: context.idempotencyKey,
      fingerprint: context.fingerprint,
      createdAt: now,
      expiresAt: nowEpoch + 24 * 60 * 60,
      response: { status: 200, body: { claimId, version: 3 } },
    });
    expect(store.size).toBe(1);
    expect(sent).toHaveLength(1);
    expect(kinds(sent[0]!)).toEqual(['Update', 'Put', 'Put']);
    const update = sent[0]!.TransactItems![0]!.Update!;
    expect(update.ExpressionAttributeValues).toMatchObject({
      ':expectedVersion': 2,
      ':actorId': 'sub-aisha',
      ':lastEventVersion': 1,
      ':merchant': 'Metro Airlines',
    });
    expect(calls.categoryGet).toBe(0);
    expect(JSON.stringify(sent[0])).not.toContain('OUTBOX#');
  });

  it('edits without a stored event version', async () => {
    const { sent, service } = build();
    await service.update(actor, claimId, edit({ merchant: 'X Air' }), context);
    expect(
      sent[0]!.TransactItems![0]!.Update!.ExpressionAttributeValues,
    ).not.toHaveProperty(':lastEventVersion');
  });

  it('edits an uncategorized draft without a category operation', async () => {
    const { sent, service } = build({ claim: uncategorizedDraft });

    const record = await service.update(
      actor,
      claimId,
      edit({ merchant: 'Metro Airlines' }),
      context,
    );

    expect(record.outcome).toBe('COMPLETED');
    expect(kinds(sent[0]!)).toEqual(['Update', 'Put', 'Put']);
    expect(JSON.stringify(sent[0])).not.toContain('CATEGORIES');
  });

  it('adds a category with a guarded increment at the version read', async () => {
    const { calls, sent, service } = build({ claim: uncategorizedDraft });

    const record = await service.update(
      actor,
      claimId,
      edit({ categoryId: 'travel' }),
      context,
    );

    expect(record.outcome).toBe('COMPLETED');
    expect(keyList(sent[0]!)).toEqual([
      `CLAIM#${claimId} CLAIM`,
      `CLAIM#${claimId} HISTORY#0000000003`,
      'CATEGORIES CATEGORY#travel',
      expect.stringMatching(/^IDEMPOTENCY#/),
    ]);
    expect(
      sent[0]!.TransactItems![2]!.Update!.ExpressionAttributeValues,
    ).toMatchObject({ ':readVersion': 3, ':true': true });
    expect(calls.categoryGet).toBe(1);
  });

  it('removes a category with an unguarded decrement', async () => {
    const { calls, sent, service } = build();

    const record = await service.update(
      actor,
      claimId,
      edit({ categoryId: null }),
      context,
    );

    expect(record.outcome).toBe('COMPLETED');
    expect(keyList(sent[0]!)[2]).toBe('CATEGORIES CATEGORY#travel');
    expect(
      sent[0]!.TransactItems![2]!.Update!.ExpressionAttributeValues,
    ).toEqual({ ':minusOne': -1, ':one': 1 });
    expect(calls.categoryGet).toBe(0);
  });

  it('switches categories: decrement the old, guarded increment of the new', async () => {
    const { sent, service } = build();

    const record = await service.update(
      actor,
      claimId,
      edit({ categoryId: 'meals' }),
      context,
    );

    expect(record.outcome).toBe('COMPLETED');
    expect(keyList(sent[0]!).slice(2, 4)).toEqual([
      'CATEGORIES CATEGORY#travel',
      'CATEGORIES CATEGORY#meals',
    ]);
    expect(
      sent[0]!.TransactItems![3]!.Update!.ExpressionAttributeValues,
    ).toMatchObject({ ':readVersion': 2, ':true': true });
  });

  it('keeps an unchanged category editable even when it is now inactive, without reading it', async () => {
    const { calls, sent, service } = build({
      claim: { ...draft, categoryId: 'retired' },
    });

    const record = await service.update(
      actor,
      claimId,
      edit({ categoryId: 'retired', merchant: 'Metro Airlines' }),
      context,
    );

    expect(record.outcome).toBe('COMPLETED');
    expect(kinds(sent[0]!)).toEqual(['Update', 'Put', 'Put']);
    expect(calls.categoryGet).toBe(0);
    expect(JSON.stringify(sent[0])).not.toContain('CATEGORIES');
  });

  it('stores exactly the 200 body that the current update returns', async () => {
    const { service } = build();
    const record = await service.update(
      actor,
      claimId,
      edit({ merchant: 'Metro Airlines' }),
      context,
    );

    const existing = await new ClaimService({
      claims: {
        get: () => Promise.resolve(draft),
        update: () => Promise.resolve(),
      } as never,
      categories: {
        get: (id: string) =>
          Promise.resolve([travel, meals].find((c) => c.categoryId === id)),
        list: () => Promise.resolve([travel, meals, retired]),
      } as unknown as CategoryRepository,
      users: {
        get: () => Promise.resolve(undefined),
        getMany: () => Promise.resolve(profiles),
      },
      receipts: {} as never,
      clock: { now: () => new Date(now) },
      ids: { newId: () => 'unused' },
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    }).update(actor, claimId, {
      expectedVersion: 2,
      merchant: 'Metro Airlines',
    });

    expect(record.response).toEqual({ status: 200, body: existing });
  });
});

describe('replay', () => {
  it('returns the stored record without parsing, reading, or running domain rules', async () => {
    const { calls, sent, service } = build();
    const first = await service.update(
      actor,
      claimId,
      edit({ merchant: 'Metro Airlines' }),
      context,
    );
    const before = { ...calls };

    const replay = await service.update(
      actor,
      'not a valid id',
      { x: 1 },
      context,
    );

    expect(replay).toEqual(first);
    expect(calls).toEqual(before);
    expect(sent).toHaveLength(1);
  });

  it('returns a stored rejection without running anything', async () => {
    const { calls, sent, service } = build({ claim: undefined });
    const first = await service.update(actor, claimId, edit({}), context);
    expect(first.outcome).toBe('REJECTED');
    const before = { ...calls };

    expect(await service.update(actor, claimId, edit({}), context)).toEqual(
      first,
    );
    expect(calls).toEqual(before);
    expect(sent).toEqual([]);
  });

  it('refuses another fingerprint under the same key', async () => {
    const { service } = build();
    await service.update(actor, claimId, edit({ merchant: 'A' }), context);
    await expect(
      service.update(actor, claimId, edit({ merchant: 'A' }), {
        ...context,
        fingerprint: 'cd'.repeat(32),
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
});

describe('business rejections', () => {
  const reject = async (
    who: Actor,
    id: string,
    input: unknown,
    options: Options = {},
  ) => {
    const harness = build(options);
    const record = await harness.service.update(who, id, input, context);
    expect(record.outcome).toBe('REJECTED');
    expect(harness.sent).toEqual([]);
    expect(harness.store.size).toBe(1);
    return record;
  };
  const status = (record: IdempotencyRecord) => record.response.status;
  const code = (record: IdempotencyRecord) =>
    (record.response as { body: { error: { code: string } } }).body.error.code;

  it('treats a missing and an invisible claim identically', async () => {
    const missing = await reject(actor, claimId, edit({}), {
      claim: undefined,
    });
    const invisible = await reject(
      { userId: 'sub-other', displayName: 'Other', roles: ['EMPLOYEE'] },
      claimId,
      edit({}),
    );

    expect(status(missing)).toBe(404);
    expect(code(missing)).toBe('NOT_FOUND');
    expect(invisible.response).toEqual(missing.response);
  });

  it('rejects an invalid claim ID as not found, without reading', async () => {
    const harness = build();
    const record = await harness.service.update(
      actor,
      'a b',
      edit({}),
      context,
    );

    expect(status(record)).toBe(404);
    expect(harness.calls.claimGet).toBe(0);
  });

  it('rejects a stale expected version', async () => {
    const record = await reject(actor, claimId, edit({}, 1));
    expect(status(record)).toBe(409);
    expect(code(record)).toBe('VERSION_CONFLICT');
  });

  it('rejects an edit by someone who may view but not own the claim', async () => {
    const record = await reject(
      { userId: 'sub-admin', displayName: 'Admin', roles: ['ADMIN'] },
      claimId,
      edit({ merchant: 'X' }),
    );
    expect(status(record)).toBe(403);
    expect(code(record)).toBe('FORBIDDEN');
  });

  it('rejects an edit of a claim that is no longer a draft', async () => {
    const record = await reject(actor, claimId, edit({ merchant: 'X' }), {
      claim: {
        ...draft,
        status: 'SUBMITTED',
        assignedManagerId: 'sub-ben',
        submittedAt: '2026-10-14T10:20:00.000Z',
      },
    });
    expect(code(record)).toBe('CLAIM_NOT_EDITABLE');
  });

  it.each([
    ['an unknown field', { expectedVersion: 2, employeeId: 'sub-ben' }],
    ['a missing expected version', { merchant: 'X' }],
    ['a non-object', 'edit'],
  ])('rejects %s as invalid', async (_name, input) => {
    const harness = build();
    const record = await harness.service.update(actor, claimId, input, context);
    expect(status(record)).toBe(400);
    expect(code(record)).toBe('VALIDATION_FAILED');
    expect(harness.calls.claimGet).toBe(0);
  });

  it.each([
    ['an unknown category', 'unknown'],
    ['an inactive category', 'retired'],
  ])('rejects entering %s', async (_name, categoryId) => {
    const record = await reject(actor, claimId, edit({ categoryId }));
    expect(status(record)).toBeGreaterThanOrEqual(400);
    expect(status(record)).toBeLessThan(500);
  });

  it('echoes the request ID in the safe error', async () => {
    const record = await reject(actor, claimId, edit({}, 1));
    expect(record.response).toMatchObject({
      body: { error: { requestId: 'request-1' } },
    });
  });
});

describe('concurrent winners', () => {
  const winner: IdempotencyRecord = {
    actorId: 'sub-aisha',
    key: context.idempotencyKey,
    fingerprint: context.fingerprint,
    outcome: 'COMPLETED',
    response: { status: 200, body: { claimId: 'the-winner' } },
    createdAt: now,
    expiresAt: nowEpoch + 24 * 60 * 60,
  };

  it('returns the winner of a lost commit race, not this request', async () => {
    const harness = build({
      execute: (input) => {
        harness.store.set(
          String(input.TransactItems!.at(-1)!.Put!.Item!.PK),
          winner,
        );
        return Promise.reject(cancelled());
      },
    });

    expect(
      await harness.service.update(
        actor,
        claimId,
        edit({ merchant: 'A' }),
        context,
      ),
    ).toBe(winner);
  });

  it('returns a concurrent winner of a rejection race', async () => {
    const harness = build({ claim: undefined });
    const original = harness.deps.claimReader.getStored;
    (harness.deps.claimReader as { getStored: unknown }).getStored = (
      id: string,
    ) => {
      harness.store.set(
        idempotencyKey('sub-aisha', context.idempotencyKey).PK,
        winner,
      );
      return original(id);
    };

    expect(
      await harness.service.update(actor, claimId, edit({}), context),
    ).toBe(winner);
  });

  it('returns a winner found before anything is prepared', async () => {
    const { calls, service } = build({ finds: [winner] });
    expect(await service.update(actor, claimId, edit({}), context)).toBe(
      winner,
    );
    noReads(calls);
  });
});

describe('infrastructure failures', () => {
  it.each([
    [
      'the claim read',
      { getStoredClaim: () => Promise.reject(new Error('claim read failed')) },
      'claim read failed',
      { categoryId: null },
    ],
    [
      'the category read',
      {
        getStoredCategory: () =>
          Promise.reject(new Error('category read failed')),
      },
      'category read failed',
      { categoryId: 'meals' },
    ],
    [
      'the user read',
      { getMany: () => Promise.reject(new Error('users failed')) },
      'users failed',
      { merchant: 'A' },
    ],
    [
      'the preparation',
      {
        prepareUpdateDraft: () => {
          throw new TypeError('cannot prepare');
        },
      },
      'cannot prepare',
      { merchant: 'A' },
    ],
  ])(
    'propagates a failure of %s unchanged and stores nothing',
    async (_name, options, message, patch) => {
      const { sent, store, service } = build(options);

      await expect(
        service.update(actor, claimId, edit(patch), context),
      ).rejects.toThrow(message);
      expect(store.size).toBe(0);
      expect(sent).toEqual([]);
    },
  );

  it('does not turn a codec failure into a rejection', async () => {
    const { sent, store, service } = build({
      claim: { ...draft, claimId: 'a b' },
    });

    await expect(
      service.update(actor, claimId, edit({ merchant: 'A' }), context),
    ).rejects.toBeInstanceOf(Error);
    expect(store.size).toBe(0);
    expect(sent).toEqual([]);
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
      service.update(who, claimId, edit({}), ctx as ClaimCreationContext),
    ).toThrow(new TypeError(message));
    noReads(calls);
    expect(sent).toEqual([]);
  });
});

describe('cancellation recovery', () => {
  const cancelFirst = (count: number) => {
    let sends = 0;
    return () => {
      sends += 1;
      return sends <= count ? Promise.reject(cancelled()) : Promise.resolve();
    };
  };
  const always = (error: Error) => () => Promise.reject(error);
  const version = (id: string, v: number, patch: Partial<Category> = {}) => ({
    category: {
      ...[travel, meals, retired].find((c) => c.categoryId === id)!,
      version: v,
      ...patch,
    },
  });
  const guardVersion = (input: TransactWriteCommandInput) =>
    input.TransactItems!.find(
      (item) =>
        item.Update !== undefined &&
        item.Update.ExpressionAttributeValues?.[':readVersion'] !== undefined,
    )!.Update!.ExpressionAttributeValues![':readVersion'];
  const expectedVersionOf = (input: TransactWriteCommandInput) =>
    input.TransactItems![0]!.Update!.ExpressionAttributeValues![
      ':expectedVersion'
    ];
  const winner: IdempotencyRecord = {
    actorId: 'sub-aisha',
    key: context.idempotencyKey,
    fingerprint: context.fingerprint,
    outcome: 'COMPLETED',
    response: { status: 200, body: { claimId: 'the-winner' } },
    createdAt: now,
    expiresAt: nowEpoch + 24 * 60 * 60,
  };
  const code = (record: IdempotencyRecord) =>
    (record.response as { body: { error: { code: string } } }).body.error.code;
  const merchant = edit({ merchant: 'Metro Airlines' });

  describe('unchanged state', () => {
    it('rebuilds and retries after a backoff, keeping the version, event version, and inputs', async () => {
      const { calls, sent, sleeps, logs, service } = build({
        lastEventVersion: 1,
        execute: cancelFirst(1),
      });

      const record = await service.update(actor, claimId, merchant, context);

      expect(record.outcome).toBe('COMPLETED');
      expect(sent).toHaveLength(2);
      expect(expectedVersionOf(sent[1]!)).toBe(2);
      expect(
        sent[1]!.TransactItems![0]!.Update!.ExpressionAttributeValues,
      ).toMatchObject({
        ':lastEventVersion': 1,
        ':merchant': 'Metro Airlines',
      });
      expect(sent[1]!.ClientRequestToken).toBe(sent[0]!.ClientRequestToken);
      expect(sleeps).toEqual([37]);
      expect(calls.claimGet).toBe(2);
      expect(calls.getMany).toBe(2);
      expect(logs).toEqual([
        {
          level: 'info',
          event: 'claim.update.retry',
          fields: { operation: 'claim.update', retries: 1 },
        },
      ]);
    });

    it('never commits more than three prepared transactions, then rethrows the cancellation unchanged', async () => {
      const original = cancelled();
      const { calls, sent, sleeps, logs, store, service } = build({
        execute: always(original),
      });

      await expect(
        service.update(actor, claimId, merchant, context),
      ).rejects.toBe(original);

      expect(sent).toHaveLength(3);
      expect(sleeps).toHaveLength(2);
      expect(calls.claimGet).toBe(4);
      expect(store.size).toBe(0);
      expect(logs.at(-1)).toEqual({
        level: 'warn',
        event: 'claim.update.retries_exhausted',
        fields: { operation: 'claim.update', retries: 2 },
      });
    });

    it.each([
      [0, [25, 50]],
      [0.999, [49, 99]],
    ])(
      'backs off within the ceilings for jitter %s',
      async (random, expected) => {
        const { sleeps, service } = build({ random, execute: cancelFirst(2) });
        await service.update(actor, claimId, merchant, context);
        expect(sleeps).toEqual(expected);
      },
    );

    it('logs only the operation and the retry count', async () => {
      const { logs, service } = build({ execute: cancelFirst(2) });
      await service.update(actor, claimId, merchant, context);
      expect(logs.map((entry) => entry.fields)).toEqual([
        { operation: 'claim.update', retries: 1 },
        { operation: 'claim.update', retries: 2 },
      ]);
      const text = JSON.stringify(logs);
      for (const secret of [
        'sub-aisha',
        claimId,
        context.idempotencyKey,
        'Metro',
      ]) {
        expect(text).not.toContain(secret);
      }
    });

    it('never inspects cancellation reasons and does not recover other errors', async () => {
      const withReasons = Object.assign(cancelled(), {
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
      });
      const a = build({ execute: always(withReasons) });
      await expect(
        a.service.update(actor, claimId, merchant, context),
      ).rejects.toBe(withReasons);
      expect(a.sent).toHaveLength(3);

      const failure = Object.assign(new Error('bad'), {
        name: 'ValidationException',
      });
      const b = build({ execute: always(failure) });
      await expect(
        b.service.update(actor, claimId, merchant, context),
      ).rejects.toBe(failure);
      expect(b.sent).toHaveLength(1);
      expect(b.sleeps).toEqual([]);
    });
  });

  describe('the claim changes', () => {
    it('stores NOT_FOUND when the claim disappears', async () => {
      const { sent, service } = build({
        claimScript: [draft, undefined],
        execute: cancelFirst(1),
      });

      const record = await service.update(actor, claimId, merchant, context);

      expect(record.outcome).toBe('REJECTED');
      expect(record.response.status).toBe(404);
      expect(sent).toHaveLength(1);
    });

    it('stores the same NOT_FOUND when the claim becomes invisible', async () => {
      const { service } = build({
        claimScript: [draft, { ...draft, employeeId: 'sub-other' }],
        execute: cancelFirst(1),
      });

      const record = await service.update(actor, claimId, merchant, context);

      expect(code(record)).toBe('NOT_FOUND');
    });

    it('stores VERSION_CONFLICT when the claim is at a newer version, never applying the edit to it', async () => {
      const { sent, service } = build({
        claimScript: [draft, { ...draft, version: 3 }],
        execute: cancelFirst(1),
      });

      const record = await service.update(actor, claimId, merchant, context);

      expect(record.response.status).toBe(409);
      expect(code(record)).toBe('VERSION_CONFLICT');
      expect(sent).toHaveLength(1);
    });

    it('stores VERSION_CONFLICT when the claim changes before the final check', async () => {
      const { sent, service } = build({
        claimScript: [draft, draft, draft, { ...draft, version: 4 }],
        execute: always(cancelled()),
      });

      const record = await service.update(actor, claimId, merchant, context);

      expect(code(record)).toBe('VERSION_CONFLICT');
      expect(sent).toHaveLength(3);
    });
  });

  describe('destination category', () => {
    const entering = edit({ categoryId: 'meals' });

    it('rebuilds once with the new guard for a changed but valid category', async () => {
      const { calls, sent, service } = build({
        categoryScript: { meals: [version('meals', 2), version('meals', 3)] },
        execute: cancelFirst(1),
      });

      const record = await service.update(actor, claimId, entering, context);

      expect(record.outcome).toBe('COMPLETED');
      expect(sent).toHaveLength(2);
      expect(guardVersion(sent[0]!)).toBe(2);
      expect(guardVersion(sent[1]!)).toBe(3);
      expect(sent[1]!.ClientRequestToken).not.toBe(sent[0]!.ClientRequestToken);
      expect(expectedVersionOf(sent[1]!)).toBe(2);
      expect(calls.getMany).toBe(2);
    });

    it.each([
      ['deactivated', version('meals', 3, { active: false })],
      ['deleted', undefined],
    ])(
      'stores the normal rejection when the category is %s',
      async (_name, reread) => {
        const { sent, store, service } = build({
          categoryScript: { meals: [version('meals', 2), reread] },
          execute: cancelFirst(1),
        });

        const record = await service.update(actor, claimId, entering, context);

        expect(record.outcome).toBe('REJECTED');
        expect(record.response.status).toBeLessThan(500);
        expect(code(record)).not.toBe('VERSION_CONFLICT');
        expect(store.size).toBe(1);
        expect(sent).toHaveLength(1);
      },
    );

    it('stores VERSION_CONFLICT for a second destination change', async () => {
      const { sent, service } = build({
        categoryScript: {
          meals: [
            version('meals', 2),
            version('meals', 3),
            version('meals', 4),
          ],
        },
        execute: cancelFirst(2),
      });

      const record = await service.update(actor, claimId, entering, context);

      expect(code(record)).toBe('VERSION_CONFLICT');
      expect(sent).toHaveLength(2);
    });

    it('counts a category rebuild toward the three attempts', async () => {
      const original = cancelled();
      const { sent, service } = build({
        categoryScript: {
          meals: [
            version('meals', 2),
            version('meals', 3),
            version('meals', 3),
            version('meals', 3),
          ],
        },
        execute: always(original),
      });

      await expect(
        service.update(actor, claimId, entering, context),
      ).rejects.toBe(original);
      expect(sent).toHaveLength(3);
      expect(guardVersion(sent[2]!)).toBe(3);
    });

    describe('at exhaustion', () => {
      const exhausted = (final: unknown, earlier = [2, 2, 2]) => {
        const original = cancelled();
        const harness = build({
          categoryScript: {
            meals: [...earlier.map((v) => version('meals', v)), final as never],
          },
          execute: always(original),
        });
        return { original, ...harness };
      };

      it.each([
        ['a deleted category', undefined],
        ['a deactivated category', version('meals', 9, { active: false })],
      ])(
        'persists the normal rejection for a first change to %s',
        async (_name, final) => {
          const { sent, store, service } = exhausted(final);

          const record = await service.update(
            actor,
            claimId,
            entering,
            context,
          );

          expect(record.outcome).toBe('REJECTED');
          expect(code(record)).not.toBe('VERSION_CONFLICT');
          expect(store.size).toBe(1);
          expect(sent).toHaveLength(3);
        },
      );

      it('rethrows the cancellation for a first change that is still valid, with no fourth commit', async () => {
        const { original, sent, store, logs, calls, service } = exhausted(
          version('meals', 9),
        );

        await expect(
          service.update(actor, claimId, entering, context),
        ).rejects.toBe(original);

        expect(sent).toHaveLength(3);
        expect(store.size).toBe(0);
        expect(logs.at(-1)).toMatchObject({
          event: 'claim.update.retries_exhausted',
        });
        expect(calls.getMany).toBe(3);
      });

      it('persists VERSION_CONFLICT when a repeated change is found', async () => {
        const { sent, service } = exhausted(version('meals', 9), [2, 3, 3]);

        const record = await service.update(actor, claimId, entering, context);

        expect(code(record)).toBe('VERSION_CONFLICT');
        expect(sent).toHaveLength(3);
      });
    });
  });

  describe('source category counter', () => {
    const removing = edit({ categoryId: null });

    it('is reread, and a retry proceeds when it is positive', async () => {
      const { calls, sent, service } = build({ execute: cancelFirst(1) });

      const record = await service.update(actor, claimId, removing, context);

      expect(record.outcome).toBe('COMPLETED');
      expect(sent).toHaveLength(2);
      expect(calls.categoryGet).toBe(1);
    });

    it.each([
      ['a missing source category', undefined],
      ['a counter at zero', { category: travel, claimCount: 0 }],
    ])(
      'is an integrity failure for %s: no retry and no stored rejection',
      async (_name, answer) => {
        const { sent, store, service } = build({
          categoryScript: { travel: [answer] },
          execute: cancelFirst(1),
        });

        const failure = await service
          .update(actor, claimId, removing, context)
          .catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(ClaimEditIntegrityError);
        expect((failure as Error).message).toBe(
          'The category counter of the claim is inconsistent.',
        );
        expect(String(failure)).not.toContain('travel');
        expect(sent).toHaveLength(1);
        expect(store.size).toBe(0);
      },
    );

    it('is also checked by the final check', async () => {
      const { sent, store, service } = build({
        categoryScript: {
          travel: [undefined, undefined]
            .map(() => ({ category: travel }))
            .concat([{ category: travel, claimCount: 0 } as never]),
        },
        execute: always(cancelled()),
      });

      await expect(
        service.update(actor, claimId, removing, context),
      ).rejects.toBeInstanceOf(ClaimEditIntegrityError);
      expect(sent).toHaveLength(3);
      expect(store.size).toBe(0);
    });

    it('is checked for a switch as well', async () => {
      const { service } = build({
        categoryScript: { travel: [{ category: travel, claimCount: 0 }] },
        execute: cancelFirst(1),
      });

      await expect(
        service.update(actor, claimId, edit({ categoryId: 'meals' }), context),
      ).rejects.toBeInstanceOf(ClaimEditIntegrityError);
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

      expect(await service.update(actor, claimId, merchant, context)).toBe(
        winner,
      );
      expect(sent).toHaveLength(1);
      expect(calls.claimGet).toBe(1);
    });

    it('lets a fingerprint conflict found by the recheck propagate', async () => {
      const { service } = build({
        execute: cancelFirst(1),
        finds: [
          undefined,
          undefined,
          { ...winner, fingerprint: 'cd'.repeat(32) },
        ],
      });

      await expect(
        service.update(actor, claimId, merchant, context),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    });

    it('returns a winner found before the final reread', async () => {
      const { calls, sent, logs, service } = build({
        execute: always(cancelled()),
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

      expect(await service.update(actor, claimId, merchant, context)).toBe(
        winner,
      );
      expect(sent).toHaveLength(3);
      expect(calls.claimGet).toBe(3);
      expect(logs.map((entry) => entry.event)).not.toContain(
        'claim.update.retries_exhausted',
      );
    });
  });

  describe('dependency failures during recovery', () => {
    it('propagates a claim reread failure unchanged, storing nothing', async () => {
      const failure = new Error('claim read failed');
      let reads = 0;
      const { sent, store, service } = build({
        getStoredClaim: () =>
          ++reads === 1
            ? Promise.resolve({ claim: draft, metadata: {} })
            : Promise.reject(failure),
        execute: cancelFirst(1),
      });

      await expect(
        service.update(actor, claimId, merchant, context),
      ).rejects.toBe(failure);
      expect(sent).toHaveLength(1);
      expect(store.size).toBe(0);
    });

    it('propagates a destination reread failure unchanged', async () => {
      const failure = new Error('category read failed');
      let reads = 0;
      const { store, service } = build({
        getStoredCategory: () =>
          ++reads === 1
            ? Promise.resolve({ category: meals, metadata: { claimCount: 1 } })
            : Promise.reject(failure),
        execute: cancelFirst(1),
      });

      await expect(
        service.update(actor, claimId, edit({ categoryId: 'meals' }), context),
      ).rejects.toBe(failure);
      expect(store.size).toBe(0);
    });

    it('propagates presentation, preparation, and sleep failures unchanged', async () => {
      const users = new Error('users failed');
      let usersCalls = 0;
      const a = build({
        getMany: () =>
          ++usersCalls === 1
            ? Promise.resolve(profiles)
            : Promise.reject(users),
        execute: cancelFirst(1),
      });
      await expect(
        a.service.update(actor, claimId, merchant, context),
      ).rejects.toBe(users);
      expect(a.store.size).toBe(0);

      const preparation = new TypeError('cannot prepare');
      let prepared = 0;
      const b = build({
        execute: cancelFirst(1),
        prepareUpdateDraft: (...args) => {
          if (++prepared === 2) {
            throw preparation;
          }
          return new DynamoDbClaimWriter({
            executor: { execute: () => Promise.resolve({ $metadata: {} }) },
            tableName,
          }).prepareUpdateDraft(...args);
        },
      });
      await expect(
        b.service.update(actor, claimId, merchant, context),
      ).rejects.toBe(preparation);
      expect(b.store.size).toBe(0);

      const sleeping = new Error('sleep failed');
      const c = build({ execute: cancelFirst(1) });
      (c.deps as { sleep: unknown }).sleep = () => Promise.reject(sleeping);
      await expect(
        c.service.update(actor, claimId, merchant, context),
      ).rejects.toBe(sleeping);
    });
  });
});
