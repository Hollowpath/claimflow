import type {
  TransactWriteCommandInput,
  TransactWriteCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import type { Actor, Category, Claim, ClaimAction } from '@claimflow/domain';
import { describe, expect, it } from 'vitest';

import {
  AwsClaimLifecycleService,
  type AwsClaimLifecycleServiceDependencies,
  type ClaimLifecycleContext,
} from '../src/adapters/aws/aws-claim-lifecycle-service.js';
import { ClaimMutationCoordinator } from '../src/adapters/aws/claim-mutation-coordinator.js';
import {
  claimManagerCondition,
  claimOwnerCondition,
  claimVersionCondition,
} from '../src/adapters/aws/dynamodb-claim-operations.js';
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
import { claimActionEventTypes } from '../src/application/claim-events.js';
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

const employee: Actor = {
  userId: 'sub-aisha',
  displayName: 'Aisha Rahman',
  roles: ['EMPLOYEE'],
  managerId: 'sub-ben',
};
const manager: Actor = {
  userId: 'sub-ben',
  displayName: 'Ben Tan',
  roles: ['MANAGER'],
};
const admin: Actor = {
  userId: 'sub-dan',
  displayName: 'Dan Lee',
  roles: ['ADMIN'],
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
  {
    userId: 'sub-dan',
    displayName: 'Dan Lee',
    title: 'Finance',
    roles: ['ADMIN'],
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
const base: Claim = {
  claimId,
  employeeId: 'sub-aisha',
  categoryId: 'travel',
  amount: { amountMinor: 45_000, currency: 'MYR' },
  expenseDate: '2026-10-08',
  merchant: 'Regional Airline',
  businessPurpose: 'Client workshop',
  receipt,
  status: 'DRAFT',
  version: 4,
  createdAt: '2026-10-14T10:00:00.000Z',
  updatedAt: '2026-10-14T10:30:00.000Z',
};
const open = (status: Claim['status'], patch: Partial<Claim> = {}): Claim => ({
  ...base,
  assignedManagerId: 'sub-ben',
  submittedAt: '2026-10-14T10:25:00.000Z',
  status,
  ...patch,
});

/** The claim each action starts from, with who performs it. */
const scenarios: Record<
  ClaimAction,
  { actor: Actor; claim: Claim; input: object; condition: string }
> = {
  SUBMIT: {
    actor: employee,
    claim: base,
    input: {},
    condition: claimOwnerCondition,
  },
  START_REVIEW: {
    actor: manager,
    claim: open('SUBMITTED'),
    input: {},
    condition: claimManagerCondition,
  },
  APPROVE: {
    actor: manager,
    claim: open('UNDER_REVIEW'),
    input: { comment: 'Looks right.' },
    condition: claimManagerCondition,
  },
  REJECT: {
    actor: manager,
    claim: open('UNDER_REVIEW'),
    input: { comment: 'Please add the boarding pass.' },
    condition: claimManagerCondition,
  },
  REOPEN: {
    actor: employee,
    claim: open('REJECTED', { reviewedAt: '2026-10-14T10:35:00.000Z' }),
    input: {},
    condition: claimOwnerCondition,
  },
  MARK_PAID: {
    actor: admin,
    claim: open('APPROVED', { reviewedAt: '2026-10-14T10:35:00.000Z' }),
    input: {},
    condition: claimVersionCondition,
  },
};
const actions = Object.keys(scenarios) as ClaimAction[];

const context: ClaimLifecycleContext = {
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
  getMany?: () => Promise<readonly UserProfile[]>;
  newId?: () => string;
  execute?: (input: TransactWriteCommandInput) => Promise<void>;
  finds?: (IdempotencyRecord | undefined)[];
  claimScript?: (Claim | undefined)[];
  categoryScript?: Record<
    string,
    ({ category: Category; claimCount?: number } | undefined)[]
  >;
  random?: number;
  prepareUpdateLifecycle?: DynamoDbClaimWriter['prepareUpdateLifecycle'];
}

function build(action: ClaimAction, options: Options = {}) {
  const claim = 'claim' in options ? options.claim : scenarios[action].claim;
  const known = options.categories ?? [travel];
  const calls = { claimGet: 0, categoryGet: 0, list: 0, getMany: 0, newId: 0 };
  const sent: TransactWriteCommandInput[] = [];
  const sleeps: number[] = [];
  const logs: { level: string; event: string; fields: unknown }[] = [];
  const store = new Map<string, IdempotencyRecord>();
  const claimScript = [...(options.claimScript ?? [])];
  const categoryScript: Record<string, unknown[]> = {};
  for (const [id, answers] of Object.entries(options.categoryScript ?? {})) {
    categoryScript[id] = [...answers];
  }
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
  const deps: AwsClaimLifecycleServiceDependencies = {
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
      getStored: (categoryId: string) => {
        calls.categoryGet += 1;
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
      },
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
      prepareSubmit: (...args) => writer.prepareSubmit(...args),
      prepareUpdateLifecycle: (...args) =>
        options.prepareUpdateLifecycle?.(...args) ??
        writer.prepareUpdateLifecycle(...args),
    },
    ids: {
      newId: () => {
        calls.newId += 1;
        return options.newId?.() ?? eventId;
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
  };
  return {
    calls,
    sent,
    sleeps,
    logs,
    store,
    deps,
    service: new AwsClaimLifecycleService(deps),
  };
}

/** What the existing ClaimService returns for the same action. */
async function existingBody(
  action: ClaimAction,
  who: Actor,
  claim: Claim,
  input: { expectedVersion: number; comment?: string },
) {
  return new ClaimService({
    claims: {
      get: () => Promise.resolve(claim),
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
  }).perform(who, claimId, action, input);
}

const inputFor = (action: ClaimAction, version = 4) => ({
  expectedVersion: version,
  ...scenarios[action].input,
});
const perform = (
  harness: ReturnType<typeof build>,
  action: ClaimAction,
  overrides: { actor?: Actor; input?: unknown; claimId?: string } = {},
) =>
  harness.service.perform(
    overrides.actor ?? scenarios[action].actor,
    overrides.claimId ?? claimId,
    action,
    'input' in overrides ? overrides.input : inputFor(action),
    context,
  );
const kinds = (input: TransactWriteCommandInput) =>
  input.TransactItems!.map((item) => Object.keys(item)[0]);
const eventOf = (input: TransactWriteCommandInput) =>
  input.TransactItems!.find((item) =>
    String(item.Put?.Item?.SK ?? '').startsWith('OUTBOX#'),
  )!.Put!.Item!;
const noWork = (calls: ReturnType<typeof build>['calls']) =>
  expect(calls).toEqual({
    claimGet: 0,
    categoryGet: 0,
    list: 0,
    getMany: 0,
    newId: 0,
  });
const code = (record: IdempotencyRecord) =>
  (record.response as { body: { error: { code: string } } }).body.error.code;

describe('construction', () => {
  it.each([
    ['mutations', 'The mutation coordinator is missing.'],
    ['claimReader', 'The claim reader is missing.'],
    ['categories', 'The category reader is missing.'],
    ['users', 'The user directory is missing.'],
    ['claims', 'The claim writer is missing.'],
    ['ids', 'The ID generator is missing.'],
    ['sleep', 'The sleep function is missing.'],
    ['random', 'The random function is missing.'],
    ['logger', 'The logger is missing.'],
  ])('rejects missing %s', (name, message) => {
    const { deps } = build('APPROVE');
    expect(
      () => new AwsClaimLifecycleService({ ...deps, [name]: undefined }),
    ).toThrow(new TypeError(message));
  });
});

describe.each(actions)('%s', (action) => {
  const { actor, claim, condition } = scenarios[action];

  it('commits the action with its event, and the right transaction shape and write condition', async () => {
    const harness = build(action, { lastEventVersion: 3 });

    const record = await perform(harness, action);

    expect(record).toMatchObject({
      outcome: 'COMPLETED',
      actorId: actor.userId,
      key: context.idempotencyKey,
      fingerprint: context.fingerprint,
      createdAt: now,
      expiresAt: nowEpoch + 24 * 60 * 60,
      response: { status: 200, body: { claimId, version: 5 } },
    });
    expect(harness.sent).toHaveLength(1);
    const sent = harness.sent[0]!;
    expect(kinds(sent)).toEqual(
      action === 'SUBMIT'
        ? ['Update', 'Put', 'ConditionCheck', 'Put', 'Put']
        : ['Update', 'Put', 'Put', 'Put'],
    );
    expect(sent.TransactItems![0]!.Update!.ConditionExpression).toBe(condition);
    expect(
      sent.TransactItems![0]!.Update!.ExpressionAttributeValues,
    ).toMatchObject({
      ':expectedVersion': 4,
      ':lastEventVersion': 5,
    });
    expect(eventOf(sent)).toMatchObject({
      eventId,
      eventType: claimActionEventTypes[action],
      correlationId: 'corr-1',
      causationId: 'request-1',
      actorId: actor.userId,
      occurredAt: now,
      aggregate: {
        type: 'claim',
        id: claimId,
        version: 5,
        previousEventVersion: 3,
      },
    });
    expect(harness.calls.newId).toBe(1);
    if (action === 'SUBMIT') {
      expect(
        sent.TransactItems![2]!.ConditionCheck!.ExpressionAttributeValues,
      ).toEqual({
        ':readVersion': 3,
        ':true': true,
      });
    } else {
      expect(JSON.stringify(sent)).not.toContain('CATEGORIES');
      expect(harness.calls.categoryGet).toBe(0);
    }
  });

  it('chains the first event with a null previous version', async () => {
    const harness = build(action);
    await perform(harness, action);
    expect(eventOf(harness.sent[0]!).aggregate).toMatchObject({
      previousEventVersion: null,
    });
  });

  it('stores exactly the 200 body the existing ClaimService returns', async () => {
    const harness = build(action);
    const record = await perform(harness, action);
    expect(record.response).toEqual({
      status: 200,
      body: await existingBody(action, actor, claim, inputFor(action)),
    });
  });

  it('replays without any preparation, read, or ID generation', async () => {
    const harness = build(action);
    const first = await perform(harness, action);
    const before = { ...harness.calls };

    const replay = await perform(harness, action, {
      claimId: 'not a valid id',
      input: { x: 1 },
    });

    expect(replay).toEqual(first);
    expect(harness.calls).toEqual(before);
    expect(harness.sent).toHaveLength(1);
  });

  it('stores NOT_FOUND identically for a missing and an invisible claim', async () => {
    const missing = await perform(build(action, { claim: undefined }), action);
    const stranger: Actor = {
      userId: 'sub-stranger',
      displayName: 'S',
      roles: ['EMPLOYEE'],
    };
    const invisible = await perform(build(action), action, { actor: stranger });

    expect(missing.response.status).toBe(404);
    expect(invisible.response).toEqual(missing.response);
  });

  it('stores VERSION_CONFLICT for a stale version, without an ID', async () => {
    const harness = build(action);
    const record = await perform(harness, action, {
      input: inputFor(action, 1),
    });
    expect(code(record)).toBe('VERSION_CONFLICT');
    expect(harness.calls.newId).toBe(0);
    expect(harness.sent).toEqual([]);
  });

  it('stores a validation rejection for smuggled input', async () => {
    const harness = build(action);
    const record = await perform(harness, action, {
      input: { ...inputFor(action), status: 'PAID' },
    });
    expect(record.response.status).toBe(400);
    expect(harness.calls.claimGet).toBe(0);
  });

  it('propagates an unresolved cancellation after three attempts, with one event ID', async () => {
    const original = cancelled();
    const harness = build(action, { execute: () => Promise.reject(original) });

    await expect(perform(harness, action)).rejects.toBe(original);

    expect(harness.sent).toHaveLength(3);
    expect(new Set(harness.sent.map((s) => eventOf(s).eventId))).toEqual(
      new Set([eventId]),
    );
    expect(harness.calls.newId).toBe(1);
    expect(harness.sleeps).toHaveLength(2);
    expect(harness.logs.at(-1)).toMatchObject({
      level: 'warn',
      event: 'claim.lifecycle.retries_exhausted',
      fields: { retries: 2 },
    });
  });
});

describe('authorization and domain rules', () => {
  it('requires a comment to approve or reject', async () => {
    for (const action of ['APPROVE', 'REJECT'] as const) {
      const harness = build(action);
      const record = await perform(harness, action, {
        input: { expectedVersion: 4 },
      });
      expect(record.response.status).toBe(400);
      const blank = await perform(build(action), action, {
        input: { expectedVersion: 4, comment: '   ' },
      });
      expect(blank.outcome).toBe('REJECTED');
    }
  });

  it('refuses a manager who is not assigned to the claim', async () => {
    const other: Actor = {
      userId: 'sub-other-manager',
      displayName: 'O',
      roles: ['MANAGER'],
    };
    const record = await perform(build('START_REVIEW'), 'START_REVIEW', {
      actor: other,
    });
    expect(record.outcome).toBe('REJECTED');
    expect(record.response.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses a manager reviewing their own claim', async () => {
    const own = open('UNDER_REVIEW', { employeeId: 'sub-ben' });
    const record = await perform(build('APPROVE', { claim: own }), 'APPROVE');
    expect(record.outcome).toBe('REJECTED');
  });

  it('refuses payment by a non-administrator and by the claim owner', async () => {
    const approved = scenarios.MARK_PAID.claim;
    const byManager = await perform(build('MARK_PAID'), 'MARK_PAID', {
      actor: manager,
    });
    expect(byManager.outcome).toBe('REJECTED');

    const own = { ...approved, employeeId: 'sub-dan' };
    const byOwner = await perform(
      build('MARK_PAID', { claim: own }),
      'MARK_PAID',
    );
    expect(byOwner.outcome).toBe('REJECTED');
  });

  it('refuses an action from the wrong status', async () => {
    const record = await perform(
      build('APPROVE', { claim: open('SUBMITTED') }),
      'APPROVE',
    );
    expect(record.outcome).toBe('REJECTED');
  });

  it('refuses reopening by someone other than the owner', async () => {
    const record = await perform(build('REOPEN'), 'REOPEN', { actor: admin });
    expect(record.outcome).toBe('REJECTED');
  });

  it('applies the submission rules: manager, receipt, limits, and category', async () => {
    const { managerId: _m, ...unmanaged } = employee;
    const noReceipt = (() => {
      const { receipt: _r, ...rest } = base;
      return rest;
    })();
    const cases: [string, ReturnType<typeof build>, Actor | undefined][] = [
      ['no manager', build('SUBMIT'), unmanaged],
      ['no receipt', build('SUBMIT', { claim: noReceipt }), undefined],
      [
        'over the limit',
        build('SUBMIT', {
          claim: { ...base, amount: { amountMinor: 900_000, currency: 'MYR' } },
        }),
        undefined,
      ],
      [
        'inactive category',
        build('SUBMIT', { categories: [category({ active: false })] }),
        undefined,
      ],
      ['missing category', build('SUBMIT', { categories: [] }), undefined],
    ];
    for (const [, harness, who] of cases) {
      const record = await perform(
        harness,
        'SUBMIT',
        who ? { actor: who } : {},
      );
      expect(record.outcome).toBe('REJECTED');
      expect(harness.sent).toEqual([]);
      expect(harness.calls.newId).toBe(0);
    }
  });

  it('rejects an unknown action before any dependency call', () => {
    const harness = build('APPROVE');
    expect(() =>
      harness.service.perform(
        manager,
        claimId,
        'DELETE' as ClaimAction,
        {},
        context,
      ),
    ).toThrow(new TypeError('The claim action is not valid.'));
    noWork(harness.calls);
  });
});

describe('concurrent winners', () => {
  const winner: IdempotencyRecord = {
    actorId: 'sub-ben',
    key: context.idempotencyKey,
    fingerprint: context.fingerprint,
    outcome: 'COMPLETED',
    response: { status: 200, body: { claimId: 'the-winner' } },
    createdAt: now,
    expiresAt: nowEpoch + 24 * 60 * 60,
  };

  it('returns the winner of a lost commit race, not this request', async () => {
    const harness = build('APPROVE', {
      execute: (input) => {
        harness.store.set(
          String(input.TransactItems!.at(-1)!.Put!.Item!.PK),
          winner,
        );
        return Promise.reject(cancelled());
      },
    });
    expect(await perform(harness, 'APPROVE')).toBe(winner);
  });

  it('returns a winner found by the recovery recheck before any reread', async () => {
    const harness = build('APPROVE', {
      execute: () => Promise.reject(cancelled()),
      finds: [undefined, undefined, winner],
    });
    expect(await perform(harness, 'APPROVE')).toBe(winner);
    expect(harness.calls.claimGet).toBe(1);
  });

  it('lets a fingerprint conflict found by the recheck propagate', async () => {
    const harness = build('APPROVE', {
      execute: () => Promise.reject(cancelled()),
      finds: [
        undefined,
        undefined,
        { ...winner, fingerprint: 'cd'.repeat(32) },
      ],
    });
    await expect(perform(harness, 'APPROVE')).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });

  it('returns a winner found before the final reread', async () => {
    const harness = build('MARK_PAID', {
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
    expect(await perform(harness, 'MARK_PAID')).toBe(winner);
    expect(harness.sent).toHaveLength(3);
  });
});

describe('recovery without a category', () => {
  const cancelFirst = (count: number) => {
    let sends = 0;
    return () =>
      ++sends <= count ? Promise.reject(cancelled()) : Promise.resolve();
  };

  it.each(actions)(
    'retries %s after unchanged state with a stable event ID, token, and bounds',
    async (action) => {
      const harness = build(action, { execute: cancelFirst(2), random: 0 });

      const record = await perform(harness, action);

      expect(record.outcome).toBe('COMPLETED');
      expect(harness.sent).toHaveLength(2 + 1);
      expect(new Set(harness.sent.map((s) => eventOf(s).eventId))).toEqual(
        new Set([eventId]),
      );
      expect(harness.calls.newId).toBe(1);
      expect(harness.sent[2]!.ClientRequestToken).toBe(
        harness.sent[0]!.ClientRequestToken,
      );
      expect(harness.sleeps).toEqual([25, 50]);
      expect(harness.logs.map((entry) => entry.fields)).toEqual([
        { operation: `claim.${actionPath(action)}`, retries: 1 },
        { operation: `claim.${actionPath(action)}`, retries: 2 },
      ]);
    },
  );

  it('stores NOT_FOUND when the claim disappears or becomes invisible', async () => {
    const gone = build('APPROVE', {
      claimScript: [scenarios.APPROVE.claim, undefined],
      execute: cancelFirst(1),
    });
    const hidden = build('APPROVE', {
      claimScript: [
        scenarios.APPROVE.claim,
        {
          ...scenarios.APPROVE.claim,
          assignedManagerId: 'sub-zed',
          employeeId: 'sub-other',
        },
      ],
      execute: cancelFirst(1),
    });

    expect((await perform(gone, 'APPROVE')).response.status).toBe(404);
    expect(code(await perform(hidden, 'APPROVE'))).toBe('NOT_FOUND');
    expect(gone.sent).toHaveLength(1);
  });

  it('stores VERSION_CONFLICT when the claim moved on, never applying the action to it', async () => {
    const harness = build('APPROVE', {
      claimScript: [
        scenarios.APPROVE.claim,
        { ...scenarios.APPROVE.claim, version: 5 },
      ],
      execute: cancelFirst(1),
    });

    const record = await perform(harness, 'APPROVE');

    expect(code(record)).toBe('VERSION_CONFLICT');
    expect(harness.sent).toHaveLength(1);
  });

  it('does not recover other errors and reads no cancellation reasons', async () => {
    const failure = Object.assign(new Error('bad'), {
      name: 'ValidationException',
    });
    const a = build('APPROVE', { execute: () => Promise.reject(failure) });
    await expect(perform(a, 'APPROVE')).rejects.toBe(failure);
    expect(a.sent).toHaveLength(1);
    expect(a.sleeps).toEqual([]);

    const withReasons = Object.assign(cancelled(), {
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
    });
    const b = build('APPROVE', { execute: () => Promise.reject(withReasons) });
    await expect(perform(b, 'APPROVE')).rejects.toBe(withReasons);
    expect(b.sent).toHaveLength(3);
  });

  it('logs only the operation and the retry count', async () => {
    const harness = build('APPROVE', { execute: cancelFirst(1) });
    await perform(harness, 'APPROVE');
    const text = JSON.stringify(harness.logs);
    for (const secret of [
      'sub-ben',
      claimId,
      context.idempotencyKey,
      'Looks right',
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('propagates claim, user, sleep, preparation, and event failures unchanged, storing nothing', async () => {
    const claimFailure = new Error('claim read failed');
    let reads = 0;
    const a = build('APPROVE', {
      getStoredClaim: () =>
        ++reads === 1
          ? Promise.resolve({ claim: scenarios.APPROVE.claim, metadata: {} })
          : Promise.reject(claimFailure),
      execute: cancelFirst(1),
    });
    await expect(perform(a, 'APPROVE')).rejects.toBe(claimFailure);
    expect(a.store.size).toBe(0);

    const users = new Error('users failed');
    let userCalls = 0;
    const b = build('APPROVE', {
      getMany: () =>
        ++userCalls === 1 ? Promise.resolve(profiles) : Promise.reject(users),
      execute: cancelFirst(1),
    });
    await expect(perform(b, 'APPROVE')).rejects.toBe(users);
    expect(b.store.size).toBe(0);

    const sleeping = new Error('sleep failed');
    const c = build('APPROVE', { execute: cancelFirst(1) });
    (c.deps as { sleep: unknown }).sleep = () => Promise.reject(sleeping);
    await expect(perform(c, 'APPROVE')).rejects.toBe(sleeping);

    const preparation = new TypeError('cannot prepare');
    const d = build('APPROVE', {
      prepareUpdateLifecycle: () => {
        throw preparation;
      },
    });
    await expect(perform(d, 'APPROVE')).rejects.toBe(preparation);
    expect(d.store.size).toBe(0);

    const e = build('APPROVE', { newId: () => 'not a valid id!' });
    await expect(perform(e, 'APPROVE')).rejects.toThrow('eventId is not valid');
    expect(e.store.size).toBe(0);
  });
});

function actionPath(action: ClaimAction): string {
  return {
    SUBMIT: 'submit',
    START_REVIEW: 'start-review',
    APPROVE: 'approve',
    REJECT: 'reject',
    REOPEN: 'reopen',
    MARK_PAID: 'mark-paid',
  }[action];
}

describe('submission category recovery', () => {
  const cancelFirst = (count: number) => {
    let sends = 0;
    return () =>
      ++sends <= count ? Promise.reject(cancelled()) : Promise.resolve();
  };
  const version = (v: number, patch: Partial<Category> = {}) => ({
    category: category({ version: v, ...patch }),
  });
  const guardVersion = (input: TransactWriteCommandInput) =>
    input.TransactItems!.find((item) => item.ConditionCheck !== undefined)!
      .ConditionCheck!.ExpressionAttributeValues![':readVersion'];

  it('rebuilds once for a changed but valid category, with the same event ID and a new guard and token', async () => {
    const harness = build('SUBMIT', {
      categoryScript: {
        travel: [version(3), version(4, { maxAmountMinor: 300_000 })],
      },
      execute: cancelFirst(1),
    });

    const record = await perform(harness, 'SUBMIT');

    expect(record.outcome).toBe('COMPLETED');
    expect(harness.sent).toHaveLength(2);
    expect(guardVersion(harness.sent[0]!)).toBe(3);
    expect(guardVersion(harness.sent[1]!)).toBe(4);
    expect(eventOf(harness.sent[1]!).eventId).toBe(
      eventOf(harness.sent[0]!).eventId,
    );
    expect(harness.sent[1]!.ClientRequestToken).not.toBe(
      harness.sent[0]!.ClientRequestToken,
    );
    expect(harness.calls.newId).toBe(1);
  });

  it.each([
    ['deactivated', version(4, { active: false })],
    ['deleted', undefined],
  ])(
    'stores the normal rejection when the category is %s',
    async (_name, reread) => {
      const harness = build('SUBMIT', {
        categoryScript: { travel: [version(3), reread] },
        execute: cancelFirst(1),
      });

      const record = await perform(harness, 'SUBMIT');

      expect(record.outcome).toBe('REJECTED');
      expect(code(record)).not.toBe('VERSION_CONFLICT');
      expect(harness.sent).toHaveLength(1);
    },
  );

  it('stores VERSION_CONFLICT for a second category change', async () => {
    const harness = build('SUBMIT', {
      categoryScript: { travel: [version(3), version(4), version(5)] },
      execute: cancelFirst(2),
    });

    expect(code(await perform(harness, 'SUBMIT'))).toBe('VERSION_CONFLICT');
    expect(harness.sent).toHaveLength(2);
  });

  describe('at exhaustion', () => {
    const exhausted = (final: unknown, earlier = [3, 3, 3]) => {
      const original = cancelled();
      const harness = build('SUBMIT', {
        categoryScript: {
          travel: [...earlier.map((v) => version(v)), final as never],
        },
        execute: () => Promise.reject(original),
      });
      return { original, ...harness };
    };

    it.each([
      ['deleted', undefined],
      ['deactivated', version(9, { active: false })],
    ])(
      'persists the normal rejection for a first change to a %s category',
      async (_name, final) => {
        const harness = exhausted(final);
        const record = await perform(harness, 'SUBMIT');
        expect(record.outcome).toBe('REJECTED');
        expect(code(record)).not.toBe('VERSION_CONFLICT');
        expect(harness.sent).toHaveLength(3);
      },
    );

    it('rethrows for a still valid first change, with no fourth commit and no conflict', async () => {
      const harness = exhausted(version(9));
      await expect(perform(harness, 'SUBMIT')).rejects.toBe(harness.original);
      expect(harness.sent).toHaveLength(3);
      expect(harness.store.size).toBe(0);
    });

    it('persists VERSION_CONFLICT for a repeated change', async () => {
      const harness = exhausted(version(9), [3, 4, 4]);
      expect(code(await perform(harness, 'SUBMIT'))).toBe('VERSION_CONFLICT');
      expect(harness.sent).toHaveLength(3);
    });
  });

  it('propagates a category reread failure unchanged', async () => {
    const failure = new Error('category read failed');
    let reads = 0;
    const harness = build('SUBMIT', { execute: cancelFirst(1) });
    const original = harness.deps.categories.getStored;
    (harness.deps.categories as { getStored: unknown }).getStored = (
      id: string,
    ) => (++reads === 1 ? original(id) : Promise.reject(failure));

    await expect(perform(harness, 'SUBMIT')).rejects.toBe(failure);
    expect(harness.store.size).toBe(0);
  });
});

describe('invalid requests', () => {
  it.each([
    [
      'an actor without an ID',
      { ...manager, userId: '' },
      context,
      'The actor is not valid.',
    ],
    [
      'a missing context',
      manager,
      undefined,
      'The request context is missing.',
    ],
    [
      'an invalid key',
      manager,
      { ...context, idempotencyKey: 'a b' },
      'The idempotency key is not valid.',
    ],
    [
      'an invalid correlation ID',
      manager,
      { ...context, correlationId: 'a b' },
      'The correlation ID is not valid.',
    ],
    [
      'a non-canonical time',
      manager,
      { ...context, now: '2026-10-14' },
      'The request time is not valid.',
    ],
  ])('refuses %s before any dependency call', (_name, who, ctx, message) => {
    const harness = build('APPROVE');
    expect(() =>
      harness.service.perform(
        who,
        claimId,
        'APPROVE',
        inputFor('APPROVE'),
        ctx as ClaimLifecycleContext,
      ),
    ).toThrow(new TypeError(message));
    noWork(harness.calls);
    expect(harness.sent).toEqual([]);
  });
});
