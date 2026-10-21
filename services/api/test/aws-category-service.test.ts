import type {
  TransactWriteCommandInput,
  TransactWriteCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import type { Actor, Category } from '@claimflow/domain';
import { describe, expect, it } from 'vitest';

import { DomainError } from '@claimflow/domain';
import { ZodError } from 'zod';

import { ApplicationError, NotFoundError } from '../src/application/errors.js';
import { AwsCategoryService } from '../src/adapters/aws/aws-category-service.js';
import type { ClaimLifecycleContext } from '../src/adapters/aws/aws-claim-lifecycle-service.js';
import { ClaimMutationCoordinator } from '../src/adapters/aws/claim-mutation-coordinator.js';
import { DynamoDbCategoryWriter } from '../src/adapters/aws/dynamodb-category-writer.js';
import { DynamoDbIdempotencyCoordinator } from '../src/adapters/aws/dynamodb-idempotency-coordinator.js';
import {
  decodeIdempotencyItem,
  encodeIdempotencyItem,
  idempotencyKey,
  type IdempotencyRecord,
} from '../src/adapters/aws/dynamodb-idempotency-items.js';
import { DynamoDbIdempotentTransactionCommitter } from '../src/adapters/aws/dynamodb-idempotent-transaction-committer.js';
import type { StoredCategory } from '../src/adapters/aws/dynamodb-items.js';

const tableName = 'ClaimFlow';
const now = '2026-10-14T10:41:00.000Z';

const admin: Actor = {
  userId: 'sub-dan',
  displayName: 'Dan Lee',
  roles: ['ADMIN'],
};
const aisha: Actor = {
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
const stored = (
  patch: Partial<Category> = {},
  claimCount = 0,
  lastEventVersion: number | undefined = 2,
): StoredCategory => ({
  category: { ...travel, ...patch },
  metadata: {
    claimCount,
    ...(lastEventVersion === undefined ? {} : { lastEventVersion }),
  },
});

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
const cancelFirst = (count: number) => {
  let sends = 0;
  return () =>
    ++sends <= count ? Promise.reject(cancelled()) : Promise.resolve();
};

interface Options {
  /** What the strongly consistent reread returns, per read; the last repeats. */
  script?: (StoredCategory | undefined)[];
  execute?: (input: TransactWriteCommandInput) => Promise<void>;
  getStored?: () => Promise<StoredCategory | undefined>;
  winner?: IdempotencyRecord;
  newId?: () => string;
}

function build(options: Options = {}) {
  const script = options.script ?? [stored()];
  const calls = { reads: 0, newId: 0 };
  const sent: TransactWriteCommandInput[] = [];
  const sleeps: number[] = [];
  const logs: { level: string; event: string; fields: unknown }[] = [];
  const store = new Map<string, IdempotencyRecord>();
  const keyOf = (r: { actorId: string; key: string }) =>
    idempotencyKey(r.actorId, r.key).PK;
  const executor = {
    execute: async (input: TransactWriteCommandInput) => {
      sent.push(input);
      await options.execute?.(input);
      const last = input.TransactItems!.at(-1)!.Put!.Item!;
      store.set(String(last.PK), decodeIdempotencyItem(last));
      return { $metadata: {} } as TransactWriteCommandOutput;
    },
  };
  const idempotency = new DynamoDbIdempotencyCoordinator({
    finder: {
      find: (actorId: string, key: string) =>
        Promise.resolve(store.get(idempotencyKey(actorId, key).PK)),
    },
    rejections: {
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
    },
  });
  const writer = new DynamoDbCategoryWriter({ executor, tableName });
  const service = new AwsCategoryService({
    mutations: new ClaimMutationCoordinator({
      lookup: idempotency,
      committer: new DynamoDbIdempotentTransactionCommitter({
        executor,
        lookup: idempotency,
      }),
      rejections: idempotency,
    }),
    categories: {
      getStored: () => {
        calls.reads += 1;
        if (options.getStored !== undefined) {
          return options.getStored();
        }
        const index = Math.min(calls.reads, script.length) - 1;
        return Promise.resolve(script[index]);
      },
    },
    writer,
    ids: {
      newId: () => {
        if (options.newId !== undefined) return options.newId();
        calls.newId += 1;
        return `id-${calls.newId}`;
      },
    },
    sleep: (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
    logger: {
      info: (event: string, fields?: unknown) =>
        logs.push({ level: 'info', event, fields }),
      warn: (event: string, fields?: unknown) =>
        logs.push({ level: 'warn', event, fields }),
      error: (event: string, fields?: unknown) =>
        logs.push({ level: 'error', event, fields }),
    },
  });
  return { service, calls, sent, sleeps, logs, store };
}

const newBody = {
  name: ' Meals ',
  currency: 'MYR',
  maxAmountMinor: 50_000,
  receiptRequiredAboveMinor: 5_000,
};
const create = (
  h: ReturnType<typeof build>,
  body: unknown = newBody,
  who = admin,
) => h.service.create(who, body, context);
const update = (
  h: ReturnType<typeof build>,
  body: unknown = { expectedVersion: 3, maxAmountMinor: 300_000 },
  who = admin,
  id = 'travel',
) => h.service.update(who, id, body, context);
const del = (
  h: ReturnType<typeof build>,
  body: unknown = { expectedVersion: 3 },
  who = admin,
  id = 'travel',
) => h.service.delete(who, id, body, context);

const outbox = (input: TransactWriteCommandInput) =>
  input
    .TransactItems!.filter((i) =>
      String(i.Put?.Item?.SK ?? '').startsWith('OUTBOX#'),
    )
    .map((i) => i.Put!.Item!);
const eventTypes = (input: TransactWriteCommandInput) =>
  outbox(input).map((item) => item.eventType);
const errorOf = (record: IdempotencyRecord) =>
  (record.response as { body: { error: { code: string } } }).body.error.code;
const statusOf = (record: IdempotencyRecord) =>
  (record.response as { status: number }).status;

describe('construction', () => {
  it('refuses missing dependencies', () => {
    const h = build();
    const deps = {
      mutations: { run: () => Promise.reject(new Error('x')) },
      categories: { getStored: () => Promise.resolve(undefined) },
      writer: new DynamoDbCategoryWriter({
        executor: { execute: () => Promise.resolve({} as never) },
        tableName,
      }),
      ids: { newId: () => 'x' },
      sleep: () => Promise.resolve(),
      random: () => 0.5,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    };
    expect(() => new AwsCategoryService(deps as never)).not.toThrow();
    for (const key of Object.keys(deps)) {
      expect(
        () => new AwsCategoryService({ ...deps, [key]: undefined }),
      ).toThrow(TypeError);
    }
    expect(h.service).toBeDefined();
  });
});

describe('create', () => {
  it('commits the category and its creation event, returning 201', async () => {
    const h = build();
    const record = await create(h);

    expect(statusOf(record)).toBe(201);
    expect(record.response).toMatchObject({
      body: {
        categoryId: 'id-1',
        name: 'Meals',
        active: true,
        version: 1,
        currency: 'MYR',
      },
    });
    expect(h.sent).toHaveLength(1);
    const items = h.sent[0]!.TransactItems!;
    expect(items.map((i) => Object.keys(i)[0])).toEqual(['Put', 'Put', 'Put']);
    expect(items[0]!.Put!.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(outbox(h.sent[0]!)).toEqual([
      expect.objectContaining({
        eventId: 'id-2',
        eventType: 'category.created',
      }),
    ]);
    expect(h.calls.reads).toBe(0);
  });

  it('keeps an explicit inactive state', async () => {
    const h = build();
    const record = await create(h, { ...newBody, active: false });
    expect(record.response).toMatchObject({ body: { active: false } });
  });

  it('replays the stored result without reading or generating anything', async () => {
    const h = build();
    const first = await create(h);
    const second = await create(h);

    expect(second).toEqual(first);
    expect(h.sent).toHaveLength(1);
    expect(h.calls.newId).toBe(2);
  });

  it('stores FORBIDDEN for a non-administrator and sends nothing', async () => {
    const h = build();
    const record = await create(h, newBody, aisha);
    expect(statusOf(record)).toBe(403);
    expect(errorOf(record)).toBe('FORBIDDEN');
    expect(h.sent).toHaveLength(0);
  });

  it.each([
    ['unknown field', { ...newBody, extra: 1 }],
    ['bad currency', { ...newBody, currency: 'xx' }],
    ['no body', null],
  ])('stores VALIDATION_FAILED for %s', async (_name, body) => {
    const h = build();
    const record = await create(h, body);
    expect(statusOf(record)).toBe(400);
    expect(errorOf(record)).toBe('VALIDATION_FAILED');
    expect(h.sent).toHaveLength(0);
  });

  it('stores a domain validation failure', async () => {
    const h = build();
    const record = await create(h, {
      ...newBody,
      name: '   ',
    });
    expect(statusOf(record)).toBeLessThan(500);
    expect(h.sent).toHaveLength(0);
  });

  it('retries a cancelled commit with the same ID and event ID', async () => {
    const h = build({
      script: [undefined],
      execute: cancelFirst(1),
    });
    const record = await create(h);

    expect(statusOf(record)).toBe(201);
    expect(h.sent).toHaveLength(2);
    expect(h.calls.newId).toBe(2);
    expect(outbox(h.sent[1]!)[0]!.eventId).toBe(outbox(h.sent[0]!)[0]!.eventId);
    expect(h.sleeps).toHaveLength(1);
    expect(h.logs.map((l) => l.event)).toEqual(['category.create.retry']);
  });

  it('rethrows the cancellation when the new ID already exists', async () => {
    const h = build({
      script: [stored({ categoryId: 'id-1' })],
      execute: cancelFirst(1),
    });
    await expect(create(h)).rejects.toMatchObject({
      name: 'TransactionCanceledException',
    });
    expect(h.sent).toHaveLength(1);
  });

  it('rethrows an unresolved cancellation after three commits', async () => {
    const h = build({ script: [undefined], execute: cancelFirst(9) });
    await expect(create(h)).rejects.toMatchObject({
      name: 'TransactionCanceledException',
    });
    expect(h.sent).toHaveLength(3);
    expect(h.sleeps).toHaveLength(2);
    expect(h.logs.at(-1)).toMatchObject({
      level: 'warn',
      event: 'category.create.retries_exhausted',
    });
  });

  it('returns a concurrent winner found on recovery', async () => {
    let first = true;
    const racing: ReturnType<typeof build> = build({
      script: [undefined],
      execute: (input) => {
        if (!first) return Promise.resolve();
        first = false;
        const last = input.TransactItems!.at(-1)!.Put!.Item!;
        racing.store.set(String(last.PK), decodeIdempotencyItem(last));
        return Promise.reject(cancelled());
      },
    });
    const record = await create(racing);
    expect(statusOf(record)).toBe(201);
    expect(racing.sent).toHaveLength(1);
    expect(racing.calls.reads).toBe(0);
  });

  it('propagates non-cancellation failures unchanged', async () => {
    const failure = new Error('boom');
    const h = build({ execute: () => Promise.reject(failure) });
    await expect(create(h)).rejects.toThrow();
    expect(h.store.size).toBe(0);
  });
});

describe('update', () => {
  it('records a policy change at the next version, chained from lastEventVersion', async () => {
    const h = build();
    const record = await update(h);

    expect(statusOf(record)).toBe(200);
    expect(record.response).toMatchObject({
      body: { categoryId: 'travel', version: 4, maxAmountMinor: 300_000 },
    });
    const events = outbox(h.sent[0]!);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'category.policy-changed',
      eventId: 'id-1',
    });
    expect(JSON.stringify(events[0])).toContain('"previousEventVersion":2');
    const op = h.sent[0]!.TransactItems![0]!.Update!;
    expect(op.UpdateExpression).toContain('#lastEventVersion');
    expect(h.calls.reads).toBe(1);
  });

  it('records the policy change before the deactivation', async () => {
    const h = build();
    await update(h, {
      expectedVersion: 3,
      active: false,
      currency: 'SGD',
    });
    expect(eventTypes(h.sent[0]!)).toEqual([
      'category.policy-changed',
      'category.deactivated',
    ]);
    expect(outbox(h.sent[0]!).map((e) => e.eventId)).toEqual(['id-1', 'id-2']);
  });

  it('records an activation', async () => {
    const h = build({ script: [stored({ active: false })] });
    await update(h, { expectedVersion: 3, active: true });
    expect(eventTypes(h.sent[0]!)).toEqual(['category.activated']);
  });

  it('publishes nothing for a name-only update and keeps lastEventVersion', async () => {
    const h = build();
    const record = await update(h, { expectedVersion: 3, name: ' Trips ' });

    expect(record.response).toMatchObject({
      body: { name: 'Trips', version: 4 },
    });
    expect(outbox(h.sent[0]!)).toEqual([]);
    expect(
      h.sent[0]!.TransactItems![0]!.Update!.UpdateExpression,
    ).not.toContain('#lastEventVersion');
  });

  it('chains the first event from a category that never published', async () => {
    const fresh = stored();
    const h = build({
      script: [{ ...fresh, metadata: { claimCount: 0 } }],
    });
    await update(h);
    expect(JSON.stringify(outbox(h.sent[0]!)[0])).toContain(
      '"previousEventVersion":null',
    );
  });

  it('replays without reading again', async () => {
    const h = build();
    const first = await update(h);
    const second = await update(h);
    expect(second).toEqual(first);
    expect(h.calls.reads).toBe(1);
    expect(h.sent).toHaveLength(1);
  });

  it('stores NOT_FOUND for a missing category, even for a non-administrator, as the local flow does', async () => {
    const h = build({ script: [undefined] });
    const record = await update(h, null, aisha);
    expect(statusOf(record)).toBe(400); // an absent body is invalid input first
    const again = await update(
      build({ script: [undefined] }),
      { expectedVersion: 3, name: 'x' },
      aisha,
    );
    expect(errorOf(again)).toBe('NOT_FOUND');
  });

  it('stores FORBIDDEN for a non-administrator of an existing category', async () => {
    const h = build();
    const record = await update(h, { expectedVersion: 3, name: 'x' }, aisha);
    expect(errorOf(record)).toBe('FORBIDDEN');
    expect(h.sent).toHaveLength(0);
  });

  it('stores VERSION_CONFLICT for a stale version', async () => {
    const h = build();
    const record = await update(h, { expectedVersion: 2, name: 'x' });
    expect(statusOf(record)).toBe(409);
    expect(errorOf(record)).toBe('VERSION_CONFLICT');
  });

  it('stores NOT_FOUND for an invalid route ID before parsing the body', async () => {
    const h = build();
    const record = await update(h, { nonsense: true }, admin, 'not valid!');
    expect(errorOf(record)).toBe('NOT_FOUND');
    expect(h.calls.reads).toBe(0);
  });

  it('retries with the same event IDs while the category is unchanged', async () => {
    const h = build({ execute: cancelFirst(2) });
    const record = await update(h, {
      expectedVersion: 3,
      active: false,
      currency: 'SGD',
    });
    expect(statusOf(record)).toBe(200);
    expect(h.sent).toHaveLength(3);
    const ids = h.sent.map((s) => outbox(s).map((e) => e.eventId));
    expect(ids).toEqual([ids[0], ids[0], ids[0]]);
    expect(h.calls.newId).toBe(2);
    expect(h.sleeps).toEqual([37, 75]);
  });

  it('stores VERSION_CONFLICT when the category moved on during recovery', async () => {
    const h = build({
      script: [stored(), stored({ version: 4 })],
      execute: cancelFirst(1),
    });
    const record = await update(h);
    expect(errorOf(record)).toBe('VERSION_CONFLICT');
    expect(h.sent).toHaveLength(1);
  });

  it('stores NOT_FOUND when the category disappeared during recovery', async () => {
    const h = build({
      script: [stored(), undefined],
      execute: cancelFirst(1),
    });
    const record = await update(h);
    expect(errorOf(record)).toBe('NOT_FOUND');
  });

  it('rethrows the cancellation unchanged at the cap when nothing changed', async () => {
    const h = build({ execute: cancelFirst(9) });
    await expect(update(h)).rejects.toMatchObject({
      name: 'TransactionCanceledException',
    });
    expect(h.sent).toHaveLength(3);
    expect(h.calls.reads).toBe(4);
    expect(h.logs.at(-1)).toMatchObject({
      event: 'category.update.retries_exhausted',
      fields: { operation: 'category.update', retries: 2 },
    });
  });

  it('stores VERSION_CONFLICT at the cap when the final check finds a change', async () => {
    const h = build({
      script: [stored(), stored(), stored(), stored({ version: 4 })],
      execute: cancelFirst(9),
    });
    const record = await update(h);
    expect(errorOf(record)).toBe('VERSION_CONFLICT');
    expect(h.sent).toHaveLength(3);
  });

  it('returns a concurrent winner found by the recovery lookup', async () => {
    let first = true;
    const h: ReturnType<typeof build> = build({
      execute: (input) => {
        if (!first) return Promise.resolve();
        first = false;
        const last = input.TransactItems!.at(-1)!.Put!.Item!;
        h.store.set(String(last.PK), decodeIdempotencyItem(last));
        return Promise.reject(cancelled());
      },
    });
    const record = await update(h);
    expect(statusOf(record)).toBe(200);
    expect(h.sent).toHaveLength(1);
    expect(h.calls.reads).toBe(1);
  });

  it('propagates a reader failure unchanged, storing nothing', async () => {
    const h = build({ getStored: () => Promise.reject(new Error('read')) });
    await expect(update(h)).rejects.toThrow('read');
    expect(h.store.size).toBe(0);
  });
});

describe('delete', () => {
  it('deletes an unused category with the deletion event, returning 204', async () => {
    const h = build();
    const record = await del(h);

    expect(statusOf(record)).toBe(204);
    const items = h.sent[0]!.TransactItems!;
    expect(items.map((i) => Object.keys(i)[0])).toEqual([
      'Delete',
      'Put',
      'Put',
    ]);
    expect(items[0]!.Delete!.ConditionExpression).toContain('claimCount');
    expect(outbox(h.sent[0]!)).toEqual([
      expect.objectContaining({
        eventType: 'category.deleted',
        eventId: 'id-1',
      }),
    ]);
    expect(JSON.stringify(outbox(h.sent[0]!)[0])).toContain(
      '"previousEventVersion":2',
    );
  });

  it('stores CATEGORY_IN_USE for a category claims use', async () => {
    const h = build({ script: [stored({}, 2)] });
    const record = await del(h);
    expect(statusOf(record)).toBe(409);
    expect(errorOf(record)).toBe('CATEGORY_IN_USE');
    expect(h.sent).toHaveLength(0);
  });

  it('checks the version before the use protection', async () => {
    const h = build({ script: [stored({}, 2)] });
    const record = await del(h, { expectedVersion: 1 });
    expect(errorOf(record)).toBe('VERSION_CONFLICT');
  });

  it('stores FORBIDDEN before reading anything for a non-administrator', async () => {
    const h = build();
    const record = await del(h, { expectedVersion: 3 }, aisha);
    expect(errorOf(record)).toBe('FORBIDDEN');
    expect(h.calls.reads).toBe(0);
  });

  it('stores NOT_FOUND for a missing category and for a bad body', async () => {
    const h = build({ script: [undefined] });
    expect(errorOf(await del(h))).toBe('NOT_FOUND');
    const bad = build();
    const record = await bad.service.delete(admin, 'travel', {}, context);
    expect(errorOf(record)).toBe('VALIDATION_FAILED');
  });

  it('replays the stored result', async () => {
    const h = build();
    const first = await del(h);
    expect(await del(h)).toEqual(first);
    expect(h.sent).toHaveLength(1);
    expect(h.calls.reads).toBe(1);
  });

  it('retries with the same event ID', async () => {
    const h = build({ execute: cancelFirst(1) });
    const record = await del(h);
    expect(statusOf(record)).toBe(204);
    expect(h.sent).toHaveLength(2);
    expect(outbox(h.sent[1]!)[0]!.eventId).toBe(outbox(h.sent[0]!)[0]!.eventId);
    expect(h.calls.newId).toBe(1);
  });

  it('stores CATEGORY_IN_USE when a claim took the category during recovery', async () => {
    const h = build({
      script: [stored(), stored({}, 1)],
      execute: cancelFirst(1),
    });
    const record = await del(h);
    expect(errorOf(record)).toBe('CATEGORY_IN_USE');
    expect(h.sent).toHaveLength(1);
  });

  it('stores VERSION_CONFLICT and NOT_FOUND from the recovery reread', async () => {
    const moved = build({
      script: [stored(), stored({ version: 4 })],
      execute: cancelFirst(1),
    });
    expect(errorOf(await del(moved))).toBe('VERSION_CONFLICT');
    const gone = build({
      script: [stored(), undefined],
      execute: cancelFirst(1),
    });
    expect(errorOf(await del(gone))).toBe('NOT_FOUND');
  });

  it('stores CATEGORY_IN_USE at the cap when the final check finds a claim', async () => {
    const h = build({
      script: [stored(), stored(), stored(), stored({}, 3)],
      execute: cancelFirst(9),
    });
    const record = await del(h);
    expect(errorOf(record)).toBe('CATEGORY_IN_USE');
    expect(h.sent).toHaveLength(3);
  });

  it('rethrows an unresolved cancellation at the cap', async () => {
    const h = build({ execute: cancelFirst(9) });
    await expect(del(h)).rejects.toMatchObject({
      name: 'TransactionCanceledException',
    });
    expect(h.sent).toHaveLength(3);
    expect(h.logs.at(-1)).toMatchObject({
      event: 'category.delete.retries_exhausted',
    });
  });

  it('propagates other transaction failures unchanged', async () => {
    const h = build({ execute: () => Promise.reject(new Error('down')) });
    await expect(del(h)).rejects.toThrow();
    expect(h.sent).toHaveLength(1);
    expect(h.store.size).toBe(0);
  });

  it('refuses an invalid request context before any dependency call', () => {
    const h = build();
    expect(() =>
      h.service.delete(admin, 'travel', {}, { ...context, fingerprint: 'x' }),
    ).toThrow(TypeError);
    expect(() =>
      h.service.delete(admin, 'travel', {}, { ...context, correlationId: '!' }),
    ).toThrow(TypeError);
    expect(h.calls.reads).toBe(0);
  });
});

describe('error boundaries', () => {
  const businessErrors: [string, () => Error][] = [
    ['NotFoundError', () => new NotFoundError('x')],
    ['ApplicationError', () => new ApplicationError('CATEGORY_IN_USE', 'x')],
    ['DomainError', () => new DomainError('FORBIDDEN', 'x')],
    ['ZodError', () => new ZodError([])],
  ];
  const operations: [
    string,
    (h: ReturnType<typeof build>) => Promise<unknown>,
  ][] = [
    ['update', (h) => update(h)],
    ['delete', (h) => del(h)],
  ];

  for (const [name, make] of businessErrors) {
    for (const [op, run] of operations) {
      it(`propagates a reader ${name} from ${op} without storing or committing`, async () => {
        const failure = make();
        const h = build({ getStored: () => Promise.reject(failure) });
        await expect(run(h)).rejects.toBe(failure);
        expect(h.store.size).toBe(0);
        expect(h.sent).toHaveLength(0);
      });
    }

    it(`propagates an ID generator ${name} from create without storing or committing`, async () => {
      const failure = make();
      const h = build({
        newId: () => {
          throw failure;
        },
      });
      await expect(create(h)).rejects.toBe(failure);
      expect(h.store.size).toBe(0);
      expect(h.sent).toHaveLength(0);
    });
  }

  it('propagates a reader business error raised during recovery', async () => {
    const failure = new NotFoundError('x');
    let reads = 0;
    const h = build({
      getStored: () =>
        ++reads === 1 ? Promise.resolve(stored()) : Promise.reject(failure),
      execute: cancelFirst(1),
    });
    await expect(update(h)).rejects.toBe(failure);
    expect(h.store.size).toBe(0);
  });

  it('still persists ordinary schema, domain, and application rejections', async () => {
    const schema = await create(build(), { ...newBody, extra: 1 });
    expect(errorOf(schema)).toBe('VALIDATION_FAILED');
    const domain = await create(build(), { ...newBody, name: '   ' });
    expect(statusOf(domain)).toBeLessThan(500);
    expect(errorOf(await create(build(), newBody, aisha))).toBe('FORBIDDEN');
    expect(
      errorOf(
        await update(build({ script: [undefined] }), {
          expectedVersion: 3,
          name: 'x',
        }),
      ),
    ).toBe('NOT_FOUND');
    expect(errorOf(await del(build({ script: [stored({}, 1)] })))).toBe(
      'CATEGORY_IN_USE',
    );
  });
});
