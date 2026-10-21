import type {
  TransactWriteCommandInput,
  TransactWriteCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import { headers as apiHeaders } from '@claimflow/contracts';
import type { Actor, Category, Claim } from '@claimflow/domain';
import { describe, expect, it } from 'vitest';

import {
  AwsDraftDeletionService,
  AwsReceiptRemovalService,
} from '../src/adapters/aws/aws-claim-removal-services.js';
import { AwsReceiptAttachmentService } from '../src/adapters/aws/aws-receipt-attachment-service.js';
import { AwsReceiptDownloadService } from '../src/adapters/aws/aws-receipt-download-service.js';
import {
  claimDeleteMutation,
  receiptAttachMutation,
  receiptRemoveMutation,
} from '../src/adapters/aws/claim-mutations.js';
import { receiptDownloadRead } from '../src/adapters/aws/claim-reads.js';
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
import {
  pendingReceiptExpiresAt,
  type AttachedReceiptRecord,
  type PendingReceiptRecord,
  type ReceiptRecord,
} from '../src/adapters/aws/dynamodb-receipt-items.js';
import { S3DownloadUrlGenerator } from '../src/adapters/aws/s3-download-url.js';
import type { UserProfile } from '../src/application/ports.js';
import type { Application } from '../src/composition.js';
import {
  createApiHandler,
  type ApiRequest,
  type ApiResponse,
  type IdempotentMutation,
  type ReadOperation,
} from '../src/http/api-handler.js';
import { createAwsRoutes } from '../src/http/routes.js';

const tableName = 'ClaimFlow';
const claimId = '4ce0c74b-9c64-46d6-87ba-07fb71b0628c';
const now = new Date('2026-10-14T10:41:00.000Z');
const checksum = 'a1b2'.repeat(16);

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
    displayName: 'Sam',
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
];
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

const receipt = {
  receiptId: 'r-old',
  fileName: 'old.pdf',
  contentType: 'application/pdf' as const,
  sizeBytes: 9_000,
  checksumSha256: 'c3d4'.repeat(16),
  attachedAt: '2026-10-14T09:30:00.000Z',
};
const draft = (withReceipt: boolean, patch: Partial<Claim> = {}): Claim => ({
  claimId,
  employeeId: 'sub-aisha',
  categoryId: 'travel',
  amount: { amountMinor: 45_000, currency: 'MYR' },
  merchant: 'Regional Airline',
  status: 'DRAFT',
  version: 4,
  createdAt: '2026-10-14T10:00:00.000Z',
  updatedAt: '2026-10-14T10:20:00.000Z',
  ...(withReceipt ? { receipt } : {}),
  ...patch,
});
const attachedRecord = (id = 'r-old'): AttachedReceiptRecord => ({
  receiptId: id,
  ownerId: 'sub-aisha',
  state: 'ATTACHED',
  fileName: 'old.pdf',
  contentType: 'application/pdf',
  sizeBytes: 9_000,
  checksumSha256: 'c3d4'.repeat(16),
  uploadedAt: '2026-10-14T09:00:00.000Z',
  attachedClaimId: claimId,
});
const pendingRecord = (): PendingReceiptRecord => ({
  receiptId: 'r-new',
  ownerId: 'sub-aisha',
  state: 'PENDING',
  fileName: 'flight.pdf',
  declaredContentType: 'application/pdf',
  declaredSizeBytes: 52_144,
  declaredChecksumSha256: checksum,
  uploadedAt: '2026-10-14T10:30:00.000Z',
  expiresAt: pendingReceiptExpiresAt('2026-10-14T10:30:00.000Z'),
});

interface Options {
  claim?: Claim | undefined;
  receipts?: Record<string, ReceiptRecord | undefined>;
  getStoredClaim?: () => Promise<unknown>;
  claimGet?: () => Promise<Claim | undefined>;
  sign?: () => Promise<string>;
  mutations?: Record<string, IdempotentMutation>;
  reads?: Record<string, ReadOperation>;
  withoutAws?: boolean;
}

/** The real receipt services behind ApiHandler, over fake AWS dependencies. */
function build(options: Options = {}) {
  const claim = 'claim' in options ? options.claim : draft(false);
  const receipts: Record<string, ReceiptRecord | undefined> = {
    'r-new': pendingRecord(),
    'r-old': attachedRecord(),
    ...options.receipts,
  };
  const sent: TransactWriteCommandInput[] = [];
  const store = new Map<string, IdempotencyRecord>();
  const objectCalls: string[] = [];
  const signed: { key: string; disposition: string }[] = [];
  const local = { calls: 0 };
  const reads = { claim: 0 };

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
  let ids = 0;
  const shared = {
    mutations: new ClaimMutationCoordinator({
      lookup: idempotency,
      committer: new DynamoDbIdempotentTransactionCommitter({
        executor,
        lookup: idempotency,
      }),
      rejections: idempotency,
    }),
    claimReader: {
      getStored: ((id: string) => {
        reads.claim += 1;
        return (
          options.getStoredClaim?.() ??
          Promise.resolve(
            claim === undefined || claim.claimId !== id
              ? undefined
              : { claim, metadata: {} },
          )
        );
      }) as never,
      get: (id: string) => {
        reads.claim += 1;
        return (
          options.claimGet?.() ??
          Promise.resolve(claim?.claimId === id ? claim : undefined)
        );
      },
    },
    receipts: { get: (id: string) => Promise.resolve(receipts[id]) },
    categories: {
      getStored: (() =>
        Promise.resolve({
          category: travel,
          metadata: { claimCount: 2 },
        })) as never,
      list: () => Promise.resolve([travel]),
    },
    users: {
      get: () => Promise.resolve(undefined),
      getMany: () => Promise.resolve(profiles),
    },
    ids: { newId: () => `event-${++ids}` },
    sleep: () => Promise.resolve(),
    random: () => 0.5,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  };
  const attach = new AwsReceiptAttachmentService({
    ...shared,
    inspector: {
      inspect: (record) =>
        Promise.resolve({
          receiptId: record.receiptId,
          ownerId: record.ownerId,
          fileName: record.fileName,
          contentType: record.declaredContentType,
          sizeBytes: record.declaredSizeBytes,
          checksumSha256: record.declaredChecksumSha256,
          uploadedAt: record.uploadedAt,
        }),
    },
    objects: {
      promote: () => {
        objectCalls.push('promote');
        return Promise.resolve();
      },
      deletePending: () => {
        objectCalls.push('deletePending');
        return Promise.resolve();
      },
    },
    claims: writer,
  });
  const removal = new AwsReceiptRemovalService({ ...shared, claims: writer });
  const deletion = new AwsDraftDeletionService({ ...shared, claims: writer });
  const download = new AwsReceiptDownloadService({
    claimReader: shared.claimReader,
    receipts: shared.receipts,
    urls: new S3DownloadUrlGenerator({
      bucketName: 'claimflow-receipts-test',
      clock: { now: () => now },
      sign: (request) => {
        signed.push({
          key: request.key,
          disposition: request.responseContentDisposition,
        });
        return (
          options.sign?.() ??
          Promise.resolve(
            `https://claimflow-receipts-test.s3.amazonaws.com/${request.key}?sig=1`,
          )
        );
      },
    }),
  });

  const trap = () => {
    local.calls += 1;
    return Promise.reject(new Error('local handler must not run'));
  };
  const app = {
    idempotency: { run: trap },
    logger: shared.logger,
    claims: { delete: trap, get: trap },
    receipts: { attach: trap, remove: trap, read: trap },
  } as unknown as Application;
  const handler = createApiHandler(app, {
    routes: createAwsRoutes(app),
    authenticate: (request) =>
      Promise.resolve(actors[request.verifiedSubject ?? '']),
    ...(options.withoutAws === true
      ? {}
      : {
          mutations: options.mutations ?? {
            'receipt.attach': receiptAttachMutation(attach),
            'receipt.remove': receiptRemoveMutation(removal),
            'claim.delete': claimDeleteMutation(deletion),
          },
          reads: options.reads ?? {
            'receipt.read': receiptDownloadRead(download),
          },
        }),
    now: () => now,
  });
  return { handler, sent, store, objectCalls, signed, local, reads };
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
  const subject = init.subject === undefined ? 'sub-aisha' : init.subject;
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
const attachRequest = (
  patch: object = {},
  init?: { subject?: string | null; key?: string | null },
  id = claimId,
) =>
  call(
    'PUT',
    `/claims/${id}/receipt`,
    {
      expectedVersion: 4,
      receiptId: 'r-new',
      contentType: 'application/pdf',
      sizeBytes: 52_144,
      checksumSha256: checksum,
      ...patch,
    },
    init,
  );
const removeRequest = (
  version = 4,
  init?: { subject?: string | null },
  id = claimId,
) =>
  call('DELETE', `/claims/${id}/receipt`, { expectedVersion: version }, init);
const deleteRequest = (
  version = 4,
  init?: { subject?: string | null },
  id = claimId,
) => call('DELETE', `/claims/${id}`, { expectedVersion: version }, init);
const download = (subject: string | null = 'sub-aisha', id = claimId) =>
  call('GET', `/claims/${id}/receipt`, undefined, { key: null, subject });

const bodyOf = (response: ApiResponse) =>
  JSON.parse(response.body as string) as Record<string, any>;
const outbox = (input: TransactWriteCommandInput) =>
  input
    .TransactItems!.filter((i) =>
      String(i.Put?.Item?.SK ?? '').startsWith('OUTBOX#'),
    )
    .map((i) => i.Put!.Item!);

describe('PUT /claims/:claimId/receipt through the AWS attachment path', () => {
  it('attaches the receipt, returning the stored 200 claim, and then deletes only the pending object', async () => {
    const { handler, sent, objectCalls, local } = build();

    const response = await handler(attachRequest());

    expect(response.status).toBe(200);
    expect(bodyOf(response)).toMatchObject({
      claimId,
      version: 5,
      receipt: { receiptId: 'r-new' },
    });
    expect(response.headers[apiHeaders.requestId]).toBeDefined();
    expect(response.headers).not.toHaveProperty('Idempotent-Replayed');
    expect(sent).toHaveLength(1);
    expect(objectCalls).toEqual(['promote', 'deletePending']);
    expect(local.calls).toBe(0);
  });

  it('replaces an existing receipt with a cleanup event for the old object', async () => {
    const { handler, sent } = build({ claim: draft(true) });

    const response = await handler(attachRequest());

    expect(response.status).toBe(200);
    expect(outbox(sent[0]!)).toEqual([
      expect.objectContaining({
        eventType: 'internal.receipt-object-deletion-requested',
        payload: { claimId, receiptId: 'r-old', objectKey: 'receipts/r-old' },
        correlationId: response.headers[apiHeaders.correlationId],
        causationId: response.headers[apiHeaders.requestId],
      }),
    ]);
  });

  it('replays without a second commit, inspection, promotion, or deletion', async () => {
    const { handler, sent, objectCalls } = build();
    const first = await handler(attachRequest());

    const second = await handler(attachRequest());

    expect(bodyOf(second)).toEqual(bodyOf(first));
    expect(sent).toHaveLength(1);
    expect(objectCalls).toEqual(['promote', 'deletePending']);
  });

  it('takes the claim only from the route, refusing a body claim ID', async () => {
    const { handler, sent } = build();
    expect(
      (await handler(attachRequest({ claimId: 'other-claim' }))).status,
    ).toBe(400);
    expect(
      (
        await handler(
          attachRequest({}, { key: 'another-key-0002' }, 'other-claim'),
        )
      ).status,
    ).toBe(404);
    expect(sent).toEqual([]);
  });

  it('keeps the existing responses for stale, invisible, unavailable, and unauthorized requests', async () => {
    const stale = await build().handler(attachRequest({ expectedVersion: 1 }));
    const missing = await build({ claim: undefined }).handler(attachRequest());
    const invisible = await build().handler(
      attachRequest({}, { subject: 'sub-stranger' }),
    );
    const unavailable = await build({
      receipts: { 'r-new': undefined },
    }).handler(attachRequest());
    const byAdmin = await build().handler(
      attachRequest({}, { subject: 'sub-dan' }),
    );
    const anonymous = await build().handler(
      attachRequest({}, { subject: null }),
    );

    expect(bodyOf(stale).error.code).toBe('VERSION_CONFLICT');
    expect(missing.status).toBe(404);
    expect(bodyOf(invisible).error.message).toBe(bodyOf(missing).error.message);
    expect(bodyOf(unavailable).error.details[0].code).toBe(
      'RECEIPT_UNAVAILABLE',
    );
    expect(byAdmin.status).toBe(403);
    expect(anonymous.status).toBe(401);
  });

  it('turns an infrastructure failure into a generic 500, deleting nothing and not using the local path', async () => {
    const { handler, store, local, objectCalls } = build({
      getStoredClaim: () => Promise.reject(new Error('secret failure')),
    });
    const response = await handler(attachRequest());
    expect(response.status).toBe(500);
    expect(response.body as string).not.toContain('secret failure');
    expect(store.size).toBe(0);
    expect(objectCalls).toEqual([]);
    expect(local.calls).toBe(0);
  });
});

describe('DELETE /claims/:claimId/receipt through the AWS removal path', () => {
  it('removes the receipt, returning the stored 200 claim, with a cleanup event and no object call', async () => {
    const { handler, sent, objectCalls, local } = build({ claim: draft(true) });

    const response = await handler(removeRequest());

    expect(response.status).toBe(200);
    expect(bodyOf(response)).toMatchObject({ claimId, version: 5 });
    expect(bodyOf(response)).not.toHaveProperty('receipt');
    expect(outbox(sent[0]!).map((e) => e.eventType)).toEqual([
      'internal.receipt-object-deletion-requested',
    ]);
    expect(objectCalls).toEqual([]);
    expect(local.calls).toBe(0);
  });

  it('replays, and keeps the existing responses for stale, invisible, and receipt-less claims', async () => {
    const h = build({ claim: draft(true) });
    const first = await h.handler(removeRequest());
    expect(bodyOf(await h.handler(removeRequest()))).toEqual(bodyOf(first));
    expect(h.sent).toHaveLength(1);

    expect(
      bodyOf(await build({ claim: draft(true) }).handler(removeRequest(1)))
        .error.code,
    ).toBe('VERSION_CONFLICT');
    expect(
      (
        await build({ claim: draft(true) }).handler(
          removeRequest(4, { subject: 'sub-stranger' }),
        )
      ).status,
    ).toBe(404);
    expect((await build().handler(removeRequest())).status).toBe(400);
  });

  it('fails generically on infrastructure errors', async () => {
    const { handler, local } = build({
      claim: draft(true),
      getStoredClaim: () => Promise.reject(new Error('down')),
    });
    expect((await handler(removeRequest())).status).toBe(500);
    expect(local.calls).toBe(0);
  });
});

describe('DELETE /claims/:claimId through the AWS deletion path', () => {
  it('deletes the draft with 204 and no body, writing events but touching no object or history', async () => {
    const { handler, sent, objectCalls, local } = build({ claim: draft(true) });

    const response = await handler(deleteRequest());

    expect(response.status).toBe(204);
    expect(response.body).toBeUndefined();
    expect(outbox(sent[0]!).map((e) => e.eventType)).toEqual([
      'internal.claim-history-purge-requested',
      'internal.receipt-object-deletion-requested',
    ]);
    expect(JSON.stringify(sent[0])).not.toContain('HISTORY#');
    expect(sent[0]!.TransactItems!.length).toBeLessThanOrEqual(6);
    expect(objectCalls).toEqual([]);
    expect(local.calls).toBe(0);
  });

  it('handles a draft without a receipt and replays the 204', async () => {
    const h = build({ claim: draft(false) });
    expect((await h.handler(deleteRequest())).status).toBe(204);
    expect(outbox(h.sent[0]!).map((e) => e.eventType)).toEqual([
      'internal.claim-history-purge-requested',
    ]);
    expect((await h.handler(deleteRequest())).status).toBe(204);
    expect(h.sent).toHaveLength(1);
  });

  it('keeps the existing responses for stale, invisible, unauthorized, and submitted claims', async () => {
    expect(bodyOf(await build().handler(deleteRequest(1))).error.code).toBe(
      'VERSION_CONFLICT',
    );
    expect(
      (await build().handler(deleteRequest(4, { subject: 'sub-stranger' })))
        .status,
    ).toBe(404);
    expect(
      (await build().handler(deleteRequest(4, { subject: 'sub-dan' }))).status,
    ).toBe(403);
    expect(
      (await build().handler(deleteRequest(4, { subject: null }))).status,
    ).toBe(401);
    const submitted = build({
      claim: draft(false, {
        status: 'SUBMITTED',
        assignedManagerId: 'sub-ben',
        submittedAt: '2026-10-14T10:25:00.000Z',
      }),
    });
    expect(bodyOf(await submitted.handler(deleteRequest())).error.code).toBe(
      'CLAIM_NOT_EDITABLE',
    );
    expect(submitted.sent).toEqual([]);
  });

  it('fails generically on infrastructure errors without a direct cleanup', async () => {
    const { handler, objectCalls, local } = build({
      getStoredClaim: () => Promise.reject(new Error('secret failure')),
    });
    const response = await handler(deleteRequest());
    expect(response.status).toBe(500);
    expect(response.body as string).not.toContain('secret failure');
    expect(objectCalls).toEqual([]);
    expect(local.calls).toBe(0);
  });
});

describe('GET /claims/:claimId/receipt through the AWS download path', () => {
  const withReceipt = () => build({ claim: draft(true) });

  it('returns the documented URL and expiry for the owner, with no-store caching', async () => {
    const { handler, signed, local } = withReceipt();

    const response = await handler(download());

    expect(response.status).toBe(200);
    expect(bodyOf(response)).toEqual({
      url: 'https://claimflow-receipts-test.s3.amazonaws.com/receipts/r-old?sig=1',
      expiresAt: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
    });
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(response.headers['Content-Type'] ?? '').not.toContain(
      'application/pdf',
    );
    expect(signed).toEqual([
      {
        key: 'receipts/r-old',
        disposition: expect.stringContaining('old.pdf'),
      },
    ]);
    expect(local.calls).toBe(0);
  });

  it('applies the claim visibility rule: manager and administrator see it, a stranger does not', async () => {
    const submitted = draft(true, {
      status: 'SUBMITTED',
      assignedManagerId: 'sub-ben',
      submittedAt: '2026-10-14T10:25:00.000Z',
    });
    for (const subject of ['sub-aisha', 'sub-ben', 'sub-dan']) {
      expect(
        (await build({ claim: submitted }).handler(download(subject))).status,
      ).toBe(200);
    }
    const stranger = withReceipt();
    const hidden = await stranger.handler(download('sub-stranger'));
    const missing = await build({ claim: undefined }).handler(download());
    expect(hidden.status).toBe(404);
    expect(bodyOf(hidden).error.message).toBe(bodyOf(missing).error.message);
    expect(stranger.signed).toEqual([]);
  });

  it('requires authentication and treats a claim without a receipt or a bad ID as not found', async () => {
    const { handler, signed } = withReceipt();
    expect((await handler(download(null))).status).toBe(401);
    expect((await handler(download('sub-ghost'))).status).toBe(401);
    const none = await build({ claim: draft(false) }).handler(download());
    expect(none.status).toBe(404);
    expect(bodyOf(none).error.message).toBe('This claim has no receipt.');
    expect((await handler(download('sub-aisha', 'a b'))).status).toBe(404);
    expect(signed).toEqual([]);
  });

  it('treats a receipt record that contradicts the claim as an internal error, not a URL', async () => {
    for (const record of [
      undefined,
      { ...attachedRecord(), attachedClaimId: 'other' },
      { ...attachedRecord(), state: 'REMOVED' as const, expiresAt: 5 },
      { ...attachedRecord(), fileName: 'different.pdf' },
    ]) {
      const h = build({
        claim: draft(true),
        receipts: { 'r-old': record },
      });
      const response = await h.handler(download());
      expect(response.status).toBe(500);
      expect(bodyOf(response).error.code).toBe('INTERNAL_ERROR');
      expect(h.signed).toEqual([]);
    }
  });

  it('fails generically when the claim read or the signer fails, never using the local download', async () => {
    const failing = build({
      claim: draft(true),
      claimGet: () => Promise.reject(new Error('secret read failure')),
    });
    const a = await failing.handler(download());
    expect(a.status).toBe(500);
    expect(a.body as string).not.toContain('secret read failure');

    const signing = build({
      claim: draft(true),
      sign: () => Promise.reject(new Error('signer down')),
    });
    expect((await signing.handler(download())).status).toBe(500);
    expect(failing.local.calls + signing.local.calls).toBe(0);
  });
});

describe('defaults and isolation', () => {
  it('keeps the local handlers when nothing is registered, including the local binary download', async () => {
    const h = build({ withoutAws: true });
    for (const req of [
      attachRequest(),
      removeRequest(),
      deleteRequest(),
      download(),
    ]) {
      await h.handler(req);
    }
    expect(h.local.calls).toBe(4);
    expect(h.sent).toEqual([]);
    expect(h.signed).toEqual([]);
  });

  it('does not fall back to the local path when a registered mutation or read fails', async () => {
    const h = build({
      mutations: {
        'receipt.attach': () => Promise.reject(new Error('down')),
        'claim.delete': () => Promise.reject(new Error('down')),
      },
      reads: { 'receipt.read': () => Promise.reject(new Error('down')) },
    });
    for (const req of [attachRequest(), deleteRequest(), download()]) {
      expect((await h.handler(req)).status).toBe(500);
    }
    expect(h.local.calls).toBe(0);
  });

  it('leaves unregistered receipt operations local', async () => {
    const h = build({
      mutations: {
        'claim.delete': claimDeleteMutation({
          delete: () => Promise.reject(new Error('x')),
        }),
      },
      reads: {},
    });
    await h.handler(removeRequest());
    await h.handler(download());
    expect(h.local.calls).toBe(2);
  });
});
