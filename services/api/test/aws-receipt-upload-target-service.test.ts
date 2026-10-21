import type {
  TransactWriteCommandInput,
  TransactWriteCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import type { Actor } from '@claimflow/domain';
import { describe, expect, it } from 'vitest';

import { AwsReceiptUploadTargetService } from '../src/adapters/aws/aws-receipt-upload-target-service.js';
import type { ClaimCreationContext } from '../src/adapters/aws/aws-claim-creation-service.js';
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
import {
  S3UploadFormGenerator,
  type UploadFormRequest,
} from '../src/adapters/aws/s3-upload-form.js';
import { toEpochSeconds } from '../src/application/commit.js';

const tableName = 'ClaimFlow';
const receiptId = 'r-7731';
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

const declaration = {
  fileName: 'Flight receipt.pdf',
  contentType: 'application/pdf',
  sizeBytes: 52_144,
  checksumSha256: 'a1b2'.repeat(16),
};
const context: ClaimCreationContext = {
  idempotencyKey: 'upload-key-0001',
  fingerprint: 'ab'.repeat(32),
  now,
  requestId: 'request-1',
};

const cancelled = () =>
  Object.assign(new Error('cancelled'), {
    name: 'TransactionCanceledException',
  });

interface Options {
  newId?: () => string;
  execute?: (input: TransactWriteCommandInput) => Promise<void>;
  signFailures?: number;
}

function build(options: Options = {}) {
  const sent: TransactWriteCommandInput[] = [];
  const store = new Map<string, IdempotencyRecord>();
  const receipts = new Map<string, ReceiptRecord>();
  const calls = { newId: 0, receiptGet: 0, signed: 0 };
  const requests: UploadFormRequest[] = [];
  let failures = options.signFailures ?? 0;

  const executor = {
    execute: async (input: TransactWriteCommandInput) => {
      sent.push(input);
      await options.execute?.(input);
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
  const coordinator = new ReceiptUploadCoordinator({
    preparer: new DynamoDbReceiptUploadWriter({ executor, tableName }),
    lookup: idempotency,
    committer: new DynamoDbIdempotentTransactionCommitter({
      executor,
      lookup: idempotency,
    }),
    resolver: new ReceiptUploadReplayResolver({
      receipts: {
        get: (id) => {
          calls.receiptGet += 1;
          return Promise.resolve(receipts.get(id));
        },
      },
      forms: new S3UploadFormGenerator({
        bucketName: 'claimflow-receipts-test',
        sign: (request) => {
          requests.push(request);
          if (failures > 0) {
            failures -= 1;
            return Promise.reject(new Error('SignerFailure'));
          }
          calls.signed += 1;
          return Promise.resolve({
            url: 'https://claimflow-receipts-test.s3.ap-southeast-1.amazonaws.com/',
            fields: {
              ...request.fields,
              Policy: `policy-${calls.signed}`,
              'X-Amz-Signature': `signature-${calls.signed}`,
            },
          });
        },
      }),
    }),
    rejections: idempotency,
  });
  const service = new AwsReceiptUploadTargetService({
    uploads: coordinator,
    ids: {
      newId: () => {
        calls.newId += 1;
        return options.newId?.() ?? receiptId;
      },
    },
  });
  return { service, sent, store, receipts, calls, requests };
}

const code = (record: IdempotencyRecord) =>
  (record.response as { body: { error: { code: string } } }).body.error.code;

describe('construction', () => {
  it.each([
    ['uploads', 'The upload coordinator is missing.'],
    ['ids', 'The ID generator is missing.'],
  ])('rejects missing %s', (name, message) => {
    expect(
      () =>
        new AwsReceiptUploadTargetService({
          uploads: { run: () => Promise.reject(new Error('x')) },
          ids: { newId: () => 'x' },
          [name]: undefined,
        }),
    ).toThrow(new TypeError(message));
  });
});

describe('a new upload target', () => {
  it('stores pending metadata and a reference atomically, and returns a fresh form', async () => {
    const { service, sent, store, receipts, calls, requests } = build();

    const result = await service.create(employee, declaration, context);

    expect(result.record).toMatchObject({
      outcome: 'COMPLETED',
      actorId: 'sub-aisha',
      key: context.idempotencyKey,
      fingerprint: context.fingerprint,
      createdAt: now,
      expiresAt: nowEpoch + 24 * 60 * 60,
      response: { status: 201, resultRef: { receiptId } },
    });
    expect(result.upload?.receiptId).toBe(receiptId);
    expect(result.upload?.form.url).toMatch(/^https:/);
    expect(result.upload?.form.fields.Policy).toBe('policy-1');

    expect(sent).toHaveLength(1);
    expect(sent[0]!.TransactItems!.map((item) => Object.keys(item)[0])).toEqual(
      ['Put', 'Put'],
    );
    expect(receipts.get(receiptId)).toEqual({
      receiptId,
      ownerId: 'sub-aisha',
      state: 'PENDING',
      fileName: 'Flight receipt.pdf',
      declaredContentType: 'application/pdf',
      declaredSizeBytes: 52_144,
      declaredChecksumSha256: declaration.checksumSha256,
      uploadedAt: now,
      expiresAt: nowEpoch + 24 * 60 * 60,
    });
    expect(store.size).toBe(1);
    expect(calls.newId).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.key).toBe(`uploads/pending/${receiptId}`);

    // Neither the URL nor any form field is persisted.
    const persisted = JSON.stringify([...store.values()]).toLowerCase();
    for (const word of ['https', 'policy', 'signature', 'url']) {
      expect(persisted).not.toContain(word);
    }
  });

  it('sanitizes the file name and derives the owner from the actor alone', async () => {
    const { service, receipts } = build();

    await service.create(
      employee,
      { ...declaration, fileName: '../secret/Pay slip?.pdf' },
      context,
    );

    expect(receipts.get(receiptId)).toMatchObject({
      fileName: 'Pay slip.pdf',
      ownerId: 'sub-aisha',
    });
  });

  it('refuses an owner, identity, or ID supplied in the declaration', async () => {
    for (const smuggled of [
      { ownerId: 'sub-ben' },
      { employeeId: 'sub-ben' },
      { receiptId: 'r-chosen' },
      { uploadedAt: '2020-01-01T00:00:00.000Z' },
    ]) {
      const { service, sent, calls } = build();
      const result = await service.create(
        employee,
        { ...declaration, ...smuggled },
        context,
      );
      expect(result.record.outcome).toBe('REJECTED');
      expect(result.upload).toBeUndefined();
      expect(sent).toEqual([]);
      expect(calls.newId).toBe(0);
    }
  });
});

describe('replay', () => {
  it('returns the same receipt with a new form, without preparing, generating, or committing', async () => {
    const { service, sent, calls, requests } = build();
    const first = await service.create(employee, declaration, context);
    const before = { ...calls };

    const second = await service.create(employee, { not: 'parsed' }, context);

    expect(second.record).toEqual(first.record);
    expect(second.upload?.receiptId).toBe(receiptId);
    expect(second.upload?.form.fields.Policy).toBe('policy-2');
    expect(second.upload?.form.fields.Policy).not.toBe(
      first.upload?.form.fields.Policy,
    );
    expect(sent).toHaveLength(1);
    expect(calls.newId).toBe(before.newId);
    expect(requests[1]).toEqual(requests[0]);
  });

  it('replays a stored rejection without a form or any generated ID', async () => {
    const { service, calls, sent } = build();
    const first = await service.create(manager, declaration, context);
    expect(first.record.outcome).toBe('REJECTED');

    const second = await service.create(manager, declaration, context);

    expect(second.record).toEqual(first.record);
    expect(second.upload).toBeUndefined();
    expect(calls.newId).toBe(0);
    expect(sent).toEqual([]);
  });

  it('refuses another fingerprint under the same key', async () => {
    const { service } = build();
    await service.create(employee, declaration, context);
    await expect(
      service.create(employee, declaration, {
        ...context,
        fingerprint: 'cd'.repeat(32),
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
});

describe('rejections', () => {
  it('rejects a non-employee as forbidden, generating nothing', async () => {
    const { service, calls, sent, store } = build();

    const result = await service.create(manager, declaration, context);

    expect(result.record).toMatchObject({
      outcome: 'REJECTED',
      response: { status: 403 },
    });
    expect(code(result.record)).toBe('FORBIDDEN');
    expect(result.upload).toBeUndefined();
    expect(calls.newId).toBe(0);
    expect(sent).toEqual([]);
    expect(store.size).toBe(1);
  });

  it.each([
    ['an unsupported type', { contentType: 'text/html' }],
    ['a zero size', { sizeBytes: 0 }],
    ['a fractional size', { sizeBytes: 1.5 }],
    ['a size above 10 MB', { sizeBytes: 10 * 1024 * 1024 + 1 }],
    ['a non-hex checksum', { checksumSha256: 'xyz' }],
    ['an upper-case checksum', { checksumSha256: 'A1B2'.repeat(16) }],
    ['a missing field', { fileName: undefined }],
    ['an unknown field', { extra: true }],
    ['an empty file name', { fileName: '' }],
  ])('rejects %s as invalid, generating nothing', async (_name, patch) => {
    const { service, calls, sent } = build();

    const result = await service.create(
      employee,
      { ...declaration, ...patch },
      context,
    );

    expect(result.record.outcome).toBe('REJECTED');
    expect(result.record.response.status).toBe(400);
    expect(code(result.record)).toBe('VALIDATION_FAILED');
    expect(result.record.response).toMatchObject({
      body: { error: { requestId: 'request-1' } },
    });
    expect(result.upload).toBeUndefined();
    expect(calls.newId).toBe(0);
    expect(sent).toEqual([]);
  });

  it('accepts the size boundaries', async () => {
    for (const sizeBytes of [1, 10 * 1024 * 1024]) {
      const { service } = build();
      const result = await service.create(
        employee,
        { ...declaration, sizeBytes },
        context,
      );
      expect(result.record.outcome).toBe('COMPLETED');
    }
  });
});

describe('concurrent winners', () => {
  it('resolves the winner of a lost commit race, not this request', async () => {
    const harness = build({
      execute: (input) => {
        // A concurrent request for the same key committed another receipt.
        const winnerReceipt = {
          PK: 'RECEIPT#r-winner',
          SK: 'RECEIPT',
          entityType: 'Receipt',
          receiptId: 'r-winner',
          ownerId: 'sub-aisha',
          state: 'PENDING',
          fileName: 'Other.pdf',
          declaredContentType: 'application/pdf',
          declaredSizeBytes: 100,
          declaredChecksumSha256: 'c3d4'.repeat(16),
          objectKey: 'uploads/pending/r-winner',
          uploadedAt: now,
          expiresAt: nowEpoch + 24 * 60 * 60,
        };
        harness.receipts.set('r-winner', decodeReceiptItem(winnerReceipt));
        const winner: IdempotencyRecord = {
          actorId: 'sub-aisha',
          key: context.idempotencyKey,
          fingerprint: context.fingerprint,
          outcome: 'COMPLETED',
          response: { status: 201, resultRef: { receiptId: 'r-winner' } },
          createdAt: now,
          expiresAt: nowEpoch + 24 * 60 * 60,
        };
        harness.store.set(
          String(input.TransactItems!.at(-1)!.Put!.Item!.PK),
          winner,
        );
        return Promise.reject(cancelled());
      },
    });

    const result = await harness.service.create(employee, declaration, context);

    expect(result.upload?.receiptId).toBe('r-winner');
    expect(harness.requests[0]!.key).toBe('uploads/pending/r-winner');
  });

  it('returns a concurrent rejection intact, without a form', async () => {
    const harness = build();
    const winner: IdempotencyRecord = {
      actorId: 'sub-ben',
      key: context.idempotencyKey,
      fingerprint: context.fingerprint,
      outcome: 'REJECTED',
      response: { status: 409, body: { error: { code: 'VERSION_CONFLICT' } } },
      createdAt: now,
      expiresAt: nowEpoch + 24 * 60 * 60,
    };
    // The rejection write for the manager loses to a stored completed winner.
    harness.store.set(
      idempotencyKey('sub-ben', context.idempotencyKey).PK,
      winner,
    );

    const result = await harness.service.create(manager, declaration, context);

    expect(result.record).toEqual(winner);
    expect(result.upload).toBeUndefined();
  });
});

describe('post-commit signing failure', () => {
  it('keeps the committed metadata, and a retry recovers without a second commit', async () => {
    const { service, sent, store, receipts, calls } = build({
      signFailures: 1,
    });

    await expect(
      service.create(employee, declaration, context),
    ).rejects.toThrow('SignerFailure');
    expect(store.size).toBe(1);
    expect(receipts.has(receiptId)).toBe(true);
    expect(sent).toHaveLength(1);

    const retried = await service.create(employee, declaration, context);

    expect(retried.upload?.receiptId).toBe(receiptId);
    expect(sent).toHaveLength(1);
    expect(calls.newId).toBe(1);
  });
});

describe('infrastructure failures', () => {
  it('propagates the ID generator failure unchanged, storing nothing', async () => {
    const failure = new Error('ids failed');
    const { service, store, sent } = build({
      newId: () => {
        throw failure;
      },
    });

    await expect(service.create(employee, declaration, context)).rejects.toBe(
      failure,
    );
    expect(store.size).toBe(0);
    expect(sent).toEqual([]);
  });

  it('propagates a non-ambiguous transaction failure unchanged, with no rejection stored', async () => {
    const failure = Object.assign(new Error('bad'), {
      name: 'ValidationException',
    });
    const { service, store } = build({
      execute: () => Promise.reject(failure),
    });

    await expect(service.create(employee, declaration, context)).rejects.toBe(
      failure,
    );
    expect(store.size).toBe(0);
  });

  it('does not turn an invalid generated ID into a business rejection', async () => {
    const { service, store } = build({ newId: () => 'not a valid id!' });

    await expect(
      service.create(employee, declaration, context),
    ).rejects.toBeInstanceOf(Error);
    expect(store.size).toBe(0);
  });
});

describe('invalid requests', () => {
  it.each([
    [
      'an actor without an ID',
      { ...employee, userId: '' },
      context,
      'The actor is not valid.',
    ],
    [
      'a missing context',
      employee,
      undefined,
      'The request context is missing.',
    ],
    [
      'an invalid key',
      employee,
      { ...context, idempotencyKey: 'a b' },
      'The idempotency key is not valid.',
    ],
    [
      'an invalid fingerprint',
      employee,
      { ...context, fingerprint: 'abc' },
      'The request fingerprint is not valid.',
    ],
    [
      'a non-canonical time',
      employee,
      { ...context, now: '2026-10-14' },
      'The request time is not valid.',
    ],
  ])('refuses %s before any dependency call', (_name, who, ctx, message) => {
    const { service, calls, sent } = build();

    expect(() =>
      service.create(who, declaration, ctx as ClaimCreationContext),
    ).toThrow(new TypeError(message));
    expect(calls).toEqual({ newId: 0, receiptGet: 0, signed: 0 });
    expect(sent).toEqual([]);
  });
});
