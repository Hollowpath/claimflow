import type {
  TransactWriteCommandInput,
  TransactWriteCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import type { Actor, Category, Claim } from '@claimflow/domain';
import { describe, expect, it } from 'vitest';

import {
  AwsDraftDeletionService,
  AwsReceiptRemovalService,
  ClaimRemovalIntegrityError,
} from '../src/adapters/aws/aws-claim-removal-services.js';
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
  retiredReceiptExpiresAt,
  type AttachedReceiptRecord,
  type ReceiptRecord,
} from '../src/adapters/aws/dynamodb-receipt-items.js';
import { toEpochSeconds } from '../src/application/commit.js';
import type { UserProfile } from '../src/application/ports.js';

const tableName = 'ClaimFlow';
const claimId = '4ce0c74b-9c64-46d6-87ba-07fb71b0628c';
const now = '2026-10-14T10:41:00.000Z';
const nowEpoch = toEpochSeconds(new Date(now));

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
  receiptId: 'r-1',
  fileName: 'flight.pdf',
  contentType: 'application/pdf' as const,
  sizeBytes: 52_144,
  checksumSha256: 'a1b2'.repeat(16),
  attachedAt: '2026-10-14T10:10:00.000Z',
};
const attached = (
  patch: Partial<AttachedReceiptRecord> = {},
): AttachedReceiptRecord => ({
  receiptId: 'r-1',
  ownerId: 'sub-aisha',
  state: 'ATTACHED',
  fileName: 'flight.pdf',
  contentType: 'application/pdf',
  sizeBytes: 52_144,
  checksumSha256: 'a1b2'.repeat(16),
  uploadedAt: '2026-10-14T10:00:00.000Z',
  attachedClaimId: claimId,
  ...patch,
});
const draft = (
  withCategory: boolean,
  withReceipt: boolean,
  patch: Partial<Claim> = {},
): Claim => {
  const claim: Claim = {
    claimId,
    employeeId: 'sub-aisha',
    ...(withCategory ? { categoryId: 'travel' } : {}),
    amount: { amountMinor: 45_000, currency: 'MYR' },
    merchant: 'Regional Airline',
    status: 'DRAFT',
    version: 4,
    createdAt: '2026-10-14T10:00:00.000Z',
    updatedAt: '2026-10-14T10:20:00.000Z',
    ...(withReceipt ? { receipt } : {}),
    ...patch,
  };
  return claim;
};

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
  claim?: Claim | undefined;
  claimScript?: (Claim | undefined)[];
  receiptScript?: (ReceiptRecord | undefined)[];
  categoryScript?: ({ claimCount: number } | undefined)[];
  execute?: (input: TransactWriteCommandInput) => Promise<void>;
  finds?: (IdempotencyRecord | undefined)[];
  getStoredClaim?: () => Promise<unknown>;
  receiptGet?: () => Promise<ReceiptRecord | undefined>;
  getMany?: () => Promise<readonly UserProfile[]>;
  prepare?: () => never;
  sleep?: () => Promise<void>;
}

function build(options: Options = {}) {
  const claim = 'claim' in options ? options.claim : draft(true, true);
  const calls = { claimGet: 0, newId: 0, receiptGet: 0, categoryGet: 0 };
  const sent: TransactWriteCommandInput[] = [];
  const sleeps: number[] = [];
  const logs: { level: string; event: string; fields: unknown }[] = [];
  const store = new Map<string, IdempotencyRecord>();
  const claimScript = [...(options.claimScript ?? [])];
  const receiptScript = [...(options.receiptScript ?? [])];
  const categoryScript = [...(options.categoryScript ?? [])];
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
      getStored: (() => {
        calls.claimGet += 1;
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
      get: () => {
        calls.receiptGet += 1;
        if (options.receiptGet !== undefined) {
          return options.receiptGet();
        }
        return Promise.resolve(
          receiptScript.length > 0 ? receiptScript.shift() : attached(),
        );
      },
    },
    categories: {
      getStored: (() => {
        calls.categoryGet += 1;
        const answer =
          categoryScript.length > 0
            ? categoryScript.shift()
            : { claimCount: 2 };
        return Promise.resolve(
          answer === undefined
            ? undefined
            : { category: travel, metadata: { claimCount: answer.claimCount } },
        );
      }) as never,
      list: () => Promise.resolve([travel]),
    },
    users: {
      get: () => Promise.resolve(undefined),
      getMany: () => options.getMany?.() ?? Promise.resolve(profiles),
    },
    ids: {
      newId: () => {
        calls.newId += 1;
        return `event-${calls.newId}`;
      },
    },
    sleep: (ms: number) => {
      sleeps.push(ms);
      return options.sleep?.() ?? Promise.resolve();
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
  };
  const removal = new AwsReceiptRemovalService({
    ...shared,
    claims: {
      prepareRemoveReceipt: (...args) => {
        if (options.prepare !== undefined) options.prepare();
        return writer.prepareRemoveReceipt(...args);
      },
    },
  });
  const deletion = new AwsDraftDeletionService({
    ...shared,
    claims: {
      prepareDeleteDraft: (...args) => {
        if (options.prepare !== undefined) options.prepare();
        return writer.prepareDeleteDraft(...args);
      },
    },
  });
  return { calls, sent, sleeps, logs, store, shared, removal, deletion };
}

const remove = (
  h: ReturnType<typeof build>,
  input: unknown = { expectedVersion: 4 },
  who = aisha,
  id = claimId,
) => h.removal.remove(who, id, input, context);
const del = (
  h: ReturnType<typeof build>,
  input: unknown = { expectedVersion: 4 },
  who = aisha,
  id = claimId,
) => h.deletion.delete(who, id, input, context);
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
const outbox = (input: TransactWriteCommandInput) =>
  input
    .TransactItems!.filter((i) =>
      String(i.Put?.Item?.SK ?? '').startsWith('OUTBOX#'),
    )
    .map((i) => i.Put!.Item!);
const errorOf = (record: IdempotencyRecord) =>
  (
    record.response as {
      body: { error: { code: string; details?: { code: string }[] } };
    }
  ).body.error;

describe('construction', () => {
  it.each([
    ['mutations', 'The mutation coordinator is missing.'],
    ['claimReader', 'The claim reader is missing.'],
    ['receipts', 'The receipt metadata reader is missing.'],
    ['categories', 'The category reader is missing.'],
    ['users', 'The user directory is missing.'],
    ['ids', 'The ID generator is missing.'],
    ['sleep', 'The sleep function is missing.'],
    ['random', 'The random function is missing.'],
    ['logger', 'The logger is missing.'],
    ['claims', 'The claim writer is missing.'],
  ])('rejects missing %s in both services', (name, message) => {
    const { shared } = build();
    const withClaims = {
      ...shared,
      claims: {
        prepareRemoveReceipt: () => ({}),
        prepareDeleteDraft: () => ({}),
      },
    };
    expect(
      () =>
        new AwsReceiptRemovalService({
          ...withClaims,
          [name]: undefined,
        } as never),
    ).toThrow(new TypeError(message));
    expect(
      () =>
        new AwsDraftDeletionService({
          ...withClaims,
          [name]: undefined,
        } as never),
    ).toThrow(new TypeError(message));
  });

  it('has no direct object or purge capability', () => {
    const { shared } = build();
    expect(Object.keys(shared)).not.toContain('objects');
    expect(Object.keys(shared)).not.toContain('purger');
  });
});

describe('receipt removal', () => {
  it('returns the updated claim and commits claim, history, receipt, cleanup event, and idempotency atomically', async () => {
    const h = build();

    const record = await remove(h);

    expect(record).toMatchObject({
      outcome: 'COMPLETED',
      actorId: 'sub-aisha',
      response: { status: 200, body: { claimId, version: 5 } },
    });
    expect(record.response).not.toHaveProperty('body.receipt');
    expect(
      JSON.stringify((record.response as { body: unknown }).body),
    ).not.toContain('r-1');
    expect(kinds(h.sent[0]!)).toEqual([
      'Update',
      'Put',
      'Update',
      'Put',
      'Put',
    ]);
    expect(keys(h.sent[0]!).slice(0, 3)).toEqual([
      `CLAIM#${claimId} CLAIM`,
      `CLAIM#${claimId} HISTORY#0000000005`,
      'RECEIPT#r-1 RECEIPT',
    ]);
    expect(
      h.sent[0]!.TransactItems![2]!.Update!.ExpressionAttributeValues,
    ).toMatchObject({
      ':state': 'REMOVED',
      ':expiresAt': retiredReceiptExpiresAt(now),
    });
    expect(outbox(h.sent[0]!)).toEqual([
      expect.objectContaining({
        eventType: 'internal.receipt-object-deletion-requested',
        payload: { claimId, receiptId: 'r-1', objectKey: 'receipts/r-1' },
        aggregate: expect.objectContaining({
          version: 5,
          previousEventVersion: null,
        }),
        correlationId: 'corr-1',
        causationId: 'request-1',
      }),
    ]);
    expect(h.calls.newId).toBe(1);
  });

  it('works with and without a category, which it never touches', async () => {
    for (const withCategory of [true, false]) {
      const h = build({ claim: draft(withCategory, true) });
      expect((await remove(h)).outcome).toBe('COMPLETED');
      expect(JSON.stringify(h.sent[0])).not.toContain('CATEGORIES');
    }
  });

  it('replays the stored result with no reads or generated IDs', async () => {
    const h = build();
    const first = await remove(h);
    const before = { ...h.calls };

    expect(await remove(h, { x: 1 }, aisha, 'not a valid id')).toEqual(first);
    expect(h.calls).toEqual(before);
    expect(h.sent).toHaveLength(1);
  });

  it('rejects a claim without a receipt, a non-owner, a non-draft, a stale version, and bad input', async () => {
    const none = build({ claim: draft(true, false) });
    expect(errorOf(await remove(none)).details?.[0]?.code).toBe('NO_RECEIPT');

    const byAdmin = await remove(build(), { expectedVersion: 4 }, admin);
    expect(errorOf(byAdmin).code).toBe('FORBIDDEN');

    const submitted = build({
      claim: draft(true, true, {
        status: 'SUBMITTED',
        assignedManagerId: 'sub-ben',
        submittedAt: '2026-10-14T10:25:00.000Z',
      }),
    });
    expect(errorOf(await remove(submitted)).code).toBe('CLAIM_NOT_EDITABLE');

    expect(errorOf(await remove(build(), { expectedVersion: 1 })).code).toBe(
      'VERSION_CONFLICT',
    );
    expect(
      (await remove(build(), { expectedVersion: 4, extra: 1 })).response.status,
    ).toBe(400);
    expect(
      (await remove(build(), { expectedVersion: 4 }, aisha, 'a b')).response
        .status,
    ).toBe(404);
  });

  it('treats a missing and an invisible claim identically', async () => {
    const missing = await remove(build({ claim: undefined }));
    const invisible = await remove(build(), { expectedVersion: 4 }, stranger);
    expect(missing.response.status).toBe(404);
    expect(invisible.response).toEqual(missing.response);
  });

  it('is an integrity failure when the receipt record disagrees with the claim', async () => {
    for (const record of [
      undefined,
      { ...attached(), state: 'REMOVED' as const, expiresAt: 5 },
      attached({ attachedClaimId: 'other' }),
      attached({ ownerId: 'sub-ben' }),
    ]) {
      const h = build({ receiptScript: [record] });
      const failure = await remove(h).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(ClaimRemovalIntegrityError);
      expect((failure as Error).message).toBe(
        'The receipt or category records of the claim are inconsistent.',
      );
      expect(h.store.size).toBe(0);
      expect(h.sent).toEqual([]);
    }
  });
});

describe('draft deletion', () => {
  const combos: [string, boolean, boolean, string[]][] = [
    ['no category and no receipt', false, false, []],
    ['a category and no receipt', true, false, ['CATEGORIES CATEGORY#travel']],
    ['a receipt and no category', false, true, ['RECEIPT#r-1 RECEIPT']],
    [
      'a category and a receipt',
      true,
      true,
      ['CATEGORIES CATEGORY#travel', 'RECEIPT#r-1 RECEIPT'],
    ],
  ];

  it.each(combos)(
    'commits a draft with %s as one atomic transaction and returns 204',
    async (_n, withCategory, withReceipt, business) => {
      const h = build({ claim: draft(withCategory, withReceipt) });

      const record = await del(h);

      expect(record).toMatchObject({
        outcome: 'COMPLETED',
        response: { status: 204 },
      });
      expect((record.response as { body?: unknown }).body).toBeUndefined();
      const sent = h.sent[0]!;
      expect(sent.TransactItems!.length).toBeLessThanOrEqual(6);
      expect(keys(sent)).toEqual([
        `CLAIM#${claimId} CLAIM`,
        ...business,
        expect.stringMatching(/^CLAIM#.* OUTBOX#.*/),
        ...(withReceipt ? [expect.stringMatching(/^CLAIM#.* OUTBOX#.*/)] : []),
        expect.stringMatching(/^IDEMPOTENCY#/),
      ]);
      expect(JSON.stringify(sent)).not.toContain('HISTORY#');
      const events = outbox(sent);
      expect(events.map((e) => e.eventType)).toEqual([
        'internal.claim-history-purge-requested',
        ...(withReceipt ? ['internal.receipt-object-deletion-requested'] : []),
      ]);
      for (const event of events) {
        expect(event).toMatchObject({
          aggregate: { version: 5, previousEventVersion: null },
          occurredAt: now,
          actorId: 'sub-aisha',
          correlationId: 'corr-1',
          causationId: 'request-1',
        });
      }
      expect(new Set(events.map((e) => e.eventId)).size).toBe(events.length);
      expect(h.calls.newId).toBe(events.length);
    },
  );

  it('replays the stored 204 with no reads or generated IDs', async () => {
    const h = build();
    const first = await del(h);
    const before = { ...h.calls };

    expect(await del(h, { x: 1 }, aisha, 'not a valid id')).toEqual(first);
    expect(h.calls).toEqual(before);
    expect(h.sent).toHaveLength(1);
  });

  it('applies the domain rules: owner, draft, and never submitted', async () => {
    expect(
      errorOf(await del(build(), { expectedVersion: 4 }, admin)).code,
    ).toBe('FORBIDDEN');
    const submitted = build({
      claim: draft(true, true, {
        status: 'SUBMITTED',
        assignedManagerId: 'sub-ben',
        submittedAt: '2026-10-14T10:25:00.000Z',
      }),
    });
    expect(errorOf(await del(submitted)).code).toBe('CLAIM_NOT_EDITABLE');
    const reopened = build({
      claim: draft(true, true, {
        submittedAt: '2026-10-14T10:05:00.000Z',
        assignedManagerId: 'sub-ben',
      }),
    });
    expect(errorOf(await del(reopened)).code).toBe('CLAIM_NOT_DELETABLE');
    expect(errorOf(await del(build(), { expectedVersion: 1 })).code).toBe(
      'VERSION_CONFLICT',
    );
    expect(
      (await del(build(), { expectedVersion: 4, extra: 1 })).response.status,
    ).toBe(400);
    const invisible = await del(build(), { expectedVersion: 4 }, stranger);
    const missing = await del(build({ claim: undefined }));
    expect(invisible.response).toEqual(missing.response);
    expect(missing.response.status).toBe(404);
  });

  it('is an integrity failure when the receipt record disagrees with the claim', async () => {
    const h = build({ receiptScript: [undefined] });
    await expect(del(h)).rejects.toBeInstanceOf(ClaimRemovalIntegrityError);
    expect(h.store.size).toBe(0);
  });
});

describe.each([
  [
    'receipt removal',
    (h: ReturnType<typeof build>, who?: Actor) =>
      remove(h, { expectedVersion: 4 }, who),
  ],
  [
    'draft deletion',
    (h: ReturnType<typeof build>, who?: Actor) =>
      del(h, { expectedVersion: 4 }, who),
  ],
] as const)('%s: concurrent winners and recovery', (_name, run) => {
  const winner: IdempotencyRecord = {
    actorId: 'sub-aisha',
    key: context.idempotencyKey,
    fingerprint: context.fingerprint,
    outcome: 'COMPLETED',
    response: { status: 200, body: { claimId: 'the-winner' } },
    createdAt: now,
    expiresAt: nowEpoch + 24 * 60 * 60,
  };

  it('returns the winner of a lost commit race', async () => {
    const h: ReturnType<typeof build> = build({
      execute: (input) => {
        h.store.set(String(input.TransactItems!.at(-1)!.Put!.Item!.PK), winner);
        return Promise.reject(cancelled());
      },
    });
    expect(await run(h)).toBe(winner);
  });

  it('returns a winner found by the recheck before any reread, and propagates a conflict', async () => {
    const found = build({
      execute: cancelFirst(1),
      finds: [undefined, undefined, winner],
    });
    expect(await run(found)).toBe(winner);
    expect(found.calls.claimGet).toBe(1);

    const conflicting = build({
      execute: cancelFirst(1),
      finds: [
        undefined,
        undefined,
        { ...winner, fingerprint: 'cd'.repeat(32) },
      ],
    });
    await expect(run(conflicting)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });

  it('retries unchanged state with a stable token and event IDs, after bounded jittered delays', async () => {
    const h = build({ execute: cancelFirst(2) });

    const record = await run(h);

    expect(record.outcome).toBe('COMPLETED');
    expect(h.sent).toHaveLength(3);
    expect(new Set(h.sent.map((s) => s.ClientRequestToken)).size).toBe(1);
    expect(
      new Set(
        h.sent.map((s) =>
          outbox(s)
            .map((e) => e.eventId)
            .join(),
        ),
      ),
    ).toHaveProperty('size', 1);
    expect(h.sleeps).toEqual([37, 75]);
    expect(h.logs.map((l) => l.event)).toEqual([
      expect.stringMatching(/\.retry$/),
      expect.stringMatching(/\.retry$/),
    ]);
    expect(JSON.stringify(h.logs)).not.toContain('sub-aisha');
  });

  it('stops after three commits and rethrows the cancellation unchanged', async () => {
    const original = cancelled();
    const h = build({ execute: () => Promise.reject(original) });

    await expect(run(h)).rejects.toBe(original);

    expect(h.sent).toHaveLength(3);
    expect(h.sleeps).toHaveLength(2);
    expect(h.logs.at(-1)).toMatchObject({
      level: 'warn',
      event: expect.stringMatching(/\.retries_exhausted$/),
    });
    expect(h.store.size).toBe(0);
  });

  it('stores NOT_FOUND or VERSION_CONFLICT when the claim changes', async () => {
    const gone = build({
      claimScript: [draft(true, true), undefined],
      execute: cancelFirst(1),
    });
    expect((await run(gone)).response.status).toBe(404);

    const hidden = build({
      claimScript: [
        draft(true, true),
        draft(true, true, { employeeId: 'sub-other' }),
      ],
      execute: cancelFirst(1),
    });
    expect(errorOf(await run(hidden)).code).toBe('NOT_FOUND');

    const moved = build({
      claimScript: [draft(true, true), draft(true, true, { version: 5 })],
      execute: cancelFirst(1),
    });
    expect(errorOf(await run(moved)).code).toBe('VERSION_CONFLICT');
    expect(moved.sent).toHaveLength(1);
  });

  it('applies the final checks at exhaustion before rethrowing', async () => {
    const h = build({
      claimScript: [
        draft(true, true),
        draft(true, true),
        draft(true, true),
        draft(true, true, { version: 9 }),
      ],
      execute: () => Promise.reject(cancelled()),
    });
    expect(errorOf(await run(h)).code).toBe('VERSION_CONFLICT');
    expect(h.sent).toHaveLength(3);
  });

  it('does not recover other errors', async () => {
    const failure = Object.assign(new Error('bad'), {
      name: 'ValidationException',
    });
    const h = build({ execute: () => Promise.reject(failure) });
    await expect(run(h)).rejects.toBe(failure);
    expect(h.sent).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });

  it('detects a receipt record that changed during recovery as an integrity failure', async () => {
    const h = build({
      receiptScript: [attached(), undefined],
      execute: cancelFirst(1),
    });
    await expect(run(h)).rejects.toBeInstanceOf(ClaimRemovalIntegrityError);
    expect(h.store.size).toBe(0);
  });

  it('propagates claim, receipt, user, preparation, and sleep failures unchanged, storing nothing', async () => {
    const failures: [string, Options][] = [
      [
        'claim',
        { getStoredClaim: () => Promise.reject(new Error('claim failed')) },
      ],
      [
        'receipt',
        { receiptGet: () => Promise.reject(new Error('receipt failed')) },
      ],
      [
        'preparation',
        {
          prepare: () => {
            throw new TypeError('preparation failed');
          },
        },
      ],
    ];
    for (const [name, options] of failures) {
      const h = build(options);
      await expect(run(h)).rejects.toThrow(`${name} failed`);
      expect(h.store.size).toBe(0);
      expect(h.sent).toEqual([]);
    }
    const failure = new Error('sleep failed');
    const sleeping = build({
      execute: cancelFirst(1),
      sleep: () => Promise.reject(failure),
    });
    await expect(run(sleeping)).rejects.toBe(failure);
  });
});

describe('category counter integrity', () => {
  it.each([
    ['a missing category', undefined],
    ['a counter at zero', { claimCount: 0 }],
  ])(
    'is a fixed integrity failure for %s during deletion recovery: no retry, nothing stored',
    async (_n, answer) => {
      const h = build({ categoryScript: [answer], execute: cancelFirst(1) });

      const failure = await del(h).catch((e: unknown) => e);

      expect(failure).toBeInstanceOf(ClaimRemovalIntegrityError);
      expect(h.sent).toHaveLength(1);
      expect(h.store.size).toBe(0);
    },
  );

  it('is checked by the final check too', async () => {
    const h = build({
      categoryScript: [{ claimCount: 2 }, { claimCount: 2 }, { claimCount: 0 }],
      execute: () => Promise.reject(cancelled()),
    });
    await expect(del(h)).rejects.toBeInstanceOf(ClaimRemovalIntegrityError);
    expect(h.sent).toHaveLength(3);
  });

  it('does not apply to receipt removal, which never touches the category', async () => {
    const h = build({ categoryScript: [undefined], execute: cancelFirst(1) });
    expect((await remove(h)).outcome).toBe('COMPLETED');
    expect(h.calls.categoryGet).toBe(0);
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
  ])('refuses %s before any dependency call', (_name, who, ctx, message) => {
    const h = build();
    expect(() =>
      h.removal.remove(
        who,
        claimId,
        { expectedVersion: 4 },
        ctx as ClaimLifecycleContext,
      ),
    ).toThrow(new TypeError(message));
    expect(() =>
      h.deletion.delete(
        who,
        claimId,
        { expectedVersion: 4 },
        ctx as ClaimLifecycleContext,
      ),
    ).toThrow(new TypeError(message));
    expect(h.calls).toEqual({
      claimGet: 0,
      newId: 0,
      receiptGet: 0,
      categoryGet: 0,
    });
  });
});
