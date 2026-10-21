import type {
  TransactWriteCommandInput,
  TransactWriteCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import type { Actor, Claim, UploadedReceipt } from '@claimflow/domain';
import { describe, expect, it } from 'vitest';

import {
  AwsReceiptAttachmentService,
  ReceiptAttachmentIntegrityError,
  type AwsReceiptAttachmentServiceDependencies,
} from '../src/adapters/aws/aws-receipt-attachment-service.js';
import type { ClaimLifecycleContext } from '../src/adapters/aws/aws-claim-lifecycle-service.js';
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
  retiredReceiptExpiresAt,
  type AttachedReceiptRecord,
  type PendingReceiptRecord,
  type ReceiptRecord,
} from '../src/adapters/aws/dynamodb-receipt-items.js';
import { ReceiptUnavailableError } from '../src/adapters/aws/s3-receipt-inspector.js';
import { toEpochSeconds } from '../src/application/commit.js';
import type { UserProfile } from '../src/application/ports.js';

const tableName = 'ClaimFlow';
const claimId = '4ce0c74b-9c64-46d6-87ba-07fb71b0628c';
const eventId = '8f3d2c1e-5a7b-4c1d-9e2f-0a1b2c3d4e5f';
const now = '2026-10-14T10:41:00.000Z';
const nowEpoch = toEpochSeconds(new Date(now));
const checksum = 'a1b2'.repeat(16);

const aisha: Actor = {
  userId: 'sub-aisha',
  displayName: 'Aisha Rahman',
  roles: ['EMPLOYEE'],
  managerId: 'sub-ben',
};
const admin: Actor = {
  userId: 'sub-dan',
  displayName: 'Dan Lee',
  roles: ['ADMIN'],
};
const stranger: Actor = {
  userId: 'sub-stranger',
  displayName: 'Sam',
  roles: ['EMPLOYEE'],
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

const pending = (
  id = 'r-new',
  patch: Partial<Omit<PendingReceiptRecord, 'expiresAt'>> = {},
): PendingReceiptRecord => {
  const record = {
    receiptId: id,
    ownerId: 'sub-aisha',
    state: 'PENDING' as const,
    fileName: 'flight.pdf',
    declaredContentType: 'application/pdf' as const,
    declaredSizeBytes: 52_144,
    declaredChecksumSha256: checksum,
    uploadedAt: '2026-10-14T10:30:00.000Z',
    ...patch,
  };
  return { ...record, expiresAt: pendingReceiptExpiresAt(record.uploadedAt) };
};
const attached = (id = 'r-old'): AttachedReceiptRecord => ({
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

const base: Claim = {
  claimId,
  employeeId: 'sub-aisha',
  categoryId: 'travel',
  amount: { amountMinor: 45_000, currency: 'MYR' },
  expenseDate: '2026-10-08',
  merchant: 'Regional Airline',
  businessPurpose: 'Client workshop',
  status: 'DRAFT',
  version: 4,
  createdAt: '2026-10-14T10:00:00.000Z',
  updatedAt: '2026-10-14T10:20:00.000Z',
};
const withReceipt: Claim = {
  ...base,
  receipt: {
    receiptId: 'r-old',
    fileName: 'old.pdf',
    contentType: 'application/pdf',
    sizeBytes: 9_000,
    checksumSha256: 'c3d4'.repeat(16),
    attachedAt: '2026-10-14T09:30:00.000Z',
  },
};

const request = (patch: object = {}) => ({
  expectedVersion: 4,
  receiptId: 'r-new',
  contentType: 'application/pdf',
  sizeBytes: 52_144,
  checksumSha256: checksum,
  ...patch,
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

interface Options {
  claim?: Claim | undefined;
  claimScript?: (Claim | undefined)[];
  receipts?: Record<string, (ReceiptRecord | undefined)[]>;
  inspect?: (record: PendingReceiptRecord) => Promise<UploadedReceipt>;
  promote?: () => Promise<void>;
  deletePending?: () => Promise<void>;
  execute?: (input: TransactWriteCommandInput) => Promise<void>;
  finds?: (IdempotencyRecord | undefined)[];
  getMany?: () => Promise<readonly UserProfile[]>;
  getStoredClaim?: () => Promise<unknown>;
  receiptGet?: (id: string) => Promise<ReceiptRecord | undefined>;
}

function build(options: Options = {}) {
  const claim = 'claim' in options ? options.claim : base;
  const receipts: Record<string, (ReceiptRecord | undefined)[]> = {};
  for (const [id, answers] of Object.entries(
    options.receipts ?? { 'r-new': [], 'r-old': [] },
  )) {
    receipts[id] = [...answers];
  }
  const defaults: Record<string, ReceiptRecord> = {
    'r-new': pending(),
    'r-old': attached(),
  };
  const log: string[] = [];
  const calls = {
    claimGet: 0,
    newId: 0,
    inspect: 0,
    promote: 0,
    deletePending: 0,
  };
  const sent: TransactWriteCommandInput[] = [];
  const sleeps: number[] = [];
  const logs: { level: string; event: string; fields: unknown }[] = [];
  const store = new Map<string, IdempotencyRecord>();
  const claimScript = [...(options.claimScript ?? [])];
  const keyOf = (r: { actorId: string; key: string }) =>
    idempotencyKey(r.actorId, r.key).PK;

  const executor = {
    execute: async (input: TransactWriteCommandInput) => {
      log.push('commit');
      sent.push(input);
      await options.execute?.(input);
      const last = input.TransactItems!.at(-1)!.Put!.Item!;
      store.set(String(last.PK), decodeIdempotencyItem(last));
      return { $metadata: {} } as TransactWriteCommandOutput;
    },
  };
  const finds = [...(options.finds ?? [])];
  const idempotency = new DynamoDbIdempotencyCoordinator({
    finder: {
      find: (actorId: string, key: string) =>
        finds.length > 0
          ? Promise.resolve(finds.shift())
          : Promise.resolve(store.get(idempotencyKey(actorId, key).PK)),
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
  const writer = new DynamoDbClaimWriter({ executor, tableName });
  const deps: AwsReceiptAttachmentServiceDependencies = {
    mutations: new ClaimMutationCoordinator({
      lookup: idempotency,
      committer: new DynamoDbIdempotentTransactionCommitter({
        executor,
        lookup: idempotency,
      }),
      rejections: idempotency,
    }),
    claimReader: {
      getStored: (() => {
        calls.claimGet += 1;
        log.push('claim');
        if (options.getStoredClaim !== undefined) {
          return options.getStoredClaim();
        }
        const current = claimScript.length > 0 ? claimScript.shift() : claim;
        return Promise.resolve(
          current === undefined ? undefined : { claim: current, metadata: {} },
        );
      }) as never,
    },
    receipts: {
      get: (id) => {
        log.push(`receipt:${id}`);
        if (options.receiptGet !== undefined) {
          return options.receiptGet(id);
        }
        const queue = receipts[id];
        if (queue !== undefined && queue.length > 0) {
          return Promise.resolve(queue.shift());
        }
        return Promise.resolve(defaults[id]);
      },
    },
    inspector: {
      inspect: (record) => {
        calls.inspect += 1;
        log.push('inspect');
        return (
          options.inspect?.(record) ??
          Promise.resolve({
            receiptId: record.receiptId,
            ownerId: record.ownerId,
            fileName: record.fileName,
            contentType: record.declaredContentType,
            sizeBytes: record.declaredSizeBytes,
            checksumSha256: record.declaredChecksumSha256,
            uploadedAt: record.uploadedAt,
          })
        );
      },
    },
    objects: {
      promote: () => {
        calls.promote += 1;
        log.push('promote');
        return options.promote?.() ?? Promise.resolve();
      },
      deletePending: () => {
        calls.deletePending += 1;
        log.push('deletePending');
        return options.deletePending?.() ?? Promise.resolve();
      },
    },
    categories: { list: () => Promise.resolve([]) },
    users: {
      get: () => Promise.resolve(undefined),
      getMany: () => options.getMany?.() ?? Promise.resolve(profiles),
    },
    claims: writer,
    ids: {
      newId: () => {
        calls.newId += 1;
        return eventId;
      },
    },
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
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
    log,
    store,
    deps,
    service: new AwsReceiptAttachmentService(deps),
  };
}

const attach = (
  harness: ReturnType<typeof build>,
  input: unknown = request(),
  who: Actor = aisha,
  id = claimId,
) => harness.service.attach(who, id, input, context);
const kinds = (input: TransactWriteCommandInput) =>
  input.TransactItems!.map((item) => Object.keys(item)[0]);
const keys = (input: TransactWriteCommandInput) =>
  input.TransactItems!.map((item) => {
    const op = Object.values(item)[0] as {
      Item?: Record<string, unknown>;
      Key?: Record<string, unknown>;
    };
    const key = op.Item ?? op.Key!;
    return `${String(key.PK)} ${String(key.SK)}`;
  });
const code = (record: IdempotencyRecord) =>
  (
    record.response as {
      body: { error: { code: string; details?: { code: string }[] } };
    }
  ).body.error;
const cancelFirst = (count: number) => {
  let sends = 0;
  return () =>
    ++sends <= count ? Promise.reject(cancelled()) : Promise.resolve();
};

describe('construction', () => {
  it.each([
    ['mutations', 'The mutation coordinator is missing.'],
    ['claimReader', 'The claim reader is missing.'],
    ['receipts', 'The receipt metadata reader is missing.'],
    ['inspector', 'The receipt inspector is missing.'],
    ['objects', 'The receipt objects are missing.'],
    ['categories', 'The category reader is missing.'],
    ['users', 'The user directory is missing.'],
    ['claims', 'The claim writer is missing.'],
    ['ids', 'The ID generator is missing.'],
    ['sleep', 'The sleep function is missing.'],
    ['random', 'The random function is missing.'],
    ['logger', 'The logger is missing.'],
  ])('rejects missing %s', (name, message) => {
    const { deps } = build();
    expect(
      () =>
        new AwsReceiptAttachmentService({
          ...deps,
          [name]: undefined,
        }),
    ).toThrow(new TypeError(message));
  });
});

describe('attachment', () => {
  it('runs in the documented order and commits claim, history, receipt, and idempotency atomically', async () => {
    const harness = build();

    const record = await attach(harness);

    expect(record).toMatchObject({
      outcome: 'COMPLETED',
      actorId: 'sub-aisha',
      response: { status: 200, body: { claimId, version: 5 } },
    });
    expect(
      (record.response as { body: { receipt: { receiptId: string } } }).body
        .receipt.receiptId,
    ).toBe('r-new');
    expect(harness.log).toEqual([
      'claim',
      'receipt:r-new',
      'inspect',
      'promote',
      'commit',
      'deletePending',
    ]);
    expect(kinds(harness.sent[0]!)).toEqual(['Update', 'Put', 'Update', 'Put']);
    expect(keys(harness.sent[0]!)).toEqual([
      `CLAIM#${claimId} CLAIM`,
      `CLAIM#${claimId} HISTORY#0000000005`,
      'RECEIPT#r-new RECEIPT',
      expect.stringMatching(/^IDEMPOTENCY#/),
    ]);
    expect(harness.calls.newId).toBe(0);
    expect(harness.calls.deletePending).toBe(1);
  });

  it('replays the stored snapshot without reading, inspecting, promoting, or deleting', async () => {
    const harness = build();
    const first = await attach(harness);
    const before = { ...harness.calls };
    const logBefore = harness.log.length;

    const replay = await attach(
      harness,
      { not: 'parsed' },
      aisha,
      'not a valid id',
    );

    expect(replay).toEqual(first);
    expect(harness.calls).toEqual(before);
    expect(harness.log).toHaveLength(logBefore);
    expect(harness.sent).toHaveLength(1);
  });

  it('refuses another fingerprint under the same key', async () => {
    const harness = build();
    await attach(harness);
    await expect(
      harness.service.attach(aisha, claimId, request(), {
        ...context,
        fingerprint: 'cd'.repeat(32),
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
});

describe('replacement', () => {
  const replacing = (options: Options = {}) =>
    build({ claim: withReceipt, ...options });

  it('retires the old receipt and requests the cleanup of its object, in one transaction', async () => {
    const harness = replacing();

    const record = await attach(harness);

    expect(record.outcome).toBe('COMPLETED');
    expect(kinds(harness.sent[0]!)).toEqual([
      'Update',
      'Put',
      'Update',
      'Update',
      'Put',
      'Put',
    ]);
    expect(keys(harness.sent[0]!).slice(2, 4)).toEqual([
      'RECEIPT#r-new RECEIPT',
      'RECEIPT#r-old RECEIPT',
    ]);
    const retire = harness.sent[0]!.TransactItems![3]!.Update!;
    expect(retire.ExpressionAttributeValues).toMatchObject({
      ':state': 'REPLACED',
      ':expiresAt': retiredReceiptExpiresAt(now),
      ':claimId': claimId,
    });
    expect(harness.sent[0]!.TransactItems![4]!.Put!.Item).toMatchObject({
      eventType: 'internal.receipt-object-deletion-requested',
      payload: { claimId, receiptId: 'r-old', objectKey: 'receipts/r-old' },
      aggregate: { version: 5, previousEventVersion: null },
    });
    expect(harness.calls.newId).toBe(1);
  });

  it('deletes only the new pending object, never the old or any final object', async () => {
    const harness = replacing();
    await attach(harness);
    expect(harness.calls.deletePending).toBe(1);
    expect(Object.keys(harness.deps.objects)).toEqual([
      'promote',
      'deletePending',
    ]);
  });

  it('is an integrity failure when the old receipt record disagrees with the claim', async () => {
    for (const answer of [
      undefined,
      { ...attached(), state: 'REMOVED' as const, expiresAt: 5 },
      { ...attached(), attachedClaimId: 'other' },
    ]) {
      const harness = replacing({
        receipts: { 'r-new': [], 'r-old': [answer] },
      });

      await expect(attach(harness)).rejects.toBeInstanceOf(
        ReceiptAttachmentIntegrityError,
      );
      expect(harness.calls.inspect).toBe(0);
      expect(harness.calls.promote).toBe(0);
      expect(harness.store.size).toBe(0);
    }
  });
});

describe('rejections', () => {
  const rejected = async (
    harness: ReturnType<typeof build>,
    ...rest: [unknown?, Actor?, string?]
  ) => {
    const record = await attach(harness, ...rest);
    expect(record.outcome).toBe('REJECTED');
    expect(harness.sent).toEqual([]);
    expect(harness.calls.promote).toBe(0);
    expect(harness.calls.deletePending).toBe(0);
    expect(harness.store.size).toBe(1);
    return record;
  };

  it('treats a missing and an invisible claim identically, and an invalid ID as not found', async () => {
    const missing = await rejected(build({ claim: undefined }));
    const invisible = await rejected(build(), request(), stranger);
    const malformed = await rejected(build(), request(), aisha, 'a b');
    expect(missing.response.status).toBe(404);
    expect(invisible.response).toEqual(missing.response);
    expect(malformed.response.status).toBe(404);
  });

  it('rejects a stale version before reading the receipt', async () => {
    const harness = build();
    const record = await rejected(harness, request({ expectedVersion: 1 }));
    expect(code(record).code).toBe('VERSION_CONFLICT');
    expect(harness.log).toEqual(['claim']);
  });

  it.each([
    ['an unknown field', request({ owner: 'sub-ben' })],
    ['a missing receipt ID', { ...request(), receiptId: undefined }],
    ['a negative size', request({ sizeBytes: -1 })],
    ['a non-object', 'attach'],
  ])('rejects %s as invalid input before any read', async (_name, input) => {
    const harness = build();
    const record = await rejected(harness, input);
    expect(record.response.status).toBe(400);
    expect(harness.calls.claimGet).toBe(0);
  });

  it.each([
    ['a missing receipt', { 'r-new': [undefined], 'r-old': [] }],
    [
      'a receipt that is already attached',
      { 'r-new': [attached('r-new')], 'r-old': [] },
    ],
    [
      'a receipt of another owner',
      { 'r-new': [pending('r-new', { ownerId: 'sub-ben' })], 'r-old': [] },
    ],
    [
      'an expired pending receipt',
      {
        'r-new': [pending('r-new', { uploadedAt: '2026-10-12T10:00:00.000Z' })],
        'r-old': [],
      },
    ],
  ])(
    'rejects %s as unavailable without inspecting',
    async (_name, receipts) => {
      const harness = build({ receipts });
      const record = await rejected(harness);
      expect(code(record).details?.[0]?.code).toBe('RECEIPT_UNAVAILABLE');
      expect(harness.calls.inspect).toBe(0);
    },
  );

  it('accepts a pending receipt expiring exactly now', async () => {
    const harness = build({
      receipts: {
        'r-new': [pending('r-new', { uploadedAt: '2026-10-13T10:41:00.000Z' })],
        'r-old': [],
      },
    });
    expect((await attach(harness)).outcome).toBe('COMPLETED');
  });

  it('rejects an object the inspector cannot verify, without promoting', async () => {
    const harness = build({
      inspect: () => Promise.reject(new ReceiptUnavailableError()),
    });
    const record = await rejected(harness);
    expect(code(record).details?.[0]?.code).toBe('RECEIPT_UNAVAILABLE');
    expect(harness.calls.inspect).toBe(1);
  });

  it.each([
    ['size', { sizeBytes: 1 }],
    ['content type', { contentType: 'image/png' }],
    ['checksum', { checksumSha256: 'f'.repeat(64) }],
  ])(
    'rejects a declared %s that differs from the measured one, without promoting',
    async (_name, patch) => {
      const harness = build();
      const record = await rejected(harness, request(patch));
      expect(JSON.stringify(record.response)).toContain('RECEIPT_MISMATCH');
      expect(harness.calls.inspect).toBe(1);
    },
  );

  it('rejects an administrator who may view but not own the claim, and a non-draft claim', async () => {
    const byAdmin = await rejected(build(), request(), admin);
    expect(code(byAdmin).code).toBe('FORBIDDEN');

    const submitted = await rejected(
      build({
        claim: {
          ...base,
          status: 'SUBMITTED',
          assignedManagerId: 'sub-ben',
          submittedAt: '2026-10-14T10:25:00.000Z',
        },
      }),
    );
    expect(code(submitted).code).toBe('CLAIM_NOT_EDITABLE');
  });

  it('rejects when the object vanishes before promotion, deleting nothing', async () => {
    const harness = build({
      promote: () => Promise.reject(new ReceiptUnavailableError()),
    });
    const record = await attach(harness);
    expect(record.outcome).toBe('REJECTED');
    expect(harness.sent).toEqual([]);
    expect(harness.calls.deletePending).toBe(0);
  });
});

describe('concurrent winners', () => {
  const winnerFor = (receiptId: string): IdempotencyRecord => ({
    actorId: 'sub-aisha',
    key: context.idempotencyKey,
    fingerprint: context.fingerprint,
    outcome: 'COMPLETED',
    response: { status: 200, body: { claimId, receipt: { receiptId } } },
    createdAt: now,
    expiresAt: nowEpoch + 24 * 60 * 60,
  });
  const losing = (winner: IdempotencyRecord) => {
    const harness: ReturnType<typeof build> = build({
      execute: (input) => {
        harness.store.set(
          String(input.TransactItems!.at(-1)!.Put!.Item!.PK),
          winner,
        );
        return Promise.reject(cancelled());
      },
    });
    return harness;
  };

  it('returns the winner of a lost commit race and deletes only the confirmed pending object', async () => {
    const same = losing(winnerFor('r-new'));
    expect(await attach(same)).toBe(same.store.values().next().value);
    expect(same.calls.deletePending).toBe(1);

    const other = losing(winnerFor('r-other'));
    await attach(other);
    expect(other.calls.deletePending).toBe(0);
    expect(other.sent).toHaveLength(1);
  });

  it('returns a winner found by the recovery recheck before any reread', async () => {
    const harness = build({
      execute: () => Promise.reject(cancelled()),
      finds: [undefined, undefined, winnerFor('r-other')],
    });
    expect((await attach(harness)).response).toMatchObject({ status: 200 });
    expect(harness.calls.claimGet).toBe(1);
    expect(harness.calls.deletePending).toBe(0);
  });

  it('lets a fingerprint conflict propagate', async () => {
    const harness = build({
      execute: () => Promise.reject(cancelled()),
      finds: [
        undefined,
        undefined,
        { ...winnerFor('r-new'), fingerprint: 'cd'.repeat(32) },
      ],
    });
    await expect(attach(harness)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });
});

describe('cancellation recovery', () => {
  it('retries unchanged state after a backoff, re-inspecting and re-promoting, and deletes the pending object once', async () => {
    const harness = build({ execute: cancelFirst(1) });

    const record = await attach(harness);

    expect(record.outcome).toBe('COMPLETED');
    expect(harness.sent).toHaveLength(2);
    expect(harness.sent[1]!.ClientRequestToken).toBe(
      harness.sent[0]!.ClientRequestToken,
    );
    expect(harness.calls).toMatchObject({
      inspect: 2,
      promote: 2,
      deletePending: 1,
    });
    expect(harness.sleeps).toEqual([37]);
    expect(harness.logs).toEqual([
      {
        level: 'info',
        event: 'receipt.attach.retry',
        fields: { operation: 'receipt.attach', retries: 1 },
      },
    ]);
  });

  it('keeps one cleanup event ID across the rebuilds of a replacement', async () => {
    const harness = build({ claim: withReceipt, execute: cancelFirst(2) });
    await attach(harness);
    const ids = harness.sent.map(
      (s) =>
        s.TransactItems!.find((i) =>
          String(i.Put?.Item?.SK ?? '').startsWith('OUTBOX#'),
        )!.Put!.Item!.eventId,
    );
    expect(new Set(ids)).toEqual(new Set([eventId]));
    expect(harness.calls.newId).toBe(1);
  });

  it('stops after three commits and rethrows the cancellation, deleting nothing', async () => {
    const original = cancelled();
    const harness = build({ execute: () => Promise.reject(original) });

    await expect(attach(harness)).rejects.toBe(original);

    expect(harness.sent).toHaveLength(3);
    expect(harness.sleeps).toHaveLength(2);
    expect(harness.calls.promote).toBe(3);
    expect(harness.calls.deletePending).toBe(0);
    expect(harness.logs.at(-1)).toMatchObject({
      level: 'warn',
      event: 'receipt.attach.retries_exhausted',
    });
  });

  it('stores NOT_FOUND or VERSION_CONFLICT when the claim changes, never applying the attachment', async () => {
    const gone = build({
      claimScript: [base, undefined],
      execute: cancelFirst(1),
    });
    expect((await attach(gone)).response.status).toBe(404);

    const moved = build({
      claimScript: [base, { ...base, version: 5 }],
      execute: cancelFirst(1),
    });
    const record = await attach(moved);
    expect(code(record).code).toBe('VERSION_CONFLICT');
    expect(moved.sent).toHaveLength(1);
    expect(moved.calls.deletePending).toBe(0);
  });

  it('stores RECEIPT_UNAVAILABLE when the receipt is no longer pending', async () => {
    const harness = build({
      receipts: { 'r-new': [pending(), attached('r-new')], 'r-old': [] },
      execute: cancelFirst(1),
    });
    const record = await attach(harness);
    expect(code(record).details?.[0]?.code).toBe('RECEIPT_UNAVAILABLE');
    expect(harness.sent).toHaveLength(1);
    expect(harness.calls.deletePending).toBe(0);
  });

  it('applies the final checks before rethrowing at exhaustion', async () => {
    const original = cancelled();
    const harness = build({
      claimScript: [base, base, base, { ...base, version: 9 }],
      execute: () => Promise.reject(original),
    });
    expect(code(await attach(harness)).code).toBe('VERSION_CONFLICT');

    const lost = build({
      receipts: {
        'r-new': [pending(), pending(), pending(), undefined],
        'r-old': [],
      },
      execute: () => Promise.reject(original),
    });
    const record = await attach(lost);
    expect(code(record).details?.[0]?.code).toBe('RECEIPT_UNAVAILABLE');
    expect(lost.sent).toHaveLength(3);
  });

  it('does not recover other errors and keeps the pending object', async () => {
    const failure = Object.assign(new Error('bad'), {
      name: 'ValidationException',
    });
    const harness = build({ execute: () => Promise.reject(failure) });
    await expect(attach(harness)).rejects.toBe(failure);
    expect(harness.sent).toHaveLength(1);
    expect(harness.sleeps).toEqual([]);
    expect(harness.calls.deletePending).toBe(0);
  });
});

describe('failures across the S3 and transaction boundaries', () => {
  it.each([
    [
      'the claim read',
      { getStoredClaim: () => Promise.reject(new Error('claim failed')) },
      'claim failed',
    ],
    [
      'the receipt read',
      { receiptGet: () => Promise.reject(new Error('receipt failed')) },
      'receipt failed',
    ],
    [
      'the inspection',
      { inspect: () => Promise.reject(new Error('inspect failed')) },
      'inspect failed',
    ],
    [
      'the promotion',
      { promote: () => Promise.reject(new Error('promote failed')) },
      'promote failed',
    ],
    [
      'the user read',
      { getMany: () => Promise.reject(new Error('users failed')) },
      'users failed',
    ],
  ])(
    'propagates a failure of %s unchanged, storing nothing and deleting nothing',
    async (_name, options, message) => {
      const harness = build(options);
      await expect(attach(harness)).rejects.toThrow(message);
      expect(harness.store.size).toBe(0);
      expect(harness.sent).toEqual([]);
      expect(harness.calls.deletePending).toBe(0);
    },
  );

  it('keeps a promoted object when the transaction fails: it is the janitor that recovers it', async () => {
    const failure = Object.assign(new Error('bad'), {
      name: 'ValidationException',
    });
    const harness = build({ execute: () => Promise.reject(failure) });
    await expect(attach(harness)).rejects.toBe(failure);
    expect(harness.calls.promote).toBe(1);
    expect(harness.calls.deletePending).toBe(0);
  });

  it('returns the result when the best-effort pending deletion fails, logging safely', async () => {
    const harness = build({
      deletePending: () => Promise.reject(new Error('secret s3 detail')),
    });

    const record = await attach(harness);

    expect(record.outcome).toBe('COMPLETED');
    expect(harness.logs).toEqual([
      {
        level: 'warn',
        event: 'receipt.attach.pending_delete_failed',
        fields: { operation: 'receipt.attach' },
      },
    ]);
    expect(JSON.stringify(harness.logs)).not.toContain('secret');
  });

  it('propagates an unresolved cancellation with the pending object untouched', async () => {
    const original = cancelled();
    const harness = build({ execute: () => Promise.reject(original) });
    await expect(attach(harness)).rejects.toBe(original);
    expect(harness.calls.deletePending).toBe(0);
  });
});

describe('invalid requests', () => {
  it.each([
    [
      'an actor without an ID',
      { ...aisha, userId: '' },
      context,
      'The actor is not valid.',
    ],
    ['a missing context', aisha, undefined, 'The request context is missing.'],
    [
      'an invalid key',
      aisha,
      { ...context, idempotencyKey: 'a b' },
      'The idempotency key is not valid.',
    ],
    [
      'an invalid correlation ID',
      aisha,
      { ...context, correlationId: 'a b' },
      'The correlation ID is not valid.',
    ],
  ])(
    'refuses %s before any dependency call',
    async (_name, who, ctx, message) => {
      const harness = build();
      await expect(
        harness.service.attach(
          who,
          claimId,
          request(),
          ctx as ClaimLifecycleContext,
        ),
      ).rejects.toThrow(new TypeError(message));
      expect(harness.log).toEqual([]);
      expect(harness.sent).toEqual([]);
    },
  );
});
