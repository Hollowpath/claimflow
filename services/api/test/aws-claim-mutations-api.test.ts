import type {
  TransactWriteCommandInput,
  TransactWriteCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import { claimActionPaths, headers as apiHeaders } from '@claimflow/contracts';
import type { Actor, Category, Claim, ClaimAction } from '@claimflow/domain';
import { describe, expect, it } from 'vitest';

import { AwsClaimDraftEditingService } from '../src/adapters/aws/aws-claim-draft-editing-service.js';
import { AwsClaimLifecycleService } from '../src/adapters/aws/aws-claim-lifecycle-service.js';
import {
  claimEditMutation,
  claimLifecycleMutations,
  storedResponse,
} from '../src/adapters/aws/claim-mutations.js';
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
import { claimActionEventTypes } from '../src/application/claim-events.js';
import type {
  LogFields,
  Logger,
  UserProfile,
} from '../src/application/ports.js';
import type { Application } from '../src/composition.js';
import {
  createApiHandler,
  type ApiRequest,
  type ApiResponse,
  type IdempotentMutation,
} from '../src/http/api-handler.js';
import { createAwsRoutes } from '../src/http/routes.js';

const tableName = 'ClaimFlow';
const claimId = '4ce0c74b-9c64-46d6-87ba-07fb71b0628c';
const eventId = '8f3d2c1e-5a7b-4c1d-9e2f-0a1b2c3d4e5f';
const now = new Date('2026-10-14T10:41:00.000Z');

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
  version: 4,
  createdAt: '2026-10-14T10:00:00.000Z',
  updatedAt: '2026-10-14T10:30:00.000Z',
};
const open = (status: Claim['status'], patch: Partial<Claim> = {}): Claim => ({
  ...draft,
  assignedManagerId: 'sub-ben',
  submittedAt: '2026-10-14T10:25:00.000Z',
  status,
  ...patch,
});

/** Each action: the claim it starts from, who performs it, and its body. */
const scenarios: Record<
  ClaimAction,
  { subject: string; claim: Claim; body: object }
> = {
  SUBMIT: { subject: 'sub-aisha', claim: draft, body: {} },
  START_REVIEW: { subject: 'sub-ben', claim: open('SUBMITTED'), body: {} },
  APPROVE: {
    subject: 'sub-ben',
    claim: open('UNDER_REVIEW'),
    body: { comment: 'Looks right.' },
  },
  REJECT: {
    subject: 'sub-ben',
    claim: open('UNDER_REVIEW'),
    body: { comment: 'Please add the boarding pass.' },
  },
  REOPEN: {
    subject: 'sub-aisha',
    claim: open('REJECTED', { reviewedAt: '2026-10-14T10:35:00.000Z' }),
    body: {},
  },
  MARK_PAID: {
    subject: 'sub-dan',
    claim: open('APPROVED', { reviewedAt: '2026-10-14T10:35:00.000Z' }),
    body: {},
  },
};
const actions = Object.keys(scenarios) as ClaimAction[];

class RecordingLogger implements Logger {
  public readonly entries: {
    level: string;
    event: string;
    fields: LogFields | undefined;
  }[] = [];
  public info(event: string, fields?: LogFields): void {
    this.entries.push({ level: 'info', event, fields });
  }
  public warn(event: string, fields?: LogFields): void {
    this.entries.push({ level: 'warn', event, fields });
  }
  public error(event: string, fields?: LogFields): void {
    this.entries.push({ level: 'error', event, fields });
  }
}

interface Options {
  claim?: Claim | undefined;
  getStoredClaim?: () => Promise<unknown>;
  mutations?: Record<string, IdempotentMutation>;
}

/** The real edit and lifecycle services behind ApiHandler, over fake AWS. */
function build(options: Options = {}) {
  const claim = 'claim' in options ? options.claim : draft;
  const sent: TransactWriteCommandInput[] = [];
  const store = new Map<string, IdempotencyRecord>();
  const reads = { claim: 0 };
  const local = { runs: 0 };
  const logger = new RecordingLogger();

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
        const key = idempotencyKey(record.actorId, record.key).PK;
        if (store.has(key)) {
          return Promise.reject(
            Object.assign(new Error('exists'), {
              name: 'ConditionalCheckFailedException',
            }),
          );
        }
        store.set(key, record);
        return Promise.resolve();
      },
    },
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
  const shared = {
    mutations,
    claimReader: {
      getStored: (() => {
        reads.claim += 1;
        return (
          options.getStoredClaim?.() ??
          Promise.resolve(
            claim === undefined ? undefined : { claim, metadata: {} },
          )
        );
      }) as never,
    },
    categories: {
      getStored: (() =>
        Promise.resolve({
          category: travel,
          metadata: { claimCount: 1 },
        })) as never,
      list: () => Promise.resolve([travel]),
    },
    users: {
      get: () => Promise.resolve(undefined),
      getMany: () => Promise.resolve(profiles),
    },
    sleep: () => Promise.resolve(),
    random: () => 0.5,
    logger,
  };
  const editing = new AwsClaimDraftEditingService({
    ...shared,
    claims: writer,
  });
  const lifecycle = new AwsClaimLifecycleService({
    ...shared,
    claims: writer,
    ids: { newId: () => eventId },
  });

  const app = {
    idempotency: {
      run: () => {
        local.runs += 1;
        return Promise.reject(new Error('local idempotency must not run'));
      },
    },
    logger,
    claims: {
      update: () => Promise.reject(new Error('local update must not run')),
      perform: () => Promise.reject(new Error('local perform must not run')),
    },
  } as unknown as Application;
  const handler = createApiHandler(app, {
    routes: createAwsRoutes(app),
    authenticate: (request) =>
      Promise.resolve(actors[request.verifiedSubject ?? '']),
    mutations: options.mutations ?? {
      'claim.update': claimEditMutation(editing),
      ...claimLifecycleMutations(lifecycle),
    },
    now: () => now,
  });
  return { handler, sent, store, reads, local, logger };
}

function request(
  method: string,
  path: string,
  body: unknown,
  init: { key?: string | null; subject?: string | null } = {},
): ApiRequest {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const key = init.key === undefined ? 'mutation-key-0001' : init.key;
  const subject = init.subject === undefined ? 'sub-aisha' : init.subject;
  return {
    method,
    path,
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

const patch = (
  body: unknown,
  init?: { key?: string | null; subject?: string | null },
  id = claimId,
) => request('PATCH', `/api/v1/claims/${id}`, body, init);
const act = (
  action: ClaimAction,
  body: unknown,
  init?: { key?: string | null; subject?: string | null },
  id = claimId,
) =>
  request(
    'POST',
    `/api/v1/claims/${id}/${claimActionPaths[action]}`,
    body,
    init,
  );

const bodyOf = (response: ApiResponse) =>
  JSON.parse(response.body as string) as Record<string, any>;
const eventOf = (input: TransactWriteCommandInput) =>
  input.TransactItems!.find((item) =>
    String(item.Put?.Item?.SK ?? '').startsWith('OUTBOX#'),
  )?.Put?.Item;
const edit = { expectedVersion: 4, merchant: 'Metro Airlines' };
const input = (action: ClaimAction, version = 4) => ({
  expectedVersion: version,
  ...scenarios[action].body,
});

describe('PATCH /claims/:claimId through the AWS editing path', () => {
  it('edits the draft named by the route and returns the stored 200 response', async () => {
    const { handler, sent, store, local } = build();

    const response = await handler(patch(edit));

    expect(response.status).toBe(200);
    expect(bodyOf(response)).toMatchObject({
      claimId,
      version: 5,
      merchant: 'Metro Airlines',
    });
    expect(response.headers[apiHeaders.requestId]).toBeDefined();
    expect(response.headers).not.toHaveProperty('Idempotent-Replayed');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.TransactItems!.map((item) => Object.keys(item)[0])).toEqual(
      ['Update', 'Put', 'Put'],
    );
    expect(eventOf(sent[0]!)).toBeUndefined();
    expect(local.runs).toBe(0);
    expect([...store.values()][0]).toMatchObject({
      outcome: 'COMPLETED',
      actorId: 'sub-aisha',
      key: 'mutation-key-0001',
    });
  });

  it('replays the stored response without a second commit or a claim read', async () => {
    const { handler, sent, reads } = build();
    const first = await handler(patch(edit));
    const readsAfterFirst = reads.claim;

    const second = await handler(patch(edit));

    expect(second.status).toBe(200);
    expect(bodyOf(second)).toEqual(bodyOf(first));
    expect(sent).toHaveLength(1);
    expect(reads.claim).toBe(readsAfterFirst);
  });

  it('takes the claim only from the route: a body claim ID is refused and a route miss is not found', async () => {
    const smuggled = build();
    const refused = await smuggled.handler(
      patch({ ...edit, claimId: 'other-claim' }),
    );
    expect(refused.status).toBe(400);
    expect(smuggled.sent).toEqual([]);

    const missing = build({ claim: undefined });
    const absent = await missing.handler(patch(edit, undefined, 'other-claim'));
    expect(absent.status).toBe(404);
    expect(missing.sent).toEqual([]);
  });

  it('keeps the existing responses for missing, invisible, stale, and unauthorized edits', async () => {
    const missing = await build({ claim: undefined }).handler(patch(edit));
    const invisible = await build().handler(
      patch(edit, { subject: 'sub-stranger' }),
    );
    const stale = await build().handler(patch({ ...edit, expectedVersion: 1 }));
    const anonymous = await build().handler(patch(edit, { subject: null }));
    const ghost = await build().handler(patch(edit, { subject: 'sub-ghost' }));

    expect(missing.status).toBe(404);
    expect(bodyOf(invisible).error).toMatchObject({ code: 'NOT_FOUND' });
    expect(bodyOf(invisible).error.message).toBe(bodyOf(missing).error.message);
    expect(stale.status).toBe(409);
    expect(bodyOf(stale).error).toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(anonymous.status).toBe(401);
    expect(ghost.status).toBe(401);
  });

  it('refuses an edit by an administrator who may view but not own the claim', async () => {
    const { handler, sent } = build();
    const response = await handler(patch(edit, { subject: 'sub-dan' }));
    expect(response.status).toBe(403);
    expect(sent).toEqual([]);
  });

  it('turns an infrastructure failure into a generic 500 without using the local path', async () => {
    const { handler, store, local, logger } = build({
      getStoredClaim: () => Promise.reject(new Error('secret failure')),
    });

    const response = await handler(patch(edit));

    expect(response.status).toBe(500);
    expect(response.body as string).not.toContain('secret failure');
    expect(store.size).toBe(0);
    expect(local.runs).toBe(0);
    expect(logger.entries.filter((e) => e.level === 'error')).toHaveLength(1);
  });
});

describe.each(actions)(
  'POST /claims/:claimId/%s through the AWS lifecycle path',
  (action) => {
    const { subject, claim } = scenarios[action];

    it('dispatches the registered action and returns the stored 200 response with its event', async () => {
      const { handler, sent, local } = build({ claim });

      const response = await handler(act(action, input(action), { subject }));

      expect(response.status).toBe(200);
      expect(bodyOf(response)).toMatchObject({ claimId, version: 5 });
      expect(sent).toHaveLength(1);
      expect(eventOf(sent[0]!)).toMatchObject({
        eventId,
        eventType: claimActionEventTypes[action],
        actorId: subject,
        correlationId: response.headers[apiHeaders.correlationId],
        causationId: response.headers[apiHeaders.requestId],
        aggregate: { id: claimId, version: 5 },
      });
      const guarded = sent[0]!.TransactItems!.some(
        (item) => item.ConditionCheck !== undefined,
      );
      expect(guarded).toBe(action === 'SUBMIT');
      expect(local.runs).toBe(0);
    });

    it('replays without a duplicate commit and without claiming a replay', async () => {
      const { handler, sent, reads, logger } = build({ claim });
      const first = await handler(act(action, input(action), { subject }));
      const readsAfterFirst = reads.claim;

      const second = await handler(act(action, input(action), { subject }));

      expect(bodyOf(second)).toEqual(bodyOf(first));
      expect(second.headers).not.toHaveProperty('Idempotent-Replayed');
      expect(sent).toHaveLength(1);
      expect(reads.claim).toBe(readsAfterFirst);
      for (const entry of logger.entries.filter(
        (e) => e.event === 'http.request',
      )) {
        expect(entry.fields).not.toHaveProperty('replayed');
      }
    });

    it('cannot be redirected by the body: claim ID, action, status, and identity are refused', async () => {
      const other = actions.find((candidate) => candidate !== action)!;
      for (const smuggled of [
        { claimId: 'other-claim' },
        { action: other },
        { status: 'PAID' },
        { actorId: 'sub-dan' },
      ]) {
        const harness = build({ claim });
        const response = await harness.handler(
          act(action, { ...input(action), ...smuggled }, { subject }),
        );
        expect(response.status).toBe(400);
        expect(harness.sent).toEqual([]);
      }
    });

    it('keeps the existing responses for missing, invisible, stale, and unauthenticated requests', async () => {
      const missing = await build({ claim: undefined }).handler(
        act(action, input(action), { subject }),
      );
      const invisible = await build({ claim }).handler(
        act(action, input(action), { subject: 'sub-stranger' }),
      );
      const stale = await build({ claim }).handler(
        act(action, input(action, 1), { subject }),
      );
      const anonymous = await build({ claim }).handler(
        act(action, input(action), { subject: null }),
      );

      expect(missing.status).toBe(404);
      expect(bodyOf(invisible)).toMatchObject({ error: { code: 'NOT_FOUND' } });
      expect(bodyOf(invisible).error.message).toBe(
        bodyOf(missing).error.message,
      );
      expect(bodyOf(stale).error).toMatchObject({ code: 'VERSION_CONFLICT' });
      expect(anonymous.status).toBe(401);
    });

    it('turns an infrastructure failure into a generic 500 without using the local path', async () => {
      const { handler, store, local } = build({
        claim,
        getStoredClaim: () => Promise.reject(new Error('secret failure')),
      });

      const response = await handler(act(action, input(action), { subject }));

      expect(response.status).toBe(500);
      expect(response.body as string).not.toContain('secret failure');
      expect(store.size).toBe(0);
      expect(local.runs).toBe(0);
    });
  },
);

describe('authorization of the lifecycle actions', () => {
  it('refuses payment by a manager and approval by an unassigned manager', async () => {
    const byManager = build({ claim: scenarios.MARK_PAID.claim });
    expect(
      (
        await byManager.handler(
          act('MARK_PAID', input('MARK_PAID'), { subject: 'sub-ben' }),
        )
      ).status,
    ).toBeGreaterThanOrEqual(400);
    expect(byManager.sent).toEqual([]);

    const unassigned = build({
      claim: open('UNDER_REVIEW', { assignedManagerId: 'sub-other' }),
    });
    const response = await unassigned.handler(
      act('APPROVE', input('APPROVE'), { subject: 'sub-ben' }),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(unassigned.sent).toEqual([]);
  });

  it('requires a decision comment to approve', async () => {
    const harness = build({ claim: scenarios.APPROVE.claim });
    const response = await harness.handler(
      act('APPROVE', { expectedVersion: 4 }, { subject: 'sub-ben' }),
    );
    expect(response.status).toBe(400);
    expect(harness.sent).toEqual([]);
  });
});

describe('the seam', () => {
  it('passes the decoded route parameters, not the body, to the mutation', async () => {
    const calls: any[] = [];
    const { handler } = build({
      mutations: {
        'claim.update': (mutationRequest) => {
          calls.push(mutationRequest);
          return Promise.resolve({ status: 200, body: {} });
        },
      },
    });

    await handler(
      patch({ ...edit, claimId: 'from-body' }, undefined, 'route-claim'),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual({ claimId: 'route-claim' });
    expect(calls[0].body).toMatchObject({ claimId: 'from-body' });
  });

  it('registers the six lifecycle operations by route name', () => {
    expect(
      Object.keys(
        claimLifecycleMutations({
          perform: () => Promise.reject(new Error('x')),
        }),
      ).sort(),
    ).toEqual(
      [
        'claim.submit',
        'claim.start-review',
        'claim.approve',
        'claim.reject',
        'claim.reopen',
        'claim.mark-paid',
      ].sort(),
    );
  });

  it('refuses a result reference as a programming error', () => {
    const record: IdempotencyRecord = {
      actorId: 'sub-aisha',
      key: 'mutation-key-0001',
      fingerprint: 'ab'.repeat(32),
      outcome: 'COMPLETED',
      response: { status: 201, resultRef: { receiptId: 'r-7731' } },
      createdAt: now.toISOString(),
      expiresAt: Math.floor(now.getTime() / 1000) + 86_400,
    };
    expect(() => storedResponse(record)).toThrow(TypeError);
  });

  it('leaves operations without a registration on the local path', async () => {
    const { handler, local } = build({ mutations: {} });
    const response = await handler(patch(edit));
    expect(local.runs).toBe(1);
    expect(response.status).toBe(500);
  });

  it('does not fall back to the local path when a registered mutation fails', async () => {
    const { handler, local } = build({
      mutations: { 'claim.update': () => Promise.reject(new Error('down')) },
    });
    expect((await handler(patch(edit))).status).toBe(500);
    expect(local.runs).toBe(0);
  });

  it('logs no replay claim for the registered mutations, including failures', async () => {
    const { handler, logger } = build({
      mutations: { 'claim.update': () => Promise.reject(new Error('down')) },
    });
    await handler(patch(edit));
    const entry = logger.entries.find((e) => e.event === 'http.request');
    expect(entry?.fields).toMatchObject({
      operation: 'claim.update',
      status: 500,
    });
    expect(entry?.fields).not.toHaveProperty('replayed');
  });
});
