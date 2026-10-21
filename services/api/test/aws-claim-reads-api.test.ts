import type { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { headers as apiHeaders } from '@claimflow/contracts';
import type {
  Actor,
  Category,
  Claim,
  ClaimHistoryEntry,
} from '@claimflow/domain';
import { describe, expect, it } from 'vitest';

import { claimReadOperations } from '../src/adapters/aws/claim-reads.js';
import { DynamoDbClaimReader } from '../src/adapters/aws/dynamodb-claim-reader.js';
import {
  encodeClaimItem,
  encodeHistoryItem,
  type DynamoItem,
} from '../src/adapters/aws/dynamodb-items.js';
import { ClaimQueryService } from '../src/application/claim-query-service.js';
import type { UserProfile } from '../src/application/ports.js';
import type { Application } from '../src/composition.js';
import {
  createApiHandler,
  type ApiRequest,
  type ApiResponse,
  type ReadOperation,
} from '../src/http/api-handler.js';
import { createAwsRoutes } from '../src/http/routes.js';

const tableName = 'ClaimFlow';
const time = (n: number) =>
  new Date(Date.parse('2026-10-01T00:00:00.000Z') + n * 60_000).toISOString();

const actors: Record<string, Actor> = {
  'sub-aisha': {
    userId: 'sub-aisha',
    displayName: 'Aisha Rahman',
    roles: ['EMPLOYEE'],
    managerId: 'sub-ben',
  },
  'sub-ben': { userId: 'sub-ben', displayName: 'Ben Tan', roles: ['MANAGER'] },
  'sub-dan': { userId: 'sub-dan', displayName: 'Dan Lee', roles: ['ADMIN'] },
  'sub-stranger': {
    userId: 'sub-stranger',
    displayName: 'Sam Stranger',
    roles: ['EMPLOYEE'],
  },
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
  {
    userId: 'sub-dan',
    displayName: 'Dan Lee',
    title: 'Finance',
    roles: ['ADMIN'],
  },
];
const travel: Category = {
  categoryId: 'travel',
  name: 'Travel',
  active: true,
  currency: 'MYR',
  maxAmountMinor: 200_000,
  receiptRequiredAboveMinor: 20_000,
  version: 3,
  createdAt: time(0),
  updatedAt: time(0),
  updatedBy: 'sub-dan',
};

const draft = (n: number): Claim => ({
  claimId: `claim-${String(n).padStart(3, '0')}`,
  employeeId: 'sub-aisha',
  categoryId: 'travel',
  amount: { amountMinor: 1_000 * n, currency: 'MYR' },
  merchant: `Merchant ${n}`,
  status: 'DRAFT',
  version: 2,
  createdAt: time(0),
  updatedAt: time(n),
});
const submitted = (n: number): Claim => ({
  ...draft(n),
  status: 'SUBMITTED',
  assignedManagerId: 'sub-ben',
  submittedAt: time(100 - n),
});
const claims = [submitted(1), submitted(2), draft(3)];
const history = (version: number): ClaimHistoryEntry => ({
  claimId: 'claim-001',
  version,
  action: 'UPDATE',
  toStatus: 'DRAFT',
  actorId: 'sub-aisha',
  occurredAt: time(version),
});
const entries = [history(1), history(2), history(3)];

/** The pre-ordered items of each query partition the fake table serves. */
const partitions: Record<string, DynamoItem[]> = {
  'EMPLOYEE#sub-aisha': [...claims].reverse().map((c) => encodeClaimItem(c)),
  'MANAGER#sub-ben#OPEN': [submitted(2), submitted(1)].map((c) =>
    encodeClaimItem(c),
  ),
  'STATUS#SUBMITTED': [submitted(2), submitted(1)].map((c) =>
    encodeClaimItem(c),
  ),
  CLAIM: [...claims].reverse().map((c) => encodeClaimItem(c)),
  'CLAIM#claim-001': entries.map((e) => encodeHistoryItem(e)),
};

interface Recorded {
  readonly kind: 'get' | 'query';
  readonly index?: string;
  readonly partition?: string;
}

/** A tiny fake table: gets by key, and pre-ordered pages with real paging. */
function fakeClient(failure?: Error) {
  const recorded: Recorded[] = [];
  return {
    recorded,
    client: {
      send: (command: GetCommand | QueryCommand) => {
        if (failure !== undefined) {
          return Promise.reject(failure);
        }
        if (command instanceof GetCommand) {
          recorded.push({ kind: 'get' });
          const claim = claims.find(
            (c) => `CLAIM#${c.claimId}` === command.input.Key?.PK,
          );
          return Promise.resolve({
            $metadata: {},
            ...(claim === undefined ? {} : { Item: encodeClaimItem(claim) }),
          });
        }
        const input = command.input;
        const partition = String(input.ExpressionAttributeValues![':pk']);
        recorded.push({
          kind: 'query',
          ...(input.IndexName === undefined ? {} : { index: input.IndexName }),
          partition,
        });
        const items = partitions[partition] ?? [];
        const start = input.ExclusiveStartKey;
        const from =
          start === undefined
            ? 0
            : items.findIndex(
                (item) => item.PK === start.PK && item.SK === start.SK,
              ) + 1;
        const page = items.slice(from, from + (input.Limit ?? items.length));
        const last = page.at(-1);
        return Promise.resolve({
          $metadata: {},
          Items: page,
          ...(from + page.length < items.length && last !== undefined
            ? {
                LastEvaluatedKey: Object.fromEntries(
                  Object.entries(last).filter(([name]) =>
                    /^(PK|SK|GSI\dPK|GSI\dSK)$/.test(name),
                  ),
                ),
              }
            : {}),
        });
      },
    },
  };
}

function build(
  options: {
    failure?: Error;
    withoutReads?: boolean;
    reads?: Record<string, ReadOperation>;
  } = {},
) {
  const { client, recorded } = fakeClient(options.failure);
  const local = { calls: 0 };
  const reader = new DynamoDbClaimReader({
    client: client,
    tableName,
  });
  const service = new ClaimQueryService({
    claims: reader,
    categories: { list: () => Promise.resolve([travel]) },
    users: {
      get: () => Promise.resolve(undefined),
      getMany: () => Promise.resolve(profiles),
    },
  });
  const trap = () => {
    local.calls += 1;
    return Promise.reject(new Error('local handler must not run'));
  };
  const app = {
    claims: {
      get: trap,
      history: trap,
      listMine: trap,
      listReviewQueue: trap,
      listAll: trap,
    },
    categories: { list: trap },
    idempotency: {},
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  } as unknown as Application;
  const handler = createApiHandler(app, {
    routes: createAwsRoutes(app),
    authenticate: (request) =>
      Promise.resolve(actors[request.verifiedSubject ?? '']),
    ...(options.withoutReads === true
      ? {}
      : { reads: options.reads ?? claimReadOperations(service) }),
  });
  return { handler, recorded, local };
}

/** The same reads over plain in-memory claims: what the local runtime returns. */
function localService() {
  const page = <T>(items: T[]) => Promise.resolve({ items });
  return new ClaimQueryService({
    claims: {
      get: (id) => Promise.resolve(claims.find((c) => c.claimId === id)),
      listByEmployee: () => page([...claims].reverse()),
      listOpenForManager: () => page([submitted(2), submitted(1)]),
      listByStatus: (status) =>
        page(
          status === undefined
            ? [...claims].reverse()
            : [submitted(2), submitted(1)],
        ),
      listHistory: () => page(entries),
    },
    categories: { list: () => Promise.resolve([travel]) },
    users: {
      get: () => Promise.resolve(undefined),
      getMany: () => Promise.resolve(profiles),
    },
  });
}

function get(
  path: string,
  subject: string | null = 'sub-aisha',
  query: Record<string, string> = {},
): ApiRequest {
  return {
    method: 'GET',
    path: `/api/v1${path}`,
    query,
    headers: {},
    ...(subject === null ? {} : { verifiedSubject: subject }),
    readBody: () => Promise.resolve(new Uint8Array()),
  };
}
const bodyOf = (response: ApiResponse) =>
  JSON.parse(response.body as string) as Record<string, any>;

describe('claim reads through the AWS path', () => {
  it('serves GET /claims/:claimId with the local response and one strongly consistent read', async () => {
    const { handler, recorded, local } = build();

    const response = await handler(get('/claims/claim-001'));

    expect(response.status).toBe(200);
    expect(bodyOf(response)).toEqual(
      JSON.parse(
        JSON.stringify(
          await localService().get(actors['sub-aisha']!, 'claim-001'),
        ),
      ),
    );
    expect(recorded).toEqual([{ kind: 'get' }]);
    expect(local.calls).toBe(0);
    expect(response.headers[apiHeaders.requestId]).toBeDefined();
  });

  it('shows the assigned manager and the administrator a submitted claim', async () => {
    for (const subject of ['sub-ben', 'sub-dan']) {
      const { handler } = build();
      expect((await handler(get('/claims/claim-001', subject))).status).toBe(
        200,
      );
    }
  });

  it('treats an invisible, missing, and malformed claim as not found, identically', async () => {
    const { handler } = build();
    const invisible = await handler(get('/claims/claim-001', 'sub-stranger'));
    const missing = await handler(get('/claims/claim-404'));
    const malformed = await handler(get('/claims/a%20b'));

    expect(invisible.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(bodyOf(invisible).error.message).toBe(bodyOf(missing).error.message);
    expect(bodyOf(invisible).error.code).toBe('NOT_FOUND');
  });

  it('pages GET /claims/:claimId/history with the local items and a working cursor', async () => {
    const { handler, recorded } = build();

    const first = await handler(
      get('/claims/claim-001/history', 'sub-aisha', { limit: '2' }),
    );
    const second = await handler(
      get('/claims/claim-001/history', 'sub-aisha', {
        limit: '2',
        cursor: bodyOf(first).nextCursor,
      }),
    );

    expect(first.status).toBe(200);
    expect(bodyOf(first).items).toHaveLength(2);
    expect(bodyOf(first).nextCursor).toBeDefined();
    expect(bodyOf(second).items).toHaveLength(1);
    expect(bodyOf(second)).not.toHaveProperty('nextCursor');
    const all = JSON.parse(
      JSON.stringify(
        await localService().history(actors['sub-aisha']!, 'claim-001', {
          limit: 10,
        }),
      ),
    );
    expect([...bodyOf(first).items, ...bodyOf(second).items]).toEqual(
      all.items,
    );
    expect(
      recorded.filter((r) => r.kind === 'query').map((r) => r.partition),
    ).toEqual(['CLAIM#claim-001', 'CLAIM#claim-001']);
  });

  it('hides the history of an invisible claim', async () => {
    const { handler, recorded } = build();
    const response = await handler(
      get('/claims/claim-001/history', 'sub-stranger'),
    );
    expect(response.status).toBe(404);
    expect(recorded.filter((r) => r.kind === 'query')).toEqual([]);
  });

  it('pages GET /me/claims over the employee index, without skips or repeats', async () => {
    const { handler, recorded } = build();
    const seen: string[] = [];
    let cursor: string | undefined;

    do {
      const response = await handler(
        get('/me/claims', 'sub-aisha', {
          limit: '1',
          ...(cursor === undefined ? {} : { cursor }),
        }),
      );
      expect(response.status).toBe(200);
      seen.push(...bodyOf(response).items.map((c: any) => c.claimId));
      cursor = bodyOf(response).nextCursor;
    } while (cursor !== undefined);

    expect(seen).toEqual(['claim-003', 'claim-002', 'claim-001']);
    expect(new Set(recorded.map((r) => r.partition))).toEqual(
      new Set(['EMPLOYEE#sub-aisha']),
    );
    expect(new Set(recorded.map((r) => r.index))).toEqual(new Set(['GSI1']));
  });

  it('returns the local response for the whole employee list', async () => {
    const { handler } = build();
    const response = await handler(get('/me/claims'));
    expect(bodyOf(response)).toEqual(
      JSON.parse(
        JSON.stringify(
          await localService().listMine(actors['sub-aisha']!, { limit: 20 }),
        ),
      ),
    );
  });

  it('serves the review queue to managers over the queue index, and refuses others', async () => {
    const { handler, recorded } = build();
    const response = await handler(get('/review-queue', 'sub-ben'));

    expect(response.status).toBe(200);
    expect(bodyOf(response).items.map((c: any) => c.claimId)).toEqual([
      'claim-002',
      'claim-001',
    ]);
    expect(recorded).toEqual([
      { kind: 'query', index: 'GSI2', partition: 'MANAGER#sub-ben#OPEN' },
    ]);
    expect((await handler(get('/review-queue', 'sub-aisha'))).status).toBe(403);
  });

  it('serves the administrator list with and without a status, and refuses others', async () => {
    const { handler, recorded } = build();

    const all = await handler(get('/claims', 'sub-dan'));
    const submittedOnly = await handler(
      get('/claims', 'sub-dan', { status: 'SUBMITTED' }),
    );

    expect(all.status).toBe(200);
    expect(bodyOf(all).items).toHaveLength(3);
    expect(bodyOf(submittedOnly).items).toHaveLength(2);
    expect(recorded.map((r) => `${r.index}:${r.partition}`)).toEqual([
      'GSI4:CLAIM',
      'GSI3:STATUS#SUBMITTED',
    ]);
    expect((await handler(get('/claims', 'sub-ben'))).status).toBe(403);
    expect((await handler(get('/claims', 'sub-aisha'))).status).toBe(403);
  });

  it('rejects invalid queries and foreign cursors before any read', async () => {
    const { handler, recorded } = build();

    const zero = await handler(get('/me/claims', 'sub-aisha', { limit: '0' }));
    const status = await handler(get('/claims', 'sub-dan', { status: 'LOST' }));
    const foreign = await handler(
      get('/review-queue', 'sub-ben', { cursor: 'not-a-cursor' }),
    );

    expect(zero.status).toBe(400);
    expect(status.status).toBe(400);
    expect(foreign.status).toBe(400);
    expect(recorded).toEqual([]);
  });

  it('requires authentication for every read', async () => {
    const { handler, recorded } = build();
    for (const path of [
      '/claims/claim-001',
      '/claims/claim-001/history',
      '/me/claims',
      '/review-queue',
      '/claims',
    ]) {
      expect((await handler(get(path, null))).status).toBe(401);
      expect((await handler(get(path, 'sub-ghost'))).status).toBe(401);
    }
    expect(recorded).toEqual([]);
  });
});

describe('failures and defaults', () => {
  it('turns a dependency failure into a generic 500 and never uses the local handler', async () => {
    const { handler, local } = build({
      failure: new Error('secret table failure'),
    });

    for (const [path, subject] of [
      ['/claims/claim-001', 'sub-aisha'],
      ['/claims/claim-001/history', 'sub-aisha'],
      ['/me/claims', 'sub-aisha'],
      ['/review-queue', 'sub-ben'],
      ['/claims', 'sub-dan'],
    ] as const) {
      const response = await handler(get(path, subject));
      expect(response.status).toBe(500);
      expect(bodyOf(response).error.code).toBe('INTERNAL_ERROR');
      expect(response.body as string).not.toContain('secret table failure');
    }
    expect(local.calls).toBe(0);
  });

  it('does not fall back to the route handler when a registered read fails', async () => {
    const { handler, local } = build({
      reads: { 'claim.get': () => Promise.reject(new Error('down')) },
    });
    expect((await handler(get('/claims/claim-001'))).status).toBe(500);
    expect(local.calls).toBe(0);
  });

  it('keeps unregistered operations on the local handler', async () => {
    const { handler, local } = build({ reads: {} });
    const response = await handler(get('/claims/claim-001'));
    expect(response.status).toBe(500);
    expect(local.calls).toBe(1);
  });

  it('is off by default: without reads the route handler runs', async () => {
    const { handler, local, recorded } = build({ withoutReads: true });
    await handler(get('/claims/claim-001'));
    expect(local.calls).toBe(1);
    expect(recorded).toEqual([]);
  });

  it('leaves other endpoints on the local handlers even when the reads are registered', async () => {
    const { handler, local } = build();
    const response = await handler(get('/categories'));
    expect(local.calls).toBe(1);
    expect(response.status).toBe(500);
  });
});
