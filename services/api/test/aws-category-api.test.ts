import type {
  TransactWriteCommandInput,
  TransactWriteCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import type { Actor, Category } from '@claimflow/domain';
import { describe, expect, it } from 'vitest';

import { AwsCategoryService } from '../src/adapters/aws/aws-category-service.js';
import {
  categoryCreateMutation,
  categoryDeleteMutation,
  categoryUpdateMutation,
} from '../src/adapters/aws/claim-mutations.js';
import { categoryListRead } from '../src/adapters/aws/claim-reads.js';
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
import type { Application } from '../src/composition.js';
import {
  createApiHandler,
  type ApiRequest,
  type ApiResponse,
} from '../src/http/api-handler.js';
import { createAwsRoutes } from '../src/http/routes.js';

const tableName = 'ClaimFlow';
const now = new Date('2026-10-14T10:41:00.000Z');

const actors: Record<string, Actor> = {
  'sub-aisha': {
    userId: 'sub-aisha',
    displayName: 'Aisha Rahman',
    roles: ['EMPLOYEE'],
  },
  'sub-dan': { userId: 'sub-dan', displayName: 'Dan Lee', roles: ['ADMIN'] },
};
const category = (id: string, name: string, version = 3): Category => ({
  categoryId: id,
  name,
  active: true,
  currency: 'MYR',
  maxAmountMinor: 200_000,
  receiptRequiredAboveMinor: 20_000,
  version,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedBy: 'sub-dan',
});

interface Options {
  claimCount?: number;
  readFails?: boolean;
  withoutAws?: boolean;
}

/** The real category service behind ApiHandler, over fake AWS dependencies. */
function build(options: Options = {}) {
  const categories = [
    category('travel', 'Travel'),
    category('meals', 'Meals'),
    category('office', 'Office'),
  ];
  const sent: TransactWriteCommandInput[] = [];
  const store = new Map<string, IdempotencyRecord>();
  const local = { calls: 0 };
  const executor = {
    execute: (input: TransactWriteCommandInput) => {
      sent.push(input);
      const last = input.TransactItems!.at(-1)!.Put!.Item!;
      store.set(String(last.PK), decodeIdempotencyItem(last));
      return Promise.resolve({ $metadata: {} } as TransactWriteCommandOutput);
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
        store.set(idempotencyKey(record.actorId, record.key).PK, record);
        return Promise.resolve();
      },
    },
  });
  let ids = 0;
  const reader = {
    getStored: ((id: string): Promise<StoredCategory | undefined> => {
      if (options.readFails === true) {
        return Promise.reject(new Error('secret table detail'));
      }
      const found = categories.find((c) => c.categoryId === id);
      return Promise.resolve(
        found === undefined
          ? undefined
          : {
              category: found,
              metadata: {
                claimCount: options.claimCount ?? 0,
                lastEventVersion: 2,
              },
            },
      );
    }) as never,
    list: () => Promise.resolve(categories),
  };
  const service = new AwsCategoryService({
    mutations: new ClaimMutationCoordinator({
      lookup: idempotency,
      committer: new DynamoDbIdempotentTransactionCommitter({
        executor,
        lookup: idempotency,
      }),
      rejections: idempotency,
    }),
    categories: reader,
    writer: new DynamoDbCategoryWriter({ executor, tableName }),
    ids: { newId: () => `id-${++ids}` },
    sleep: () => Promise.resolve(),
    random: () => 0.5,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  });
  const trap = () => {
    local.calls += 1;
    return Promise.reject(new Error('local handler must not run'));
  };
  const app = {
    idempotency: { run: trap },
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    categories: { list: trap, create: trap, update: trap, delete: trap },
  } as unknown as Application;
  const handler = createApiHandler(app, {
    routes: createAwsRoutes(app),
    authenticate: (request) =>
      Promise.resolve(actors[request.verifiedSubject ?? '']),
    ...(options.withoutAws === true
      ? {}
      : {
          mutations: {
            'category.create': categoryCreateMutation(service),
            'category.update': categoryUpdateMutation(service),
            'category.delete': categoryDeleteMutation(service),
          },
          reads: { 'category.list': categoryListRead(reader) },
        }),
    now: () => now,
  });
  return { handler, sent, store, local };
}

function call(
  method: string,
  path: string,
  body: unknown,
  init: { key?: string | null; subject?: string | null } = {},
): ApiRequest {
  const bytes = new TextEncoder().encode(
    body === undefined ? '' : JSON.stringify(body),
  );
  const key = init.key === undefined ? 'mutation-key-0001' : init.key;
  const subject = init.subject === undefined ? 'sub-dan' : init.subject;
  return {
    method,
    path: `/api/v1${path}`,
    query: {},
    headers: {
      'content-type': 'application/json',
      ...(key === null ? {} : { 'idempotency-key': key }),
    },
    ...(subject === null ? {} : { verifiedSubject: subject }),
    readBody: (limit) =>
      Promise.resolve(bytes.byteLength > limit ? undefined : bytes),
  };
}
const newBody = {
  name: 'Lodging',
  currency: 'MYR',
  maxAmountMinor: 80_000,
  receiptRequiredAboveMinor: 8_000,
};
const bodyOf = (response: ApiResponse) =>
  JSON.parse(response.body as string) as Record<string, any>;
const outbox = (input: TransactWriteCommandInput) =>
  input
    .TransactItems!.filter((i) =>
      String(i.Put?.Item?.SK ?? '').startsWith('OUTBOX#'),
    )
    .map((i) => i.Put!.Item!);

describe('category routes through the AWS path', () => {
  it('lists every category by name for any signed-in user', async () => {
    const { handler, local } = build();
    const response = await handler(
      call('GET', '/categories', undefined, {
        key: null,
        subject: 'sub-aisha',
      }),
    );
    expect(response.status).toBe(200);
    expect(
      (bodyOf(response).items as { name: string }[]).map((c) => c.name),
    ).toEqual(['Meals', 'Office', 'Travel']);
    expect(bodyOf(response).items[0]).toEqual({
      categoryId: 'meals',
      name: 'Meals',
      active: true,
      currency: 'MYR',
      maxAmountMinor: 200_000,
      receiptRequiredAboveMinor: 20_000,
      version: 3,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(local.calls).toBe(0);
  });

  it('creates a category (201) with its event and no replay header', async () => {
    const { handler, sent, local } = build();
    const response = await handler(call('POST', '/categories', newBody));

    expect(response.status).toBe(201);
    expect(bodyOf(response)).toMatchObject({
      categoryId: 'id-1',
      name: 'Lodging',
      version: 1,
      active: true,
    });
    expect(response.headers).not.toHaveProperty('Idempotent-Replayed');
    expect(outbox(sent[0]!).map((e) => e.eventType)).toEqual([
      'category.created',
    ]);
    expect(local.calls).toBe(0);
  });

  it('replays a create from the stored record', async () => {
    const { handler, sent } = build();
    const first = await handler(call('POST', '/categories', newBody));
    const second = await handler(call('POST', '/categories', newBody));

    expect(second.status).toBe(201);
    expect(bodyOf(second)).toEqual(bodyOf(first));
    expect(sent).toHaveLength(1);
  });

  it('updates the route category, taking its ID only from the route', async () => {
    const { handler, sent } = build();
    const response = await handler(
      call('PATCH', '/categories/travel', {
        expectedVersion: 3,
        active: false,
      }),
    );
    expect(response.status).toBe(200);
    expect(bodyOf(response)).toMatchObject({
      categoryId: 'travel',
      version: 4,
      active: false,
    });
    expect(outbox(sent[0]!).map((e) => e.eventType)).toEqual([
      'category.deactivated',
    ]);

    const bodyId = await handler(
      call(
        'PATCH',
        '/categories/meals',
        { expectedVersion: 3, categoryId: 'travel' },
        { key: 'mutation-key-0002' },
      ),
    );
    expect(bodyId.status).toBe(400);
  });

  it('publishes nothing for a name-only update', async () => {
    const { handler, sent } = build();
    const response = await handler(
      call('PATCH', '/categories/travel', {
        expectedVersion: 3,
        name: 'Trips',
      }),
    );
    expect(response.status).toBe(200);
    expect(outbox(sent[0]!)).toEqual([]);
  });

  it('deletes an unused category with 204 and no body', async () => {
    const { handler, sent } = build();
    const response = await handler(
      call('DELETE', '/categories/office', { expectedVersion: 3 }),
    );
    expect(response.status).toBe(204);
    expect(response.body).toBeUndefined();
    expect(outbox(sent[0]!).map((e) => e.eventType)).toEqual([
      'category.deleted',
    ]);
  });

  it('refuses to delete a category claims use with CATEGORY_IN_USE', async () => {
    const { handler, sent } = build({ claimCount: 2 });
    const response = await handler(
      call('DELETE', '/categories/office', { expectedVersion: 3 }),
    );
    expect(response.status).toBe(409);
    expect(bodyOf(response).error.code).toBe('CATEGORY_IN_USE');
    expect(sent).toHaveLength(0);
  });

  it.each([
    ['POST', '/categories', newBody],
    ['PATCH', '/categories/travel', { expectedVersion: 3, name: 'x' }],
    ['DELETE', '/categories/travel', { expectedVersion: 3 }],
  ])('refuses a non-administrator %s %s', async (method, path, body) => {
    const { handler, sent } = build();
    const response = await handler(
      call(method, path, body, { subject: 'sub-aisha' }),
    );
    expect(response.status).toBe(403);
    expect(bodyOf(response).error.code).toBe('FORBIDDEN');
    expect(sent).toHaveLength(0);
  });

  it('answers a stale version and a missing category as the local flow does', async () => {
    const { handler } = build();
    const stale = await handler(
      call('PATCH', '/categories/travel', { expectedVersion: 1, name: 'x' }),
    );
    expect(stale.status).toBe(409);
    expect(bodyOf(stale).error.code).toBe('VERSION_CONFLICT');
    const missing = await handler(
      call(
        'DELETE',
        '/categories/nothing',
        { expectedVersion: 1 },
        { key: 'mutation-key-0002' },
      ),
    );
    expect(missing.status).toBe(404);
  });

  it('requires an idempotency key and authentication', async () => {
    const { handler, sent } = build();
    expect(
      (await handler(call('POST', '/categories', newBody, { key: null })))
        .status,
    ).toBe(400);
    expect(
      (await handler(call('POST', '/categories', newBody, { subject: null })))
        .status,
    ).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it('answers a dependency failure with a generic 500 that leaks nothing', async () => {
    const { handler, store, local } = build({ readFails: true });
    const response = await handler(
      call('PATCH', '/categories/travel', { expectedVersion: 3, name: 'x' }),
    );
    expect(response.status).toBe(500);
    expect(response.body).not.toContain('secret table detail');
    expect(store.size).toBe(0);
    expect(local.calls).toBe(0);
  });

  it('stays local for every category operation when nothing is registered', async () => {
    const { handler, local } = build({ withoutAws: true });
    await handler(
      call('GET', '/categories', undefined, {
        key: null,
        subject: 'sub-aisha',
      }),
    );
    await handler(call('POST', '/categories', newBody));
    expect(local.calls).toBeGreaterThan(0);
  });
});
