import { createHash } from 'node:crypto';

import type {
  TransactWriteCommandInput,
  TransactWriteCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import { headers as apiHeaders } from '@claimflow/contracts';
import type { Actor, Category } from '@claimflow/domain';
import { describe, expect, it } from 'vitest';

import { AwsClaimCreationService } from '../src/adapters/aws/aws-claim-creation-service.js';
import { claimCreationMutation } from '../src/adapters/aws/claim-creation-mutation.js';
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
const now = new Date('2026-10-14T10:41:00.000Z');

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

const claimBody = {
  categoryId: 'travel',
  amount: { amountMinor: 45_000, currency: 'MYR' },
  expenseDate: '2026-10-08',
  merchant: 'Regional Airline',
  businessPurpose: 'Client workshop',
};

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
  getStored?: () => Promise<unknown>;
  withoutMutation?: boolean;
  mutation?: IdempotentMutation;
}

/** The real AWS creation path over fake AWS dependencies, behind ApiHandler. */
function build(options: Options = {}) {
  const sent: TransactWriteCommandInput[] = [];
  const store = new Map<string, IdempotencyRecord>();
  const reads = { category: 0 };
  const localIdempotency = { runs: 0 };
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
  const service = new AwsClaimCreationService({
    mutations: new ClaimMutationCoordinator({
      lookup: idempotency,
      committer: new DynamoDbIdempotentTransactionCommitter({
        executor,
        lookup: idempotency,
      }),
      rejections: idempotency,
    }),
    categories: {
      getStored: (() => {
        reads.category += 1;
        return (
          options.getStored?.() ??
          Promise.resolve({ category: travel, metadata: { claimCount: 1 } })
        );
      }) as never,
      list: () => Promise.resolve([travel]),
    },
    users: {
      get: () => Promise.resolve(undefined),
      getMany: () => Promise.resolve(profiles),
    },
    claims: writer,
    claimReader: { get: () => Promise.resolve(undefined) },
    ids: { newId: () => claimId },
    sleep: () => Promise.resolve(),
    random: () => 0.5,
    logger,
  });

  // The routes are the real AWS routes; the stub application proves that the
  // local idempotency and the local create handler are not used.
  const app = {
    idempotency: {
      run: () => {
        localIdempotency.runs += 1;
        return Promise.reject(new Error('local idempotency must not run'));
      },
    },
    logger,
    claims: {
      create: () => Promise.reject(new Error('local create must not run')),
    },
  } as unknown as Application;
  const handler = createApiHandler(app, {
    routes: createAwsRoutes(app),
    authenticate: (request) =>
      Promise.resolve(
        request.verifiedSubject === 'sub-aisha' ? aisha : undefined,
      ),
    ...(options.withoutMutation === true
      ? {}
      : {
          mutations: {
            'claim.create': options.mutation ?? claimCreationMutation(service),
          },
        }),
    now: () => now,
  });
  return { handler, sent, store, reads, localIdempotency, logger };
}

function post(
  body: unknown,
  init: { key?: string | null; subject?: string | null; raw?: string } = {},
): ApiRequest {
  const text = init.raw ?? JSON.stringify(body);
  const bytes = new TextEncoder().encode(text);
  const key = init.key === undefined ? 'create-key-0001' : init.key;
  const subject = init.subject === undefined ? 'sub-aisha' : init.subject;
  return {
    method: 'POST',
    path: '/api/v1/claims',
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
const fingerprintOf = (text: string) =>
  createHash('sha256')
    .update('POST /claims\n\n')
    .update(new TextEncoder().encode(text))
    .digest('hex');

describe('POST /claims through the AWS creation path', () => {
  it('creates the claim and returns the stored 201 response with the standard headers', async () => {
    const { handler, sent, store, localIdempotency } = build();

    const response = await handler(post(claimBody));

    expect(response.status).toBe(201);
    expect(bodyOf(response)).toMatchObject({
      claimId,
      status: 'DRAFT',
      version: 1,
      employee: { userId: 'sub-aisha' },
    });
    expect(response.headers[apiHeaders.requestId]).toBeDefined();
    expect(response.headers[apiHeaders.correlationId]).toBeDefined();
    expect(response.headers).not.toHaveProperty('Idempotent-Replayed');
    expect(sent).toHaveLength(1);
    expect(localIdempotency.runs).toBe(0);

    const stored = [...store.values()][0]!;
    expect(stored).toMatchObject({
      actorId: 'sub-aisha',
      key: 'create-key-0001',
      outcome: 'COMPLETED',
      fingerprint: fingerprintOf(JSON.stringify(claimBody)),
      createdAt: now.toISOString(),
    });
  });

  it('replays the stored response without executing the mutation twice, and claims no replay', async () => {
    const { handler, sent, reads, localIdempotency } = build();
    const first = await handler(post(claimBody));
    const readsAfterFirst = reads.category;

    const second = await handler(post(claimBody));

    expect(second.status).toBe(201);
    expect(bodyOf(second)).toEqual(bodyOf(first));
    expect(second.headers).not.toHaveProperty('Idempotent-Replayed');
    expect(sent).toHaveLength(1);
    expect(reads.category).toBe(readsAfterFirst);
    expect(localIdempotency.runs).toBe(0);
  });

  it('refuses the same key for a different request with IDEMPOTENCY_CONFLICT', async () => {
    const { handler, sent } = build();
    await handler(post(claimBody));

    const response = await handler(
      post({ ...claimBody, merchant: 'Another Airline' }),
    );

    expect(response.status).toBe(409);
    expect(bodyOf(response).error).toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(sent).toHaveLength(1);
  });

  it('persists a business rejection with the request ID, and replays it unchanged', async () => {
    const { handler, sent, store, reads } = build();

    const first = await handler(post({ bogus: true }));

    expect(first.status).toBe(400);
    expect(bodyOf(first).error).toMatchObject({
      code: 'VALIDATION_FAILED',
      requestId: first.headers[apiHeaders.requestId],
    });
    expect(store.size).toBe(1);
    expect([...store.values()][0]!.outcome).toBe('REJECTED');
    expect(sent).toEqual([]);

    const second = await handler(post({ bogus: true }));

    expect(second.status).toBe(400);
    // The stored rejection is replayed, including its original request ID.
    expect(bodyOf(second)).toEqual(bodyOf(first));
    expect(second.headers[apiHeaders.requestId]).not.toBe(
      first.headers[apiHeaders.requestId],
    );
    expect(reads.category).toBe(0);
  });

  it('rejects unauthenticated requests before any mutation work', async () => {
    const { handler, sent, store, reads } = build();

    const response = await handler(post(claimBody, { subject: null }));

    expect(response.status).toBe(401);
    expect(sent).toEqual([]);
    expect(store.size).toBe(0);
    expect(reads.category).toBe(0);
  });

  it('rejects an unknown subject as unauthenticated', async () => {
    const { handler, store } = build();
    expect(
      (await handler(post(claimBody, { subject: 'sub-ghost' }))).status,
    ).toBe(401);
    expect(store.size).toBe(0);
  });

  it('requires a valid idempotency key before the mutation runs', async () => {
    const calls: unknown[] = [];
    const { handler, localIdempotency } = build({
      mutation: (request) => {
        calls.push(request);
        return Promise.resolve({ status: 201, body: {} });
      },
    });

    for (const key of [null, '', 'a b']) {
      const response = await handler(post(claimBody, { key }));
      expect(response.status).toBe(400);
    }
    expect(calls).toEqual([]);
    expect(localIdempotency.runs).toBe(0);
  });

  it('keeps the body limit and JSON handling of the pipeline', async () => {
    const calls: unknown[] = [];
    const { handler } = build({
      mutation: (request) => {
        calls.push(request);
        return Promise.resolve({ status: 201, body: {} });
      },
    });

    const tooLarge = await handler(
      post(undefined, {
        raw: JSON.stringify({ merchant: 'x'.repeat(70_000) }),
      }),
    );
    const malformed = await handler(post(undefined, { raw: '{not json' }));

    expect(tooLarge.status).toBe(413);
    expect(malformed.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('gives the mutation the pipeline context: actor, parsed body, key, fingerprint, time, and IDs', async () => {
    const calls: any[] = [];
    const { handler } = build({
      mutation: (request) => {
        calls.push(request);
        return Promise.resolve({ status: 201, body: { ok: true } });
      },
    });

    const request = post(claimBody);
    const response = await handler({
      ...request,
      headers: { ...request.headers, 'x-correlation-id': 'corr-abc' },
    });

    expect(response.status).toBe(201);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      actor: { userId: 'sub-aisha' },
      body: claimBody,
      idempotencyKey: 'create-key-0001',
      fingerprint: fingerprintOf(JSON.stringify(claimBody)),
      now: now.toISOString(),
      correlationId: 'corr-abc',
      requestId: response.headers[apiHeaders.requestId],
    });
  });

  it('turns an infrastructure failure into a generic 500, storing nothing and not using the local path', async () => {
    const { handler, store, sent, localIdempotency, logger } = build({
      getStored: () => Promise.reject(new Error('secret table failure')),
    });

    const response = await handler(post(claimBody));

    expect(response.status).toBe(500);
    expect(bodyOf(response).error).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(response.body as string).not.toContain('secret table failure');
    expect(store.size).toBe(0);
    expect(sent).toEqual([]);
    expect(localIdempotency.runs).toBe(0);
    expect(
      logger.entries.filter((entry) => entry.level === 'error'),
    ).toHaveLength(1);
  });

  it('does not fall back to the local path when the mutation fails', async () => {
    const { handler, localIdempotency } = build({
      mutation: () => Promise.reject(new Error('down')),
    });
    expect((await handler(post(claimBody))).status).toBe(500);
    expect(localIdempotency.runs).toBe(0);
  });

  it('claims neither replayed:true nor replayed:false in the request log, on creation, replay, or failure', async () => {
    const requestLogs = (logger: RecordingLogger) =>
      logger.entries.filter((entry) => entry.event === 'http.request');
    const claimsNothing = (fields: LogFields | undefined) => {
      expect(fields).toBeDefined();
      expect(fields).not.toHaveProperty('replayed');
      expect(fields).toMatchObject({ operation: 'claim.create' });
    };

    const ok = build();
    await ok.handler(post(claimBody));
    await ok.handler(post(claimBody));
    const logs = requestLogs(ok.logger);
    expect(logs).toHaveLength(2);
    logs.forEach((entry) => claimsNothing(entry.fields));
    expect(logs.map((entry) => entry.fields?.status)).toEqual([201, 201]);

    const failing = build({
      mutation: () => Promise.reject(new Error('down')),
    });
    await failing.handler(post(claimBody));
    const failed = requestLogs(failing.logger);
    expect(failed).toHaveLength(1);
    claimsNothing(failed[0]!.fields);
    expect(failed[0]!.fields).toMatchObject({ status: 500 });
  });

  it('logs the request safely, without the body, key, or fingerprint', async () => {
    const { handler, logger } = build();
    await handler(post(claimBody));

    const text = JSON.stringify(logger.entries);
    expect(text).toContain('claim.create');
    for (const secret of [
      'Regional Airline',
      'create-key-0001',
      fingerprintOf(JSON.stringify(claimBody)),
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('refuses a result reference as a programming error', async () => {
    const stored: IdempotencyRecord = {
      actorId: 'sub-aisha',
      key: 'create-key-0001',
      fingerprint: fingerprintOf(JSON.stringify(claimBody)),
      outcome: 'COMPLETED',
      response: { status: 201, resultRef: { receiptId: 'r-7731' } },
      createdAt: now.toISOString(),
      expiresAt: Math.floor(now.getTime() / 1000) + 86_400,
    };
    const handler = createApiHandler(
      { idempotency: {} as never, logger: new RecordingLogger() },
      {
        routes: createAwsRoutes({} as Application),
        authenticate: () => Promise.resolve(aisha),
        mutations: {
          'claim.create': claimCreationMutation({
            create: () => Promise.resolve(stored),
          }),
        },
      },
    );

    const response = await handler(post(claimBody));

    expect(response.status).toBe(500);
    expect(bodyOf(response).error).toMatchObject({ code: 'INTERNAL_ERROR' });
  });
});

describe('default behavior', () => {
  it('uses the route handler and the local idempotency when no mutation is registered', async () => {
    const { handler, localIdempotency, sent, reads } = build({
      withoutMutation: true,
    });

    const response = await handler(post(claimBody));

    expect(localIdempotency.runs).toBe(1);
    expect(response.status).toBe(500);
    expect(sent).toEqual([]);
    expect(reads.category).toBe(0);
  });

  it('leaves other idempotent operations on the local path even when claim.create is opted in', async () => {
    const { handler, localIdempotency } = build();
    const response = await handler({
      ...post({ expectedVersion: 1 }),
      method: 'PATCH',
      path: `/api/v1/claims/${claimId}`,
    });

    expect(localIdempotency.runs).toBe(1);
    expect(response.status).toBe(500);
  });
});
