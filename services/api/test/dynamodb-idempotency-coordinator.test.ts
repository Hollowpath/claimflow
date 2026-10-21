import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { describe, expect, it } from 'vitest';

import {
  DynamoDbIdempotencyCoordinator,
  type IdempotencyFinder,
  type RejectionRecorder,
} from '../src/adapters/aws/dynamodb-idempotency-coordinator.js';
import type { IdempotencyRecord } from '../src/adapters/aws/dynamodb-idempotency-items.js';
import type { RejectedIdempotencyRecord } from '../src/adapters/aws/dynamodb-idempotency-writer.js';
import { IdempotencyConflictError } from '../src/application/errors.js';

const fingerprint = 'ab'.repeat(32);
const otherFingerprint = 'cd'.repeat(32);
const createdEpoch = 1_791_974_460;

const rejected: RejectedIdempotencyRecord = {
  actorId: 'sub-aisha',
  key: '5b0d6a8e-retry-key',
  fingerprint,
  outcome: 'REJECTED',
  response: {
    status: 409,
    body: {
      error: {
        code: 'VERSION_CONFLICT',
        message: 'This claim was changed by someone else.',
        requestId: 'request-1',
      },
    },
  },
  createdAt: '2026-10-14T10:41:00.000Z',
  expiresAt: 1_792_060_860,
};
const completed: IdempotencyRecord = {
  ...rejected,
  outcome: 'COMPLETED',
  response: { status: 201, body: { claimId: 'claim-1' } },
};

type Call =
  | { readonly kind: 'find'; readonly args: unknown[] }
  | { readonly kind: 'record'; readonly args: unknown[] };

/** Scripted fakes that share one call log, so call order can be checked. */
function setup(
  finds: (IdempotencyRecord | undefined | Error)[] = [],
  writeFailure?: Error,
) {
  const calls: Call[] = [];
  const finder: IdempotencyFinder = {
    find: (...args) => {
      calls.push({ kind: 'find', args });
      const next = finds.shift();
      return next instanceof Error
        ? Promise.reject(next)
        : Promise.resolve(next);
    },
  };
  const rejections: RejectionRecorder = {
    recordRejection: (...args) => {
      calls.push({ kind: 'record', args });
      return writeFailure === undefined
        ? Promise.resolve()
        : Promise.reject(writeFailure);
    },
  };
  return {
    calls,
    coordinator: new DynamoDbIdempotencyCoordinator({ finder, rejections }),
  };
}

const conditionalFailure = () =>
  new ConditionalCheckFailedException({
    message: 'The conditional request failed',
    $metadata: {},
  });

const lookup = (
  coordinator: DynamoDbIdempotencyCoordinator,
  print = fingerprint,
) => coordinator.lookup('sub-aisha', rejected.key, print, createdEpoch);

describe('construction', () => {
  it.each([undefined, null, {}, { find: 'find' }])(
    'rejects the finder %j',
    (finder) => {
      expect(
        () =>
          new DynamoDbIdempotencyCoordinator({
            finder: finder as unknown as IdempotencyFinder,
            rejections: { recordRejection: () => Promise.resolve() },
          }),
      ).toThrow(new TypeError('The idempotency finder is missing.'));
    },
  );

  it.each([undefined, null, {}, { recordRejection: 1 }])(
    'rejects the rejection recorder %j',
    (rejections) => {
      expect(
        () =>
          new DynamoDbIdempotencyCoordinator({
            finder: { find: () => Promise.resolve(undefined) },
            rejections: rejections as unknown as RejectionRecorder,
          }),
      ).toThrow(new TypeError('The rejection recorder is missing.'));
    },
  );

  it('exposes only the lookup and the rejection method', () => {
    expect(
      Object.getOwnPropertyNames(DynamoDbIdempotencyCoordinator.prototype),
    ).toEqual(['constructor', 'lookup', 'recordRejection']);
  });
});

describe('lookup', () => {
  it('returns undefined when no record exists or it has expired', async () => {
    const { calls, coordinator } = setup([undefined]);

    expect(await lookup(coordinator)).toBeUndefined();

    expect(calls).toEqual([
      {
        kind: 'find',
        args: ['sub-aisha', rejected.key, createdEpoch],
      },
    ]);
  });

  it.each([
    ['completed', completed],
    ['rejected', rejected],
  ])('returns a matching %s record for replay', async (_name, record) => {
    const { calls, coordinator } = setup([record]);

    expect(await lookup(coordinator)).toBe(record);
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['completed', completed],
    ['rejected', rejected],
  ])('refuses another fingerprint on a %s record', async (_name, record) => {
    const { coordinator } = setup([record]);

    const failure = await lookup(coordinator, otherFingerprint).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(IdempotencyConflictError);
    expect((failure as Error).message).toBe(
      'This idempotency key was already used for a different request.',
    );
    expect(String(failure)).not.toContain(rejected.key);
    expect(String(failure)).not.toContain(fingerprint);
  });

  it('returns a stored record without assuming it is an HTTP snapshot', async () => {
    const reference = {
      ...completed,
      response: { status: 201, body: { receiptRef: 'r-7731' } },
    };
    const { coordinator } = setup([reference]);
    expect(await lookup(coordinator)).toBe(reference);
  });

  it.each([
    ['an empty actor', '', rejected.key, fingerprint, createdEpoch],
    ['an unsafe actor', 'a b', rejected.key, fingerprint, createdEpoch],
    ['a non-string actor', 7, rejected.key, fingerprint, createdEpoch],
    ['an empty key', 'sub-aisha', '', fingerprint, createdEpoch],
    ['an unsafe key', 'sub-aisha', 'a b', fingerprint, createdEpoch],
    ['a short fingerprint', 'sub-aisha', rejected.key, 'abc', createdEpoch],
    [
      'an upper-case fingerprint',
      'sub-aisha',
      rejected.key,
      'AB'.repeat(32),
      createdEpoch,
    ],
    [
      'a missing fingerprint',
      'sub-aisha',
      rejected.key,
      undefined,
      createdEpoch,
    ],
    ['a negative time', 'sub-aisha', rejected.key, fingerprint, -1],
    ['a fractional time', 'sub-aisha', rejected.key, fingerprint, 1.5],
    ['a non-finite time', 'sub-aisha', rejected.key, fingerprint, Number.NaN],
  ])('rejects %s before any call', async (_name, actor, key, print, now) => {
    const { calls, coordinator } = setup([rejected]);

    await expect(
      coordinator.lookup(actor as string, key, print as string, now),
    ).rejects.toBeInstanceOf(Error);
    expect(calls).toEqual([]);
  });

  it('echoes no supplied value in its validation messages', async () => {
    const { coordinator } = setup();
    const failures = await Promise.allSettled([
      coordinator.lookup('Secret Actor', rejected.key, fingerprint, 1),
      coordinator.lookup('sub-aisha', 'Secret Key', fingerprint, 1),
      coordinator.lookup('sub-aisha', rejected.key, 'Secret Print', 1),
    ]);
    for (const failure of failures) {
      expect(failure.status).toBe('rejected');
      expect(String((failure as PromiseRejectedResult).reason)).not.toContain(
        'Secret',
      );
    }
  });

  it('propagates reader errors unchanged', async () => {
    const failure = new Error('ThrottlingException');
    const { calls, coordinator } = setup([failure]);
    await expect(lookup(coordinator)).rejects.toBe(failure);
    expect(calls).toHaveLength(1);
  });
});

describe('recordRejection', () => {
  it('writes once and returns the record when the write succeeds', async () => {
    const { calls, coordinator } = setup();

    expect(await coordinator.recordRejection(rejected, createdEpoch)).toBe(
      rejected,
    );

    expect(calls).toEqual([{ kind: 'record', args: [rejected, createdEpoch] }]);
  });

  it('returns a concurrent rejection with the same fingerprint', async () => {
    const winner: IdempotencyRecord = {
      ...rejected,
      createdAt: rejected.createdAt,
    };
    const { calls, coordinator } = setup([winner], conditionalFailure());

    expect(await coordinator.recordRejection(rejected, createdEpoch)).toBe(
      winner,
    );

    expect(calls.map((call) => call.kind)).toEqual(['record', 'find']);
    expect(calls[1]).toEqual({
      kind: 'find',
      args: ['sub-aisha', rejected.key, createdEpoch],
    });
  });

  it('returns a concurrent success with the same fingerprint', async () => {
    const { calls, coordinator } = setup([completed], conditionalFailure());

    expect(await coordinator.recordRejection(rejected, createdEpoch)).toBe(
      completed,
    );
    expect(calls.map((call) => call.kind)).toEqual(['record', 'find']);
  });

  it.each([
    ['completed', completed],
    ['rejected', rejected],
  ])(
    'conflicts with a concurrent %s record of another fingerprint',
    async (_n, other) => {
      const { calls, coordinator } = setup(
        [{ ...other, fingerprint: otherFingerprint }],
        conditionalFailure(),
      );

      await expect(
        coordinator.recordRejection(rejected, createdEpoch),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
      expect(calls.map((call) => call.kind)).toEqual(['record', 'find']);
    },
  );

  it('rethrows the original conditional failure when no unexpired record is found', async () => {
    const failure = conditionalFailure();
    const { calls, coordinator } = setup([undefined], failure);

    await expect(
      coordinator.recordRejection(rejected, createdEpoch),
    ).rejects.toBe(failure);
    expect(calls.map((call) => call.kind)).toEqual(['record', 'find']);
  });

  it('identifies the conditional failure by its SDK error name, not its message', async () => {
    const byName = Object.assign(new Error('anything at all'), {
      name: 'ConditionalCheckFailedException',
    });
    const byMessage = new Error('ConditionalCheckFailedException');
    const named = setup([completed], byName);
    const messageOnly = setup([completed], byMessage);

    expect(
      await named.coordinator.recordRejection(rejected, createdEpoch),
    ).toBe(completed);
    await expect(
      messageOnly.coordinator.recordRejection(rejected, createdEpoch),
    ).rejects.toBe(byMessage);
    expect(messageOnly.calls.map((call) => call.kind)).toEqual(['record']);
  });

  it('propagates unrelated writer errors unchanged without rereading', async () => {
    const failure = Object.assign(new Error('Throttled'), {
      name: 'ProvisionedThroughputExceededException',
    });
    const { calls, coordinator } = setup([completed], failure);

    await expect(
      coordinator.recordRejection(rejected, createdEpoch),
    ).rejects.toBe(failure);
    expect(calls.map((call) => call.kind)).toEqual(['record']);
  });

  it('propagates non-error rejections unchanged', async () => {
    const { calls, coordinator } = setup([], 'boom' as unknown as Error);
    await expect(
      coordinator.recordRejection(rejected, createdEpoch),
    ).rejects.toBe('boom');
    expect(calls).toHaveLength(1);
  });

  it('propagates a reread error unchanged', async () => {
    const failure = new Error('ThrottlingException');
    const { calls, coordinator } = setup([failure], conditionalFailure());

    await expect(
      coordinator.recordRejection(rejected, createdEpoch),
    ).rejects.toBe(failure);
    expect(calls.map((call) => call.kind)).toEqual(['record', 'find']);
  });

  it('rereads at most once', async () => {
    const { calls, coordinator } = setup(
      [undefined, completed],
      conditionalFailure(),
    );
    await expect(
      coordinator.recordRejection(rejected, createdEpoch),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
    expect(calls.filter((call) => call.kind === 'find')).toHaveLength(1);
  });

  it.each([
    ['a missing record', undefined, createdEpoch],
    ['a completed record', completed, createdEpoch],
    [
      'a record with a short fingerprint',
      { ...rejected, fingerprint: 'ab' },
      createdEpoch,
    ],
    ['a record with an invalid key', { ...rejected, key: '' }, createdEpoch],
    [
      'a record with the wrong TTL',
      { ...rejected, expiresAt: 5 },
      createdEpoch,
    ],
    [
      'a record with a success status',
      { ...rejected, response: { status: 200, body: {} } },
      createdEpoch,
    ],
    ['an already expired record', rejected, rejected.expiresAt + 1],
    ['a negative time', rejected, -1],
    ['a fractional time', rejected, 0.5],
  ])('rejects %s before any call', async (_name, record, now) => {
    const { calls, coordinator } = setup([completed]);

    await expect(
      coordinator.recordRejection(
        record as unknown as RejectedIdempotencyRecord,
        now,
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(calls).toEqual([]);
  });

  it('accepts a record expiring exactly now', async () => {
    const { calls, coordinator } = setup();
    await coordinator.recordRejection(rejected, rejected.expiresAt);
    expect(calls).toHaveLength(1);
  });

  it('echoes no supplied value in its validation messages', async () => {
    const { coordinator } = setup();
    const secret = 'Secret Fingerprint';
    const failures = await Promise.allSettled([
      coordinator.recordRejection(
        { ...rejected, fingerprint: secret },
        createdEpoch,
      ),
      coordinator.recordRejection(
        { ...rejected, actorId: secret },
        createdEpoch,
      ),
      coordinator.recordRejection(
        { ...rejected, outcome: secret as never },
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

describe('result references', () => {
  const reference: IdempotencyRecord = {
    ...completed,
    key: 'upload-key-0001',
    response: { status: 201, resultRef: { receiptId: 'r-7731' } },
  };

  it('returns a stored reference intact from a lookup', async () => {
    const { coordinator } = setup([reference]);

    const found = await coordinator.lookup(
      'sub-aisha',
      reference.key,
      fingerprint,
      createdEpoch,
    );

    expect(found).toBe(reference);
    expect(found?.response).toEqual({
      status: 201,
      resultRef: { receiptId: 'r-7731' },
    });
  });

  it('conflicts on another fingerprint without exposing the reference', async () => {
    const { coordinator } = setup([reference]);

    const failure = await coordinator
      .lookup('sub-aisha', reference.key, otherFingerprint, createdEpoch)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(IdempotencyConflictError);
    expect(String(failure)).not.toContain('r-7731');
  });

  it('returns a concurrent upload winner intact after a lost rejection race', async () => {
    const { calls, coordinator } = setup([reference], conditionalFailure());

    const result = await coordinator.recordRejection(
      { ...rejected, key: reference.key },
      createdEpoch,
    );

    expect(result).toBe(reference);
    expect(calls.map((call) => call.kind)).toEqual(['record', 'find']);
  });

  it('does not accept a reference as the rejection to store', async () => {
    const { calls, coordinator } = setup();

    await expect(
      coordinator.recordRejection(
        {
          ...rejected,
          response: { status: 201, resultRef: { receiptId: 'r-7731' } },
        } as unknown as RejectedIdempotencyRecord,
        createdEpoch,
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(calls).toEqual([]);
  });
});
