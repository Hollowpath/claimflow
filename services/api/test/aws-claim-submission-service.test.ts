import type {
  TransactWriteCommandInput,
  TransactWriteCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import type { Actor, Category, Claim } from '@claimflow/domain';
import { describe, expect, it } from 'vitest';

import {
  AwsClaimSubmissionService,
  type AwsClaimSubmissionServiceDependencies,
  type ClaimSubmissionContext,
} from '../src/adapters/aws/aws-claim-submission-service.js';
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
const eventId = '8f3d2c1e-5a7b-4c1d-9e2f-0a1b2c3d4e5f';
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

const receipt = {
  receiptId: 'r-7731',
  fileName: 'flight.pdf',
  contentType: 'application/pdf' as const,
  sizeBytes: 52_144,
  checksumSha256: 'a1b2'.repeat(16),
  attachedAt: '2026-10-14T10:20:00.000Z',
};
const draft: Claim = {
  claimId,
  employeeId: 'sub-aisha',
  categoryId: 'travel',
  amount: { amountMinor: 45_000, currency: 'MYR' },
  expenseDate: '2026-10-08',
  merchant: 'Regional Airline',
  businessPurpose: 'Client workshop',
  receipt,
  status: 'DRAFT',
  version: 2,
  createdAt: '2026-10-14T10:00:00.000Z',
  updatedAt: '2026-10-14T10:20:00.000Z',
};
const reopened: Claim = {
  ...draft,
  version: 5,
  assignedManagerId: 'sub-ben',
  submittedAt: '2026-10-14T10:25:00.000Z',
  reviewedAt: '2026-10-14T10:30:00.000Z',
};

const context: ClaimSubmissionContext = {
  idempotencyKey: '5b0d6a8e-retry-key',
  fingerprint: 'ab'.repeat(32),
  now,
  requestId: 'request-1',
  correlationId: 'corr-1',
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
  newId?: () => string;
  prepareSubmit?: DynamoDbClaimWriter['prepareSubmit'];
  execute?: (input: TransactWriteCommandInput) => Promise<void>;
  finds?: (IdempotencyRecord | undefined)[];
}

function build(options: Options = {}) {
  const claim = 'claim' in options ? options.claim : draft;
  const known = options.categories ?? [travel];
  const calls = { claimGet: 0, categoryGet: 0, list: 0, getMany: 0, newId: 0 };
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
  const deps: AwsClaimSubmissionServiceDependencies = {
    mutations,
    claimReader: {
      getStored: (() => {
        calls.claimGet += 1;
        if (options.getStoredClaim !== undefined) {
          return options.getStoredClaim();
        }
        return Promise.resolve(
          claim === undefined
            ? undefined
            : {
                claim,
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
    claims: {
      prepareSubmit: (...args) =>
        options.prepareSubmit?.(...args) ?? writer.prepareSubmit(...args),
      prepareUpdateLifecycle: (...args) =>
        writer.prepareUpdateLifecycle(...args),
    },
    sleep: () => Promise.resolve(),
    random: () => 0.5,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    ids: {
      newId: () => {
        calls.newId += 1;
        return options.newId?.() ?? eventId;
      },
    },
  };
  return {
    calls,
    sent,
    store,
    deps,
    service: new AwsClaimSubmissionService(deps),
  };
}

const submit = (version = 2) => ({ expectedVersion: version });
const kinds = (input: TransactWriteCommandInput) =>
  input.TransactItems!.map((item) => Object.keys(item)[0]);
const noWork = (calls: ReturnType<typeof build>['calls']) =>
  expect(calls).toEqual({
    claimGet: 0,
    categoryGet: 0,
    list: 0,
    getMany: 0,
    newId: 0,
  });

describe('construction', () => {
  it.each([
    ['mutations', 'The mutation coordinator is missing.'],
    ['claimReader', 'The claim reader is missing.'],
    ['categories', 'The category reader is missing.'],
    ['users', 'The user directory is missing.'],
    ['claims', 'The claim writer is missing.'],
    ['ids', 'The ID generator is missing.'],
  ])('rejects missing %s', (name, message) => {
    const { deps } = build();
    expect(
      () => new AwsClaimSubmissionService({ ...deps, [name]: undefined }),
    ).toThrow(new TypeError(message));
  });
});

describe('successful submission', () => {
  it('submits a first time with the event, the guard, and the stored snapshot', async () => {
    const { calls, sent, store, service } = build();

    const record = await service.submit(actor, claimId, submit(), context);

    expect(record).toMatchObject({
      outcome: 'COMPLETED',
      actorId: 'sub-aisha',
      key: context.idempotencyKey,
      fingerprint: context.fingerprint,
      createdAt: now,
      expiresAt: nowEpoch + 24 * 60 * 60,
      response: {
        status: 200,
        body: { claimId, version: 3, status: 'SUBMITTED' },
      },
    });
    expect(store.size).toBe(1);
    expect(sent).toHaveLength(1);
    expect(kinds(sent[0]!)).toEqual([
      'Update',
      'Put',
      'ConditionCheck',
      'Put',
      'Put',
    ]);
    const items = sent[0]!.TransactItems!;
    expect(items[2]!.ConditionCheck!.Key).toEqual({
      PK: 'CATEGORIES',
      SK: 'CATEGORY#travel',
    });
    expect(items[2]!.ConditionCheck!.ExpressionAttributeValues).toEqual({
      ':readVersion': 3,
      ':true': true,
    });
    expect(items[3]!.Put!.Item).toMatchObject({
      PK: `CLAIM#${claimId}`,
      eventId,
      eventType: 'claim.submitted',
      correlationId: 'corr-1',
      causationId: 'request-1',
      actorId: 'sub-aisha',
      occurredAt: now,
      aggregate: {
        type: 'claim',
        id: claimId,
        version: 3,
        previousEventVersion: null,
      },
      payload: {
        claimId,
        employeeId: 'sub-aisha',
        assignedManagerId: 'sub-ben',
        categoryId: 'travel',
        submittedAt: now,
      },
    });
    expect(items[0]!.Update!.ExpressionAttributeValues).toMatchObject({
      ':expectedVersion': 2,
      ':lastEventVersion': 3,
    });
    expect(items.filter((item) => item.Update !== undefined)).toHaveLength(1);
    expect(calls.newId).toBe(1);
  });

  it('resubmits a reopened claim, chaining the event to the stored event version', async () => {
    const { sent, service } = build({ claim: reopened, lastEventVersion: 4 });

    const record = await service.submit(actor, claimId, submit(5), context);

    expect(record.outcome).toBe('COMPLETED');
    const items = sent[0]!.TransactItems!;
    expect(items[3]!.Put!.Item).toMatchObject({
      aggregate: { version: 6, previousEventVersion: 4 },
      payload: { submittedAt: now },
    });
    expect(items[0]!.Update!.ExpressionAttributeValues).toMatchObject({
      ':expectedVersion': 5,
      ':lastEventVersion': 6,
    });
  });

  it('stores exactly the 200 body that the current submission returns', async () => {
    const { service } = build();
    const record = await service.submit(actor, claimId, submit(), context);

    const existing = await new ClaimService({
      claims: {
        get: () => Promise.resolve(draft),
        update: () => Promise.resolve(),
      } as never,
      categories: {
        get: () => Promise.resolve(travel),
        list: () => Promise.resolve([travel]),
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
    }).perform(actor, claimId, 'SUBMIT', { expectedVersion: 2 });

    expect(record.response).toEqual({ status: 200, body: existing });
  });

  it('generates exactly one event ID, and only inside preparation', async () => {
    const { calls, service } = build();
    await service.submit(actor, claimId, submit(), context);
    expect(calls.newId).toBe(1);
  });
});

describe('replay', () => {
  it('returns the stored record without reading, generating, or running domain work', async () => {
    const { calls, sent, service } = build();
    const first = await service.submit(actor, claimId, submit(), context);
    const before = { ...calls };

    const replay = await service.submit(
      actor,
      'not a valid id',
      { x: 1 },
      context,
    );

    expect(replay).toEqual(first);
    expect(calls).toEqual(before);
    expect(sent).toHaveLength(1);
  });

  it('returns a stored rejection with no work', async () => {
    const { calls, service } = build({ claim: undefined });
    const first = await service.submit(actor, claimId, submit(), context);
    expect(first.outcome).toBe('REJECTED');
    const before = { ...calls };

    expect(await service.submit(actor, claimId, submit(), context)).toEqual(
      first,
    );
    expect(calls).toEqual(before);
  });

  it('refuses another fingerprint under the same key', async () => {
    const { service } = build();
    await service.submit(actor, claimId, submit(), context);
    await expect(
      service.submit(actor, claimId, submit(), {
        ...context,
        fingerprint: 'cd'.repeat(32),
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
});

describe('business rejections', () => {
  const code = (record: IdempotencyRecord) =>
    (record.response as { body: { error: { code: string } } }).body.error.code;
  const reject = async (
    who: Actor,
    id: string,
    input: unknown,
    options: Options = {},
  ) => {
    const harness = build(options);
    const record = await harness.service.submit(who, id, input, context);
    expect(record.outcome).toBe('REJECTED');
    expect(record.response.status).toBeGreaterThanOrEqual(400);
    expect(record.response.status).toBeLessThan(500);
    expect(harness.sent).toEqual([]);
    expect(harness.store.size).toBe(1);
    expect(harness.calls.newId).toBe(0);
    return record;
  };

  it('treats a missing and an invisible claim identically', async () => {
    const missing = await reject(actor, claimId, submit(), {
      claim: undefined,
    });
    const invisible = await reject(
      { userId: 'sub-other', displayName: 'Other', roles: ['EMPLOYEE'] },
      claimId,
      submit(),
    );
    expect(missing.response.status).toBe(404);
    expect(invisible.response).toEqual(missing.response);
  });

  it('rejects an invalid claim ID as not found', async () => {
    const record = await reject(actor, 'a b', submit());
    expect(record.response.status).toBe(404);
  });

  it('rejects a stale expected version', async () => {
    const record = await reject(actor, claimId, submit(1));
    expect(code(record)).toBe('VERSION_CONFLICT');
  });

  it.each([
    ['an unknown field', { expectedVersion: 2, status: 'APPROVED' }],
    ['a missing expected version', {}],
    ['a non-object', 'submit'],
  ])('rejects %s as invalid input', async (_name, input) => {
    const harness = build();
    const record = await harness.service.submit(actor, claimId, input, context);
    expect(record.response.status).toBe(400);
    expect(harness.calls.claimGet).toBe(0);
  });

  it('rejects a submission by someone who may view but not own the claim', async () => {
    const record = await reject(
      { userId: 'sub-admin', displayName: 'Admin', roles: ['ADMIN'] },
      claimId,
      submit(),
    );
    expect(code(record)).toBe('FORBIDDEN');
  });

  it('rejects a claim that is no longer a draft', async () => {
    await reject(actor, claimId, submit(), {
      claim: {
        ...draft,
        status: 'SUBMITTED',
        assignedManagerId: 'sub-ben',
        submittedAt: '2026-10-14T10:30:00.000Z',
      },
    });
  });

  it('rejects an employee with no manager', async () => {
    const { managerId: _m, ...unmanaged } = actor;
    const record = await reject(unmanaged, claimId, submit());
    expect(JSON.stringify(record.response)).toContain('NO_MANAGER_ASSIGNED');
  });

  it('rejects a claim above the receipt threshold without a receipt', async () => {
    const { receipt: _r, ...unreceipted } = draft;
    const record = await reject(actor, claimId, submit(), {
      claim: unreceipted,
    });
    expect(record.response.status).toBe(400);
  });

  it.each([
    [
      'an amount above the category limit',
      { amount: { amountMinor: 900_000, currency: 'MYR' } },
    ],
    ['an incomplete draft', { merchant: undefined }],
  ])('rejects %s', async (_name, patch) => {
    const claim = { ...draft, ...patch } as Claim;
    if ('merchant' in patch) {
      delete (claim as { merchant?: string }).merchant;
    }
    await reject(actor, claimId, submit(), { claim });
  });

  it.each([
    ['an inactive category', [category({ active: false, version: 4 })]],
    ['a missing category', []],
  ])('rejects a claim with %s', async (_name, categories) => {
    await reject(actor, claimId, submit(), { categories });
  });

  it('rejects a claim without a category', async () => {
    const { categoryId: _c, ...bare } = draft;
    await reject(actor, claimId, submit(), { claim: bare });
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
      await harness.service.submit(actor, claimId, submit(), context),
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
      await harness.service.submit(actor, claimId, submit(), context),
    ).toBe(winner);
  });

  it('returns a winner found before anything is prepared', async () => {
    const { calls, service } = build({ finds: [winner] });
    expect(await service.submit(actor, claimId, submit(), context)).toBe(
      winner,
    );
    noWork(calls);
  });
});

describe('infrastructure failures', () => {
  it.each([
    [
      'the claim read',
      { getStoredClaim: () => Promise.reject(new Error('claim read failed')) },
      'claim read failed',
    ],
    [
      'the category read',
      {
        getStoredCategory: () =>
          Promise.reject(new Error('category read failed')),
      },
      'category read failed',
    ],
    [
      'the user read',
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
      'the event builder',
      { newId: () => 'not a valid id!' },
      'eventId is not valid',
    ],
    [
      'the preparation',
      {
        prepareSubmit: () => {
          throw new TypeError('cannot prepare');
        },
      },
      'cannot prepare',
    ],
  ])(
    'propagates a failure of %s unchanged and stores nothing',
    async (_name, options, message) => {
      const { sent, store, service } = build(options);

      await expect(
        service.submit(actor, claimId, submit(), context),
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
      service.submit(actor, claimId, submit(), context),
    ).rejects.toBeInstanceOf(Error);
    expect(store.size).toBe(0);
    expect(sent).toEqual([]);
  });

  it('recovers a cancelled commit within three attempts, then propagates it unchanged', async () => {
    const original = cancelled();
    const { calls, sent, store, service } = build({
      execute: () => Promise.reject(original),
    });

    await expect(
      service.submit(actor, claimId, submit(), context),
    ).rejects.toBe(original);
    expect(sent).toHaveLength(3);
    expect(calls.newId).toBe(1);
    expect(store.size).toBe(0);
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
    [
      'an invalid correlation ID',
      actor,
      { ...context, correlationId: 'a b' },
      'The correlation ID is not valid.',
    ],
    [
      'a missing correlation ID',
      actor,
      { ...context, correlationId: undefined },
      'The correlation ID is not valid.',
    ],
  ])('refuses %s before any dependency call', (_name, who, ctx, message) => {
    const { calls, sent, service } = build();

    expect(() =>
      service.submit(who, claimId, submit(), ctx as ClaimSubmissionContext),
    ).toThrow(new TypeError(message));
    noWork(calls);
    expect(sent).toEqual([]);
  });
});
