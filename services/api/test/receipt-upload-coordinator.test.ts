import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';

import type { IdempotencyRecord } from '../src/adapters/aws/dynamodb-idempotency-items.js';
import {
  pendingReceiptExpiresAt,
  type PendingReceiptRecord,
} from '../src/adapters/aws/dynamodb-receipt-items.js';
import { DynamoDbReceiptUploadWriter } from '../src/adapters/aws/dynamodb-receipt-upload-writer.js';
import {
  ReceiptUploadCoordinator,
  type PendingTransactionPreparer,
  type UploadIdempotencyLookup,
  type UploadReplayResolver,
  type UploadTransactionCommitter,
} from '../src/adapters/aws/receipt-upload-coordinator.js';
import type { ReceiptUploadReplay } from '../src/adapters/aws/receipt-upload-replay-resolver.js';
import type {
  CommitOptions,
  CompletedRequest,
} from '../src/application/commit.js';
import { IdempotencyConflictError } from '../src/application/errors.js';
import { expiresAfter } from '../src/application/commit.js';

const uploadedAt = '2026-10-14T10:35:00.000Z';
const createdEpoch = Math.floor(Date.parse(uploadedAt) / 1000);

const pending: PendingReceiptRecord = {
  receiptId: 'r-7731',
  ownerId: 'sub-aisha',
  state: 'PENDING',
  fileName: 'flight.pdf',
  declaredContentType: 'application/pdf',
  declaredSizeBytes: 52_144,
  declaredChecksumSha256: 'a1b2'.repeat(16),
  uploadedAt,
  expiresAt: pendingReceiptExpiresAt(uploadedAt),
};

const completed: CompletedRequest = {
  actorId: 'sub-aisha',
  key: 'upload-key-0001',
  fingerprint: 'ef'.repeat(32),
  response: { status: 201, resultRef: { receiptId: 'r-7731' } },
  createdAt: uploadedAt,
  expiresAt: expiresAfter(new Date(uploadedAt), 24 * 60 * 60 * 1000),
};
const candidate: IdempotencyRecord = { ...completed, outcome: 'COMPLETED' };
const earlierReference: IdempotencyRecord = {
  ...candidate,
  response: { status: 201, resultRef: { receiptId: 'r-0001' } },
};
const rejection: IdempotencyRecord = {
  ...candidate,
  outcome: 'REJECTED',
  response: { status: 409, body: { error: { code: 'VERSION_CONFLICT' } } },
};
const snapshot: IdempotencyRecord = {
  ...candidate,
  response: { status: 201, body: { receiptId: 'r-7731' } },
};

const transaction: TransactWriteCommandInput = {
  TransactItems: [
    { Put: { TableName: 'ClaimFlow', Item: { PK: 'x', SK: 'y' } } },
  ],
  ClientRequestToken: 'a'.repeat(32),
};

const form = (n: number) => ({
  url: 'https://claimflow-receipts-test.s3.ap-southeast-1.amazonaws.com/',
  fields: { Policy: `policy-${n}`, 'X-Amz-Signature': `signature-${n}` },
});

type Event = { readonly kind: string; readonly args: unknown[] };

interface Script {
  readonly lookups?: (IdempotencyRecord | undefined | Error)[];
  readonly commits?: (IdempotencyRecord | Error)[];
  readonly resolves?: (Error | undefined)[];
  readonly prepareFailure?: Error;
}

function setup(script: Script = {}) {
  const events: Event[] = [];
  const lookups = [...(script.lookups ?? [])];
  const commits = [...(script.commits ?? [candidate])];
  const resolves = [...(script.resolves ?? [])];
  let issued = 0;
  const preparer: PendingTransactionPreparer = {
    preparePending: (...args) => {
      events.push({ kind: 'prepare', args });
      if (script.prepareFailure !== undefined) {
        throw script.prepareFailure;
      }
      return transaction;
    },
  };
  const lookup: UploadIdempotencyLookup = {
    lookup: (...args) => {
      events.push({ kind: 'lookup', args });
      const next = lookups.shift();
      return next instanceof Error
        ? Promise.reject(next)
        : Promise.resolve(next);
    },
  };
  const committer: UploadTransactionCommitter = {
    commit: (...args) => {
      events.push({ kind: 'commit', args });
      const next = commits.shift() ?? candidate;
      return next instanceof Error
        ? Promise.reject(next)
        : Promise.resolve(next);
    },
  };
  const resolver: UploadReplayResolver = {
    resolve: (...args) => {
      events.push({ kind: 'resolve', args });
      const failure = resolves.shift();
      if (failure !== undefined) {
        return Promise.reject(failure);
      }
      issued += 1;
      const record = args[0].response as { resultRef: { receiptId: string } };
      const replay: ReceiptUploadReplay = {
        receiptId: record.resultRef.receiptId,
        form: form(issued),
      };
      return Promise.resolve(replay);
    },
  };
  return {
    events,
    coordinator: new ReceiptUploadCoordinator({
      preparer,
      lookup,
      committer,
      resolver,
    }),
  };
}

const kinds = (events: Event[]) => events.map((event) => event.kind);
const create = (coordinator: ReceiptUploadCoordinator) =>
  coordinator.create(pending, completed, createdEpoch);

describe('construction', () => {
  const working = {
    preparer: { preparePending: () => transaction },
    lookup: { lookup: () => Promise.resolve(undefined) },
    committer: { commit: () => Promise.resolve(candidate) },
    resolver: { resolve: () => Promise.reject(new Error('unused')) },
  };

  it.each([
    ['preparer', 'The pending transaction preparer is missing.'],
    ['lookup', 'The idempotency lookup is missing.'],
    ['committer', 'The transaction committer is missing.'],
    ['resolver', 'The upload replay resolver is missing.'],
  ])('rejects a missing %s', (name, message) => {
    for (const bad of [undefined, null, {}]) {
      expect(
        () =>
          new ReceiptUploadCoordinator({
            ...working,
            [name]: bad,
          }),
      ).toThrow(new TypeError(message));
    }
  });

  it('exposes only create and run', () => {
    expect(
      Object.getOwnPropertyNames(ReceiptUploadCoordinator.prototype),
    ).toEqual(['constructor', 'create', 'run', 'commitCandidate', 'resolve']);
  });
});

describe('first creation', () => {
  it('looks up, prepares once with no events or guard, commits, then resolves the winner', async () => {
    const { events, coordinator } = setup({ lookups: [undefined] });

    const result = await create(coordinator);

    expect(result).toEqual({
      record: candidate,
      upload: { receiptId: 'r-7731', form: form(1) },
    });
    expect(kinds(events)).toEqual(['lookup', 'prepare', 'commit', 'resolve']);
    expect(events[0]!.args).toEqual([
      'sub-aisha',
      completed.key,
      completed.fingerprint,
      createdEpoch,
    ]);
    const options = events[1]!.args[1] as CommitOptions;
    expect(events[1]!.args[0]).toBe(pending);
    expect(options).toEqual({ events: [], idempotency: completed });
    expect(options).not.toHaveProperty('categoryGuard');
    expect(events[2]!.args).toEqual([transaction, completed, createdEpoch]);
    expect(events[2]!.args[0]).toBe(transaction);
    expect(events[3]!.args).toEqual([candidate, createdEpoch]);
  });

  it('works with the real upload writer as the preparer', async () => {
    let prepared: TransactWriteCommandInput | undefined;
    const writer = new DynamoDbReceiptUploadWriter({
      executor: { execute: () => Promise.reject(new Error('never sent')) },
      tableName: 'ClaimFlow',
    });
    const coordinator = new ReceiptUploadCoordinator({
      preparer: writer,
      lookup: { lookup: () => Promise.resolve(undefined) },
      committer: {
        commit: (input) => {
          prepared = input;
          return Promise.resolve(candidate);
        },
      },
      resolver: {
        resolve: () => Promise.resolve({ receiptId: 'r-7731', form: form(1) }),
      },
    });

    await create(coordinator);

    expect(prepared?.TransactItems).toHaveLength(2);
    expect(prepared?.ClientRequestToken).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('replay before any write', () => {
  it('uses a stored reference without preparing or committing the candidate', async () => {
    const { events, coordinator } = setup({ lookups: [candidate] });

    const result = await create(coordinator);

    expect(result.record).toBe(candidate);
    expect(result.upload?.receiptId).toBe('r-7731');
    expect(kinds(events)).toEqual(['lookup', 'resolve']);
  });

  it('returns a stored snapshot intact without the resolver', async () => {
    const { events, coordinator } = setup({ lookups: [snapshot] });

    const result = await create(coordinator);

    expect(result).toEqual({ record: snapshot });
    expect(result.record).toBe(snapshot);
    expect(result).not.toHaveProperty('upload');
    expect(kinds(events)).toEqual(['lookup']);
  });

  it('returns a stored rejection intact without the resolver', async () => {
    const { events, coordinator } = setup({ lookups: [rejection] });

    const result = await create(coordinator);

    expect(result).toEqual({ record: rejection });
    expect(kinds(events)).toEqual(['lookup']);
  });

  it('lets a fingerprint conflict propagate without preparing', async () => {
    const conflict = new IdempotencyConflictError('conflict');
    const { events, coordinator } = setup({ lookups: [conflict] });

    await expect(create(coordinator)).rejects.toBe(conflict);
    expect(kinds(events)).toEqual(['lookup']);
  });
});

describe('concurrent winners', () => {
  it('resolves the winning reference to another receipt, not the candidate', async () => {
    const { events, coordinator } = setup({
      lookups: [undefined],
      commits: [earlierReference],
    });

    const result = await create(coordinator);

    expect(result.record).toBe(earlierReference);
    expect(result.upload?.receiptId).toBe('r-0001');
    expect(events.at(-1)).toEqual({
      kind: 'resolve',
      args: [earlierReference, createdEpoch],
    });
    expect(kinds(events)).toEqual(['lookup', 'prepare', 'commit', 'resolve']);
  });

  it('returns a concurrent rejection intact, without the resolver', async () => {
    const { events, coordinator } = setup({
      lookups: [undefined],
      commits: [rejection],
    });

    const result = await create(coordinator);

    expect(result).toEqual({ record: rejection });
    expect(kinds(events)).toEqual(['lookup', 'prepare', 'commit']);
  });

  it('returns a concurrent snapshot success intact, without the resolver', async () => {
    const { events, coordinator } = setup({
      lookups: [undefined],
      commits: [snapshot],
    });

    expect(await create(coordinator)).toEqual({ record: snapshot });
    expect(kinds(events)).not.toContain('resolve');
  });
});

describe('invalid inputs', () => {
  const bad = (changes: {
    pending?: object;
    completed?: object;
    now?: number;
  }) =>
    [
      { ...pending, ...changes.pending } as PendingReceiptRecord,
      { ...completed, ...changes.completed },
      changes.now ?? createdEpoch,
    ] as const;

  it.each([
    [
      'a missing pending receipt',
      [undefined, completed, createdEpoch],
      'The pending receipt is missing.',
    ],
    [
      'a missing completed request',
      [pending, undefined, createdEpoch],
      'The completed request is missing.',
    ],
    [
      'a non-pending receipt',
      bad({ pending: { state: 'ATTACHED' } }),
      'The receipt must be pending.',
    ],
    [
      'an expired pending receipt',
      bad({ now: pending.expiresAt + 1 }),
      'The receipt upload has already expired.',
    ],
    [
      'another owner',
      bad({ pending: { ownerId: 'sub-ben' } }),
      'The pending receipt is not owned by the actor.',
    ],
    [
      'a snapshot result',
      bad({ completed: { response: { status: 201, body: {} } } }),
      'The completed result must reference the pending receipt.',
    ],
    [
      'a reference to another receipt',
      bad({
        completed: {
          response: { status: 201, resultRef: { receiptId: 'r-9999' } },
        },
      }),
      'The completed result must reference the pending receipt.',
    ],
  ])('refuses %s before any call', async (_name, args, message) => {
    const { events, coordinator } = setup();

    await expect(
      coordinator.create(
        args[0] as PendingReceiptRecord,
        args[1] as CompletedRequest,
        args[2] as number,
      ),
    ).rejects.toThrow(message);
    expect(events).toEqual([]);
  });

  it.each([
    ['a malformed receipt', bad({ pending: { declaredSizeBytes: 0 } })],
    ['a malformed checksum', bad({ pending: { declaredChecksumSha256: 'x' } })],
    ['a short fingerprint', bad({ completed: { fingerprint: 'ab' } })],
    ['an invalid key', bad({ completed: { key: '' } })],
    ['a wrong TTL', bad({ completed: { expiresAt: 5 } })],
    [
      'an unknown reference field',
      bad({
        completed: {
          response: {
            status: 201,
            resultRef: { receiptId: 'r-7731', url: 'x' },
          },
        },
      }),
    ],
    [
      'a body with the reference',
      bad({
        completed: {
          response: {
            status: 201,
            resultRef: { receiptId: 'r-7731' },
            body: {},
          },
        },
      }),
    ],
    ['a negative time', bad({ now: -1 })],
    ['a fractional time', bad({ now: 1.5 })],
  ])('refuses %s through the codecs before any call', async (_name, args) => {
    const { events, coordinator } = setup();
    await expect(coordinator.create(...args)).rejects.toBeInstanceOf(Error);
    expect(events).toEqual([]);
  });

  it('accepts a candidate expiring exactly now', async () => {
    const { events, coordinator } = setup({ lookups: [undefined] });

    await coordinator.create(pending, completed, completed.expiresAt);

    expect(kinds(events)).toEqual(['lookup', 'prepare', 'commit', 'resolve']);
  });

  it('echoes no supplied value in its messages', async () => {
    const { coordinator } = setup();
    const failures = await Promise.allSettled([
      coordinator.create(
        { ...pending, ownerId: 'Secret Owner' },
        completed,
        createdEpoch,
      ),
      coordinator.create(
        pending,
        {
          ...completed,
          response: { status: 201, resultRef: { receiptId: 'Secret-Receipt' } },
        },
        createdEpoch,
      ),
    ]);
    for (const failure of failures) {
      expect(failure.status).toBe('rejected');
      expect(String((failure as PromiseRejectedResult).reason)).not.toContain(
        'Secret',
      );
    }
  });
});

describe('dependency failures', () => {
  it('propagates a lookup error unchanged, without preparing', async () => {
    const failure = new Error('lookup failed');
    const { events, coordinator } = setup({ lookups: [failure] });

    await expect(create(coordinator)).rejects.toBe(failure);
    expect(kinds(events)).toEqual(['lookup']);
  });

  it('propagates a preparation error unchanged, without committing', async () => {
    const failure = new TypeError('cannot prepare');
    const { events, coordinator } = setup({
      lookups: [undefined],
      prepareFailure: failure,
    });

    await expect(create(coordinator)).rejects.toBe(failure);
    expect(kinds(events)).toEqual(['lookup', 'prepare']);
  });

  it('propagates a commit error unchanged, without resolving or retrying', async () => {
    const failure = Object.assign(new Error('cancelled'), {
      name: 'TransactionCanceledException',
    });
    const { events, coordinator } = setup({
      lookups: [undefined],
      commits: [failure],
    });

    await expect(create(coordinator)).rejects.toBe(failure);
    expect(kinds(events)).toEqual(['lookup', 'prepare', 'commit']);
  });

  it('propagates a commit conflict unchanged', async () => {
    const conflict = new IdempotencyConflictError('conflict');
    const { coordinator } = setup({
      lookups: [undefined],
      commits: [conflict],
    });
    await expect(create(coordinator)).rejects.toBe(conflict);
  });

  it('propagates a resolver error unchanged after a stored reference', async () => {
    const failure = new Error('unavailable');
    const { events, coordinator } = setup({
      lookups: [candidate],
      resolves: [failure],
    });

    await expect(create(coordinator)).rejects.toBe(failure);
    expect(kinds(events)).toEqual(['lookup', 'resolve']);
  });
});

describe('post-commit signing failure', () => {
  it('leaves the committed metadata in place and recovers on retry through the lookup', async () => {
    // A tiny store stands in for the idempotency record that the commit wrote.
    let stored: IdempotencyRecord | undefined;
    const events: Event[] = [];
    let signing = 0;
    const coordinator = new ReceiptUploadCoordinator({
      preparer: { preparePending: () => transaction },
      lookup: {
        lookup: () => {
          events.push({ kind: 'lookup', args: [] });
          return Promise.resolve(stored);
        },
      },
      committer: {
        commit: () => {
          events.push({ kind: 'commit', args: [] });
          stored = candidate;
          return Promise.resolve(candidate);
        },
      },
      resolver: {
        resolve: () => {
          events.push({ kind: 'resolve', args: [] });
          signing += 1;
          return signing === 1
            ? Promise.reject(new Error('SignerFailure'))
            : Promise.resolve({ receiptId: 'r-7731', form: form(signing) });
        },
      },
    });

    await expect(create(coordinator)).rejects.toThrow('SignerFailure');
    expect(stored).toBe(candidate);

    const retried = await create(coordinator);

    expect(retried.record).toBe(candidate);
    expect(retried.upload).toEqual({ receiptId: 'r-7731', form: form(2) });
    expect(kinds(events)).toEqual([
      'lookup',
      'commit',
      'resolve',
      'lookup',
      'resolve',
    ]);
  });
});

describe('run (lazy preparation)', () => {
  const request = {
    actorId: 'sub-aisha',
    key: completed.key,
    fingerprint: completed.fingerprint,
    nowEpoch: createdEpoch,
  };

  function lazy(stored?: IdempotencyRecord, withRejections = true) {
    const events: Event[] = [];
    const coordinator = new ReceiptUploadCoordinator({
      preparer: {
        preparePending: (...args) => {
          events.push({ kind: 'prepare', args });
          return transaction;
        },
      },
      lookup: {
        lookup: (...args) => {
          events.push({ kind: 'lookup', args });
          return Promise.resolve(stored);
        },
      },
      committer: {
        commit: (...args) => {
          events.push({ kind: 'commit', args });
          return Promise.resolve(candidate);
        },
      },
      resolver: {
        resolve: (record) => {
          events.push({ kind: 'resolve', args: [record] });
          return Promise.resolve({ receiptId: 'r-7731', form: form(1) });
        },
      },
      ...(withRejections
        ? {
            rejections: {
              recordRejection: (record: IdempotencyRecord) => {
                events.push({ kind: 'reject', args: [record] });
                return Promise.resolve(record);
              },
            },
          }
        : {}),
    });
    return { events, coordinator };
  }
  const prepared = () => {
    const calls: string[] = [];
    return {
      calls,
      prepare: () => {
        calls.push('prepare');
        return Promise.resolve({ pending, completed });
      },
    };
  };

  it('looks up first, prepares lazily and once, commits, and resolves', async () => {
    const { events, coordinator } = lazy();
    const { calls, prepare } = prepared();

    const result = await coordinator.run(request, prepare);

    expect(result.upload?.receiptId).toBe('r-7731');
    expect(kinds(events)).toEqual(['lookup', 'prepare', 'commit', 'resolve']);
    expect(calls).toEqual(['prepare']);
  });

  it('never calls the preparation when a record is stored', async () => {
    const { events, coordinator } = lazy(candidate);
    const { calls, prepare } = prepared();

    await coordinator.run(request, prepare);

    expect(calls).toEqual([]);
    expect(kinds(events)).toEqual(['lookup', 'resolve']);
  });

  it('stores an explicit rejection through the recorder, without committing or resolving', async () => {
    const { events, coordinator } = lazy();

    const result = await coordinator.run(request, () =>
      Promise.resolve({ rejection: rejection as never }),
    );

    expect(result).toEqual({ record: rejection });
    expect(kinds(events)).toEqual(['lookup', 'reject']);
  });

  it('resolves the winning reference returned by a rejection race', async () => {
    const racing = new ReceiptUploadCoordinator({
      preparer: { preparePending: () => transaction },
      lookup: { lookup: () => Promise.resolve(undefined) },
      committer: { commit: () => Promise.resolve(candidate) },
      resolver: {
        resolve: () => Promise.resolve({ receiptId: 'r-7731', form: form(1) }),
      },
      rejections: { recordRejection: () => Promise.resolve(candidate) },
    });

    const result = await racing.run(request, () =>
      Promise.resolve({ rejection: rejection as never }),
    );

    expect(result.record).toBe(candidate);
    expect(result.upload?.receiptId).toBe('r-7731');
  });

  it.each([
    [
      'a rejection without a recorder',
      undefined,
      'The rejection recorder is missing.',
    ],
    [
      'a completed result',
      { ...rejection, outcome: 'COMPLETED' },
      'The prepared rejection must be a rejected request.',
    ],
    [
      'a rejection for another actor',
      { ...rejection, actorId: 'sub-ben' },
      'The completed request is not for this request.',
    ],
    [
      'a rejection for another key',
      { ...rejection, key: 'another-key-0001' },
      'The completed request is not for this request.',
    ],
  ])('refuses %s before any write', async (_name, bad, message) => {
    const { events, coordinator } = lazy(undefined, bad !== undefined);
    const value = bad === undefined ? rejection : bad;

    await expect(
      coordinator.run(request, () =>
        Promise.resolve({ rejection: value as never }),
      ),
    ).rejects.toThrow(message);
    expect(kinds(events)).toEqual(['lookup']);
  });

  it('refuses a mixed preparation, a result for another request, and bad requests', async () => {
    const { events, coordinator } = lazy();

    await expect(
      coordinator.run(request, () =>
        Promise.resolve({ rejection, pending, completed } as never),
      ),
    ).rejects.toThrow('The prepared upload mixes its shapes.');
    await expect(
      coordinator.run(request, () =>
        Promise.resolve({
          pending,
          completed: { ...completed, key: 'another-key-0001' },
        }),
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(kinds(events)).not.toContain('commit');

    for (const bad of [
      { ...request, actorId: 'a b' },
      { ...request, key: '' },
      { ...request, fingerprint: 'abc' },
      { ...request, nowEpoch: -1 },
    ]) {
      await expect(
        coordinator.run(bad, () => prepared().prepare()),
      ).rejects.toBeInstanceOf(Error);
    }
    await expect(coordinator.run(request, undefined as never)).rejects.toThrow(
      'The upload preparation is missing.',
    );
  });

  it('propagates a preparation error unchanged', async () => {
    const failure = new Error('prepare failed');
    const { coordinator } = lazy();
    await expect(
      coordinator.run(request, () => Promise.reject(failure)),
    ).rejects.toBe(failure);
  });
});
