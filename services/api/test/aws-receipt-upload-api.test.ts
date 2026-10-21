import type {
  TransactWriteCommandInput,
  TransactWriteCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import type { Actor } from '@claimflow/domain';
import { describe, expect, it } from 'vitest';

import { AwsReceiptUploadTargetService } from '../src/adapters/aws/aws-receipt-upload-target-service.js';
import {
  receiptUploadTargetBodyModes,
  receiptUploadTargetMutation,
} from '../src/adapters/aws/claim-mutations.js';
import { DynamoDbIdempotencyCoordinator } from '../src/adapters/aws/dynamodb-idempotency-coordinator.js';
import {
  decodeIdempotencyItem,
  encodeIdempotencyItem,
  idempotencyKey,
  type IdempotencyRecord,
} from '../src/adapters/aws/dynamodb-idempotency-items.js';
import { DynamoDbIdempotentTransactionCommitter } from '../src/adapters/aws/dynamodb-idempotent-transaction-committer.js';
import {
  decodeReceiptItem,
  type ReceiptRecord,
} from '../src/adapters/aws/dynamodb-receipt-items.js';
import { DynamoDbReceiptUploadWriter } from '../src/adapters/aws/dynamodb-receipt-upload-writer.js';
import { ReceiptUploadCoordinator } from '../src/adapters/aws/receipt-upload-coordinator.js';
import { ReceiptUploadReplayResolver } from '../src/adapters/aws/receipt-upload-replay-resolver.js';
import { S3UploadFormGenerator } from '../src/adapters/aws/s3-upload-form.js';
import type { Application } from '../src/composition.js';
import {
  createApiHandler,
  maxJsonBytes,
  type ApiRequest,
  type ApiResponse,
} from '../src/http/api-handler.js';
import { createAwsRoutes } from '../src/http/routes.js';

const tableName = 'ClaimFlow';
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
};
const declaration = {
  fileName: 'Flight receipt.pdf',
  contentType: 'application/pdf',
  sizeBytes: 52_144,
  checksumSha256: checksum,
};

interface Options {
  signFailures?: number;
  withoutAws?: boolean;
  /** Register the mutation without its explicit JSON body mode. */
  withoutBodyMode?: boolean;
}

/** The real upload orchestration behind ApiHandler, over fake AWS dependencies. */
function build(options: Options = {}) {
  const sent: TransactWriteCommandInput[] = [];
  const store = new Map<string, IdempotencyRecord>();
  const receipts = new Map<string, ReceiptRecord>();
  const local = { upload: 0, idempotency: 0 };
  const logs: unknown[] = [];
  let failures = options.signFailures ?? 0;
  let signed = 0;
  let ids = 0;

  const executor = {
    execute: (input: TransactWriteCommandInput) => {
      sent.push(input);
      for (const item of input.TransactItems!) {
        const stored = item.Put?.Item;
        if (stored === undefined) continue;
        if (String(stored.PK).startsWith('RECEIPT#')) {
          receipts.set(
            String(stored.PK).slice('RECEIPT#'.length),
            decodeReceiptItem(stored),
          );
        } else if (String(stored.PK).startsWith('IDEMPOTENCY#')) {
          store.set(String(stored.PK), decodeIdempotencyItem(stored));
        }
      }
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
  const service = new AwsReceiptUploadTargetService({
    uploads: new ReceiptUploadCoordinator({
      preparer: new DynamoDbReceiptUploadWriter({ executor, tableName }),
      lookup: idempotency,
      committer: new DynamoDbIdempotentTransactionCommitter({
        executor,
        lookup: idempotency,
      }),
      resolver: new ReceiptUploadReplayResolver({
        receipts: { get: (id) => Promise.resolve(receipts.get(id)) },
        forms: new S3UploadFormGenerator({
          bucketName: 'claimflow-receipts-test',
          sign: (request) => {
            if (failures > 0) {
              failures -= 1;
              return Promise.reject(new Error('signer secret detail'));
            }
            signed += 1;
            return Promise.resolve({
              url: 'https://claimflow-receipts-test.s3.ap-southeast-1.amazonaws.com/',
              fields: {
                ...request.fields,
                Policy: `policy-${signed}`,
                'X-Amz-Signature': `signature-${signed}`,
              },
            });
          },
        }),
      }),
      rejections: idempotency,
    }),
    ids: { newId: () => `r-${++ids}` },
  });

  const app = {
    idempotency: {
      run: (_a: string, _k: string, _f: string, fn: () => Promise<unknown>) => {
        local.idempotency += 1;
        return fn().then((response) => ({ response, replayed: false }));
      },
    },
    logger: {
      info: (...args: unknown[]) => logs.push(args),
      warn: (...args: unknown[]) => logs.push(args),
      error: (...args: unknown[]) => logs.push(args),
    },
    receipts: {
      upload: (_actor: Actor, input: { content: Uint8Array }) => {
        local.upload += 1;
        return Promise.resolve({
          receiptId: 'local-receipt',
          size: input.content.byteLength,
        });
      },
    },
  } as unknown as Application;
  const handler = createApiHandler(app, {
    routes: createAwsRoutes(app),
    authenticate: (request) =>
      Promise.resolve(actors[request.verifiedSubject ?? '']),
    ...(options.withoutAws === true
      ? {}
      : {
          mutations: {
            'receipt.upload': receiptUploadTargetMutation(service),
          },
          ...(options.withoutBodyMode === true
            ? {}
            : { bodyModes: receiptUploadTargetBodyModes }),
        }),
    now: () => now,
  });
  return { handler, sent, store, receipts, local, logs };
}

function call(
  body: Uint8Array | object | undefined,
  init: {
    key?: string | null;
    subject?: string | null;
    contentType?: string;
  } = {},
): ApiRequest {
  const bytes =
    body instanceof Uint8Array
      ? body
      : new TextEncoder().encode(
          body === undefined ? '' : JSON.stringify(body),
        );
  const key = init.key === undefined ? 'upload-key-0001' : init.key;
  const subject = init.subject === undefined ? 'sub-aisha' : init.subject;
  return {
    method: 'POST',
    path: '/api/v1/receipts',
    query: {},
    headers: {
      'content-type': init.contentType ?? 'application/json',
      ...(key === null ? {} : { 'idempotency-key': key }),
    },
    ...(subject === null ? {} : { verifiedSubject: subject }),
    readBody: (limit) =>
      Promise.resolve(bytes.byteLength > limit ? undefined : bytes),
  };
}
const bodyOf = (response: ApiResponse) =>
  JSON.parse(response.body as string) as Record<string, any>;

describe('POST /receipts through the AWS upload-target path', () => {
  it('returns 201 with the receipt ID and a fresh form, stored as a reference only', async () => {
    const { handler, sent, store, receipts, local } = build();

    const response = await handler(call(declaration));

    expect(response.status).toBe(201);
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(response.headers).not.toHaveProperty('Idempotent-Replayed');
    expect(bodyOf(response)).toEqual({
      receiptId: 'r-1',
      form: {
        url: 'https://claimflow-receipts-test.s3.ap-southeast-1.amazonaws.com/',
        fields: expect.objectContaining({
          Policy: 'policy-1',
          'X-Amz-Signature': 'signature-1',
        }),
      },
    });
    expect(sent).toHaveLength(1);
    expect(receipts.get('r-1')).toMatchObject({
      state: 'PENDING',
      ownerId: 'sub-aisha',
      fileName: 'Flight receipt.pdf',
    });
    const stored = [...store.values()][0]!;
    expect(stored.response).toEqual({
      status: 201,
      resultRef: { receiptId: 'r-1' },
    });
    expect(JSON.stringify(stored)).not.toContain('signature-1');
    expect(local).toEqual({ upload: 0, idempotency: 0 });
  });

  it('replays the same receipt with a newly signed form and no second commit', async () => {
    const { handler, sent, receipts } = build();
    const first = await handler(call(declaration));
    const second = await handler(call(declaration));

    expect(second.status).toBe(201);
    expect(second.headers['Cache-Control']).toBe('no-store');
    expect(bodyOf(second).receiptId).toBe(bodyOf(first).receiptId);
    expect(bodyOf(second).form.fields['X-Amz-Signature']).toBe('signature-2');
    expect(sent).toHaveLength(1);
    expect(receipts.size).toBe(1);
  });

  it('never logs or persists the signed form', async () => {
    const { handler, logs, store } = build();
    await handler(call(declaration));
    const text = JSON.stringify([logs, [...store.values()]]);
    expect(text).not.toContain('signature-1');
    expect(text).not.toContain('policy-1');
    expect(text).not.toContain('s3.ap-southeast-1');
  });

  it.each(['sub-ben', 'sub-dan'])(
    'stores FORBIDDEN for %s and returns it unchanged on replay',
    async (subject) => {
      const { handler, sent, receipts } = build();
      const first = await handler(call(declaration, { subject }));
      const second = await handler(call(declaration, { subject }));

      expect(first.status).toBe(403);
      expect(bodyOf(first).error.code).toBe('FORBIDDEN');
      expect(first.headers['Cache-Control']).toBe('no-store');
      expect(bodyOf(second)).toEqual(bodyOf(first));
      expect(sent).toHaveLength(0);
      expect(receipts.size).toBe(0);
    },
  );

  it('requires authentication and an idempotency key', async () => {
    const { handler, sent } = build();
    expect((await handler(call(declaration, { subject: null }))).status).toBe(
      401,
    );
    expect((await handler(call(declaration, { key: null }))).status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it.each([
    ['an unknown field', { ...declaration, ownerId: 'sub-dan' }],
    ['a bad content type', { ...declaration, contentType: 'text/html' }],
    ['a zero size', { ...declaration, sizeBytes: 0 }],
    ['an oversized file', { ...declaration, sizeBytes: 10_485_761 }],
    ['a bad checksum', { ...declaration, checksumSha256: 'xyz' }],
    ['no body', undefined],
  ])(
    'stores VALIDATION_FAILED for %s without metadata',
    async (_name, body) => {
      const { handler, sent, receipts } = build();
      const response = await handler(call(body));
      expect(response.status).toBe(400);
      expect(bodyOf(response).error.code).toBe('VALIDATION_FAILED');
      expect(response.headers['Cache-Control']).toBe('no-store');
      expect(sent).toHaveLength(0);
      expect(receipts.size).toBe(0);
    },
  );

  it('answers the same key with a different declaration as a conflict', async () => {
    const { handler, sent } = build();
    await handler(call(declaration));
    const response = await handler(call({ ...declaration, sizeBytes: 52_145 }));
    expect(response.status).toBe(409);
    expect(sent).toHaveLength(1);
  });

  it('keeps the metadata when signing fails and recovers on retry', async () => {
    const { handler, sent, receipts, logs } = build({ signFailures: 1 });

    const failed = await handler(call(declaration));
    expect(failed.status).toBe(500);
    expect(failed.body).not.toContain('signer secret detail');
    expect(receipts.size).toBe(1);

    const retry = await handler(call(declaration));
    expect(retry.status).toBe(201);
    expect(bodyOf(retry).receiptId).toBe('r-1');
    expect(sent).toHaveLength(1);
    expect(receipts.size).toBe(1);
    expect(JSON.stringify(logs)).not.toContain('signature-');
  });

  it('parses JSON with the JSON limit, not the raw receipt limit', async () => {
    const { handler, sent, local } = build();
    const response = await handler(
      call(new Uint8Array(maxJsonBytes + 1).fill(32)),
    );
    expect(response.status).toBe(413);
    expect(sent).toHaveLength(0);
    expect(local.upload).toBe(0);
  });

  it('requires application/json and never falls back to the raw handler', async () => {
    const { handler, sent, local } = build();
    const response = await handler(
      call(new TextEncoder().encode(JSON.stringify(declaration)), {
        contentType: 'application/pdf',
      }),
    );
    expect(response.status).toBe(400);
    expect(sent).toHaveLength(0);
    expect(local).toEqual({ upload: 0, idempotency: 0 });
  });
});

describe('local compatibility', () => {
  it('keeps the raw-byte local upload and local idempotency when nothing is registered', async () => {
    const { handler, sent, local } = build({ withoutAws: true });
    const bytes = new TextEncoder().encode('%PDF-1.7 raw');

    const response = await handler(
      call(bytes, { contentType: 'application/pdf' }),
    );

    expect(response.status).toBe(201);
    expect(bodyOf(response)).toMatchObject({
      receiptId: 'local-receipt',
      size: bytes.byteLength,
    });
    expect(local).toEqual({ upload: 1, idempotency: 1 });
    expect(sent).toHaveLength(0);
  });

  it('accepts raw bodies above the JSON limit locally', async () => {
    const { handler, local } = build({ withoutAws: true });
    const response = await handler(
      call(new Uint8Array(maxJsonBytes + 1), {
        contentType: 'application/pdf',
      }),
    );
    expect(response.status).toBe(201);
    expect(local.upload).toBe(1);
  });

  it('does not infer JSON from the content type for a registration without a body mode', async () => {
    const { handler, sent } = build({ withoutBodyMode: true });
    const response = await handler(call(declaration));
    expect(response.status).toBe(400);
    expect(bodyOf(response).error.code).toBe('VALIDATION_FAILED');
    expect(sent).toHaveLength(0);
  });

  it('refuses a body mode without a registered mutation', () => {
    expect(() =>
      createApiHandler({} as never, {
        routes: [],
        authenticate: () => Promise.resolve(undefined),
        bodyModes: { 'receipt.upload': 'json' },
      }),
    ).toThrow(TypeError);
  });
});
