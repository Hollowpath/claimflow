import { readFileSync } from 'node:fs';

import type { Category, Claim } from '@claimflow/domain';
import { describe, expect, it } from 'vitest';

import {
  encodeCategoryItem,
  encodeClaimItem,
} from '../src/adapters/aws/dynamodb-items.js';
import {
  assertRegistrationsComplete,
  createAwsApplicationHandler,
  failClosed,
  type AwsApplicationOptions,
} from '../src/aws-composition.js';
import {
  createApiHandler,
  OperationNotRegisteredError,
  type ApiRequest,
  type ApiResponse,
} from '../src/http/api-handler.js';
import { createAwsRoutes, type AwsRouteServices } from '../src/http/routes.js';

const tableName = 'ClaimFlow';
const claimId = '4ce0c74b-9c64-46d6-87ba-07fb71b0628c';
const now = new Date('2026-10-14T10:41:00.000Z');

const profile = (
  userId: string,
  displayName: string,
  roles: string[],
  managerId?: string,
) => ({
  PK: `USER#${userId}`,
  SK: 'PROFILE',
  entityType: 'UserProfile',
  userId,
  displayName,
  title: 'Staff',
  roles,
  ...(managerId === undefined ? {} : { managerId }),
});
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
const draft: Claim = {
  claimId,
  employeeId: 'sub-aisha',
  categoryId: 'travel',
  amount: { amountMinor: 45_000, currency: 'MYR' },
  merchant: 'Regional Airline',
  status: 'DRAFT',
  version: 4,
  createdAt: '2026-10-14T10:00:00.000Z',
  updatedAt: '2026-10-14T10:20:00.000Z',
};

type Item = Record<string, unknown>;

/** An in-memory stand-in for the DynamoDB document client. */
function fakeDynamo() {
  const items = new Map<string, Item>();
  const keyOf = (item: Item) => `${String(item.PK)}|${String(item.SK)}`;
  const seed = (item: Item) => items.set(keyOf(item), item);
  seed(profile('sub-aisha', 'Aisha Rahman', ['EMPLOYEE'], 'sub-ben'));
  seed(profile('sub-ben', 'Ben Tan', ['MANAGER']));
  seed(profile('sub-dan', 'Dan Lee', ['ADMIN']));
  seed(encodeCategoryItem(travel, { claimCount: 0, lastEventVersion: 2 }));
  seed(encodeClaimItem(draft));

  const state = {
    commands: [] as string[],
    transactions: 0,
    failure: undefined as Error | undefined,
  };
  const client = {
    send: (command: { constructor: { name: string }; input: any }) => {
      const kind = command.constructor.name;
      state.commands.push(kind);
      if (state.failure !== undefined) {
        return Promise.reject(state.failure);
      }
      const input = command.input;
      switch (kind) {
        case 'GetCommand':
          return Promise.resolve({ Item: items.get(keyOf(input.Key)) });
        case 'BatchGetCommand':
          return Promise.resolve({
            Responses: {
              [tableName]: (
                input.RequestItems[tableName].Keys as Item[]
              ).flatMap((key) => items.get(keyOf(key)) ?? []),
            },
          });
        case 'QueryCommand':
          return Promise.resolve({
            Items: [...items.values()].filter(
              (item) =>
                item.PK === input.ExpressionAttributeValues[':pk'] &&
                String(item.SK).startsWith(
                  input.ExpressionAttributeValues[':category'],
                ),
            ),
          });
        case 'PutCommand':
          seed(input.Item);
          return Promise.resolve({});
        case 'TransactWriteCommand':
          state.transactions += 1;
          for (const entry of input.TransactItems) {
            if (entry.Put !== undefined) seed(entry.Put.Item);
          }
          return Promise.resolve({});
        default:
          return Promise.reject(new Error(`unexpected ${kind}`));
      }
    },
  };
  return { client, items, state };
}

function build(patch: Partial<AwsApplicationOptions> = {}) {
  const dynamo = fakeDynamo();
  const logs: unknown[] = [];
  let ids = 0;
  const signed: string[] = [];
  const options: AwsApplicationOptions = {
    config: { tableName, receiptBucketName: 'claimflow-receipts-test' },
    clients: {
      dynamo: dynamo.client as never,
      s3: {} as never,
      signUploadForm: (request) => {
        signed.push(request.key);
        return Promise.resolve({
          url: 'https://claimflow-receipts-test.s3.amazonaws.com/',
          fields: {
            ...request.fields,
            Policy: 'policy',
            'X-Amz-Signature': 'sig',
          },
        });
      },
      signDownloadUrl: () => Promise.resolve('https://example.invalid/'),
    },
    clock: { now: () => now },
    ids: { newId: () => `id-${++ids}` },
    logger: {
      info: (...a: unknown[]) => logs.push(a),
      warn: (...a: unknown[]) => logs.push(a),
      error: (...a: unknown[]) => logs.push(a),
    },
    sleep: () => Promise.resolve(),
    random: () => 0.5,
    ...patch,
  };
  return {
    handler: createAwsApplicationHandler(options),
    dynamo,
    logs,
    signed,
  };
}

function call(
  method: string,
  path: string,
  body?: unknown,
  init: { subject?: string | null; key?: string | null } = {},
): ApiRequest {
  const bytes = new TextEncoder().encode(
    body === undefined ? '' : JSON.stringify(body),
  );
  const subject = init.subject === undefined ? 'sub-aisha' : init.subject;
  const key = init.key === undefined ? 'mutation-key-0001' : init.key;
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
const bodyOf = (response: ApiResponse) =>
  JSON.parse(response.body as string) as Record<string, any>;

describe('construction', () => {
  it.each([
    ['config', { config: undefined }],
    ['table name', { config: { tableName: ' ', receiptBucketName: 'b' } }],
    ['bucket name', { config: { tableName: 't', receiptBucketName: '' } }],
    ['clients', { clients: undefined }],
    ['clock', { clock: undefined }],
    ['ids', { ids: undefined }],
    ['logger', { logger: undefined }],
    ['sleep', { sleep: undefined }],
    ['random', { random: undefined }],
  ])('refuses a missing %s', (_name, patch) => {
    expect(() => build(patch as never)).toThrow(TypeError);
  });

  it('builds without reading or writing anything', () => {
    const { dynamo } = build();
    expect(dynamo.state.commands).toEqual([]);
  });

  it('imports no local persistence, development authentication, or local service', () => {
    const source = readFileSync(
      new URL('../src/aws-composition.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/adapters\/local/);
    expect(source).not.toMatch(/composition\.js/);
    expect(source).not.toMatch(/local-config|createLocal|JsonDatabase/);
  });
});

describe('requests through the AWS composition', () => {
  it('serves the health check without authentication', async () => {
    const { handler } = build();
    const response = await handler(
      call('GET', '/health', undefined, { subject: null }),
    );
    expect(response.status).toBe(200);
  });

  it('describes only the signed-in user from the directory', async () => {
    const { handler } = build();
    const response = await handler(call('GET', '/session'));
    expect(response.status).toBe(200);
    expect(bodyOf(response)).toMatchObject({
      user: {
        userId: 'sub-aisha',
        displayName: 'Aisha Rahman',
        roles: ['EMPLOYEE'],
      },
      users: [],
    });
  });

  it('has no development session routes', async () => {
    const { handler } = build();
    expect(
      (await handler(call('PUT', '/session', { userId: 'sub-dan' }))).status,
    ).toBe(404);
    expect((await handler(call('DELETE', '/session'))).status).toBe(404);
  });

  it('treats an unknown subject as signed out, for reads and writes', async () => {
    const { handler, dynamo } = build();
    const session = await handler(
      call('GET', '/session', undefined, { subject: 'sub-ghost' }),
    );
    expect(bodyOf(session).user).toBeNull();
    for (const request of [
      call('GET', '/categories', undefined, { subject: 'sub-ghost' }),
      call('GET', `/claims/${claimId}`, undefined, { subject: 'sub-ghost' }),
      call('POST', '/categories', { name: 'x' }, { subject: 'sub-ghost' }),
      call('POST', '/receipts', {}, { subject: 'sub-ghost' }),
    ]) {
      expect((await handler(request)).status).toBe(401);
    }
    expect(dynamo.state.transactions).toBe(0);
  });

  it('lists categories and reads a claim from the AWS readers', async () => {
    const { handler } = build();
    const categories = await handler(call('GET', '/categories'));
    expect(bodyOf(categories).items).toMatchObject([
      { categoryId: 'travel', name: 'Travel', version: 3 },
    ]);
    const claim = await handler(call('GET', `/claims/${claimId}`));
    expect(claim.status).toBe(200);
    expect(bodyOf(claim)).toMatchObject({
      claimId,
      version: 4,
      status: 'DRAFT',
    });
  });

  it('creates a category with one transaction and replays it', async () => {
    const { handler, dynamo } = build();
    const body = {
      name: 'Meals',
      currency: 'MYR',
      maxAmountMinor: 50_000,
      receiptRequiredAboveMinor: 5_000,
    };
    const first = await handler(
      call('POST', '/categories', body, { subject: 'sub-dan' }),
    );
    const second = await handler(
      call('POST', '/categories', body, { subject: 'sub-dan' }),
    );

    expect(first.status).toBe(201);
    expect(bodyOf(second)).toEqual(bodyOf(first));
    expect(dynamo.state.transactions).toBe(1);
  });

  it('refuses a category change by a non-administrator', async () => {
    const { handler, dynamo } = build();
    const response = await handler(call('POST', '/categories', { name: 'x' }));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(dynamo.state.transactions).toBe(0);
  });

  it('creates a claim for the signed-in employee', async () => {
    const { handler, dynamo } = build();
    const response = await handler(
      call('POST', '/claims', {
        categoryId: 'travel',
        merchant: 'Taxi',
        amount: { amountMinor: 1_000, currency: 'MYR' },
      }),
    );
    expect(response.status).toBe(201);
    expect(bodyOf(response)).toMatchObject({
      merchant: 'Taxi',
      status: 'DRAFT',
      version: 1,
    });
    expect(dynamo.state.transactions).toBe(1);
  });

  it('creates an upload target from a JSON declaration', async () => {
    const { handler, dynamo, signed } = build();
    const response = await handler(
      call('POST', '/receipts', {
        fileName: 'flight.pdf',
        contentType: 'application/pdf',
        sizeBytes: 52_144,
        checksumSha256: 'a1b2'.repeat(16),
      }),
    );
    expect(response.status).toBe(201);
    expect(bodyOf(response)).toMatchObject({
      receiptId: 'id-1',
      form: { fields: { 'X-Amz-Signature': 'sig' } },
    });
    expect(signed).toEqual(['uploads/pending/id-1']);
    expect(dynamo.state.transactions).toBe(1);
  });

  it('answers a dependency failure with a generic 500 and no local fallback', async () => {
    const { handler, dynamo, logs } = build();
    dynamo.state.failure = new Error('table secret detail');
    for (const request of [
      call('GET', '/categories'),
      call('GET', `/claims/${claimId}`),
      call('POST', '/claims', {}),
    ]) {
      const response = await handler(request);
      expect(response.status).toBe(401 === response.status ? 401 : 500);
      expect(String(response.body)).not.toContain('table secret detail');
    }
    expect(logs.length).toBeGreaterThan(0);
  });
});

describe('registration completeness and fail-closed behavior', () => {
  const services: AwsRouteServices = {
    sessions: {} as never,
    claims: failClosed(),
    receipts: failClosed(),
    categories: failClosed(),
  };
  const routes = createAwsRoutes(services);
  const ok = () => Promise.resolve({ status: 200 });
  const registrations = () => {
    const mutations: Record<string, () => Promise<{ status: number }>> = {};
    const reads: Record<string, () => Promise<{ status: number }>> = {};
    for (const route of routes) {
      if (route.operation === 'health' || route.operation === 'session.get')
        continue;
      (route.idempotent ? mutations : reads)[route.operation] = ok;
    }
    return { mutations, reads };
  };

  it('accepts a complete registration', () => {
    const { mutations, reads } = registrations();
    expect(() =>
      assertRegistrationsComplete(routes, mutations as never, reads as never),
    ).not.toThrow();
  });

  it('refuses a missing mutation, a missing read, a wrong kind, and an unknown operation', () => {
    const full = registrations();
    const without = (kind: 'mutations' | 'reads', operation: string) => {
      const copy = registrations();
      delete copy[kind][operation];
      return copy;
    };
    for (const [kind, operation] of [
      ['mutations', 'claim.create'],
      ['mutations', 'receipt.upload'],
      ['reads', 'claim.get'],
      ['reads', 'receipt.read'],
    ] as const) {
      const copy = without(kind, operation);
      expect(() =>
        assertRegistrationsComplete(
          routes,
          copy.mutations as never,
          copy.reads as never,
        ),
      ).toThrow(TypeError);
    }
    expect(() =>
      assertRegistrationsComplete(
        routes,
        { ...full.mutations, 'claim.get': ok } as never,
        full.reads as never,
      ),
    ).toThrow(TypeError);
    expect(() =>
      assertRegistrationsComplete(
        routes,
        { ...full.mutations, 'claim.typo': ok } as never,
        full.reads as never,
      ),
    ).toThrow(TypeError);
  });

  it('registers every route of the real composition', () => {
    // Building the handler runs the same completeness check.
    expect(() => build()).not.toThrow();
  });

  it('rejects an idempotent route with no registration and no local idempotency', async () => {
    const logs: unknown[] = [];
    const handler = createApiHandler(
      {
        logger: {
          info: () => undefined,
          warn: () => undefined,
          error: (...a: unknown[]) => logs.push(a),
        },
      },
      {
        routes,
        authenticate: () =>
          Promise.resolve({
            userId: 'sub-aisha',
            displayName: 'A',
            roles: ['EMPLOYEE'],
          }),
      },
    );
    const response = await handler(call('POST', '/claims', {}));
    expect(response.status).toBe(500);
    expect(JSON.stringify(logs)).toContain(OperationNotRegisteredError.name);
  });

  it('rejects an unregistered read instead of reaching a service', async () => {
    const handler = createApiHandler(
      {
        logger: {
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
        },
      },
      {
        routes,
        authenticate: () =>
          Promise.resolve({
            userId: 'sub-aisha',
            displayName: 'A',
            roles: ['EMPLOYEE'],
          }),
      },
    );
    const response = await handler(call('GET', '/categories'));
    expect(response.status).toBe(500);
  });
});
