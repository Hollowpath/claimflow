import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  canonicalJson,
  transactionRequestToken,
  transactionTokenLength,
  UnsupportedCanonicalValueError,
  type TransactionTokenInput,
} from '../src/adapters/aws/transaction-token.js';

/** A representative claim-submission transaction, without its token. */
function submitTransaction(
  overrides: {
    categoryVersion?: number;
    occurredAt?: string;
    eventId?: string;
    claimId?: string;
  } = {},
) {
  const {
    categoryVersion = 3,
    occurredAt = '2026-10-14T10:41:00.000Z',
    eventId = '8f3d2c1e-5a7b-4c1d-9e2f-0a1b2c3d4e5f',
    claimId = '4ce0c74b-9c64-46d6-87ba-07fb71b0628c',
  } = overrides;
  return {
    TransactItems: [
      {
        Update: {
          TableName: 'ClaimFlow',
          Key: { PK: `CLAIM#${claimId}`, SK: 'CLAIM' },
          UpdateExpression: 'SET #status = :submitted, version = :next',
          ConditionExpression: 'version = :expected',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':submitted': 'SUBMITTED',
            ':next': 4,
            ':expected': 3,
          },
        },
      },
      {
        ConditionCheck: {
          TableName: 'ClaimFlow',
          Key: { PK: 'CATEGORIES', SK: 'CATEGORY#travel' },
          ConditionExpression: 'version = :read AND active = :true',
          ExpressionAttributeValues: {
            ':read': categoryVersion,
            ':true': true,
          },
        },
      },
      {
        Put: {
          TableName: 'ClaimFlow',
          Item: {
            PK: `CLAIM#${claimId}`,
            SK: `OUTBOX#${occurredAt}#${eventId}`,
            eventId,
            eventType: 'claim.submitted',
            occurredAt,
            aggregate: { type: 'claim', id: claimId, version: 4 },
          },
        },
      },
      {
        Put: {
          TableName: 'ClaimFlow',
          Item: {
            PK: 'IDEMPOTENCY#sub-aisha#5b0d6a8e-retry-key',
            SK: 'IDEMPOTENCY',
            response: { status: 200, body: { claimId, version: 4 } },
            expiresAt: 1_792_406_460,
          },
          ConditionExpression: 'attribute_not_exists(PK) OR expiresAt < :now',
          ExpressionAttributeValues: { ':now': 1_792_320_060 },
        },
      },
    ],
  };
}

const base: TransactionTokenInput = {
  actorId: 'sub-aisha',
  idempotencyKey: '5b0d6a8e-retry-key',
  fingerprint: 'f'.repeat(64),
  transaction: submitTransaction(),
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('canonicalJson', () => {
  it('sorts object keys at every nesting level', () => {
    const value = {
      b: { z: 1, a: { y: true, b: null } },
      a: [{ d: 'x', c: 'y' }],
    };

    expect(canonicalJson(value)).toBe(
      '{"a":[{"c":"y","d":"x"}],"b":{"a":{"b":null,"y":true},"z":1}}',
    );
  });

  it('produces the same text whatever order keys were inserted in', () => {
    const one = { outer: { first: 1, second: [1, 2], third: { x: 1, y: 2 } } };
    const two = { outer: { third: { y: 2, x: 1 }, second: [1, 2], first: 1 } };

    expect(canonicalJson(one)).toBe(canonicalJson(two));
  });

  it('keeps array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson([{ b: 1 }, { a: 1 }])).toBe('[{"b":1},{"a":1}]');
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('serializes strings, numbers, booleans, null, and null-prototype objects as JSON', () => {
    const bare = Object.assign(Object.create(null) as object, { k: 'v' });

    expect(canonicalJson({ s: 'a"é', n: -1.5, t: true, z: null })).toBe(
      '{"n":-1.5,"s":"a\\"é","t":true,"z":null}',
    );
    expect(canonicalJson(bare)).toBe('{"k":"v"}');
  });

  it('accepts a value referenced twice without a cycle', () => {
    const shared = { a: 1 };

    expect(canonicalJson({ x: shared, y: [shared] })).toBe(
      '{"x":{"a":1},"y":[{"a":1}]}',
    );
  });

  const cyclicObject: Record<string, unknown> = { a: 1 };
  cyclicObject.self = { back: cyclicObject };
  const cyclicArray: unknown[] = [1];
  cyclicArray.push(cyclicArray);
  const sparseArray: unknown[] = [1];
  sparseArray[2] = 3;

  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['an undefined property', { a: undefined }],
    ['an undefined array element', [1, undefined]],
    ['a sparse array', sparseArray],
    ['a function', { f: () => 1 }],
    ['a symbol value', { s: Symbol('x') }],
    ['a symbol key', { [Symbol('x')]: 1 }],
    ['a big integer', { n: 1n }],
    ['NaN', { n: Number.NaN }],
    ['Infinity', { n: Number.POSITIVE_INFINITY }],
    ['-Infinity', [Number.NEGATIVE_INFINITY]],
    ['a Date', { d: new Date(0) }],
    ['a Map', new Map([['a', 1]])],
    ['a Set', { s: new Set(['a']) }],
    ['a Uint8Array', { b: new Uint8Array([1]) }],
    ['a class instance', { c: new (class Point {})() }],
    ['a cyclic object', cyclicObject],
    ['a cyclic array', cyclicArray],
  ])('rejects %s', (_name, value) => {
    expect(() => canonicalJson(value)).toThrow(UnsupportedCanonicalValueError);
  });

  it('names the path of the rejected value', () => {
    expect(() =>
      canonicalJson({ items: [{ ok: 1 }, { bad: Number.NaN }] }),
    ).toThrow('Cannot canonicalize $.items[1].bad: not a finite number.');
  });
});

describe('transactionRequestToken', () => {
  it('is exactly 32 lowercase hexadecimal characters', () => {
    const token = transactionRequestToken(base);

    expect(transactionTokenLength).toBe(32);
    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });

  it('hashes the identity, fingerprint, and the hash of the canonical payload', () => {
    const sha256 = (text: string) =>
      createHash('sha256').update(text, 'utf8').digest('hex');
    const payloadHash = sha256(canonicalJson(base.transaction));
    const expected = sha256(
      JSON.stringify([
        base.actorId,
        base.idempotencyKey,
        base.fingerprint,
        payloadHash,
      ]),
    ).slice(0, 32);

    expect(transactionRequestToken(base)).toBe(expected);
  });

  it('is the same for identical inputs, including rebuilt payloads', () => {
    const rebuilt = {
      ...base,
      transaction: JSON.parse(JSON.stringify(submitTransaction())) as unknown,
    };

    expect(transactionRequestToken(base)).toBe(transactionRequestToken(base));
    expect(transactionRequestToken(rebuilt)).toBe(
      transactionRequestToken(base),
    );
  });

  it('does not depend on key order in the payload', () => {
    const reordered = {
      ...base,
      transaction: reorderKeys(submitTransaction()),
    };

    expect(JSON.stringify(reordered.transaction)).not.toBe(
      JSON.stringify(base.transaction),
    );
    expect(transactionRequestToken(reordered)).toBe(
      transactionRequestToken(base),
    );
  });

  it('does not depend on time or randomness', () => {
    const before = transactionRequestToken(base);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2031-01-01T00:00:00.000Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0.123);

    expect(transactionRequestToken(base)).toBe(before);
  });

  it.each<[string, Partial<TransactionTokenInput>]>([
    ['actor', { actorId: 'sub-ben' }],
    ['idempotency key', { idempotencyKey: '5b0d6a8e-retry-key-2' }],
    ['fingerprint', { fingerprint: 'e'.repeat(64) }],
    [
      'category version',
      { transaction: submitTransaction({ categoryVersion: 4 }) },
    ],
    [
      'timestamp',
      {
        transaction: submitTransaction({
          occurredAt: '2026-10-14T10:41:00.001Z',
        }),
      },
    ],
    [
      'event ID',
      {
        transaction: submitTransaction({
          eventId: '00000000-5a7b-4c1d-9e2f-0a1b2c3d4e5f',
        }),
      },
    ],
    [
      'claim ID',
      {
        transaction: submitTransaction({
          claimId: '00000000-9c64-46d6-87ba-07fb71b0628c',
        }),
      },
    ],
    [
      'transaction item order',
      {
        transaction: {
          TransactItems: [...submitTransaction().TransactItems].reverse(),
        },
      },
    ],
  ])('changes when the %s changes', (_name, change) => {
    expect(transactionRequestToken({ ...base, ...change })).not.toBe(
      transactionRequestToken(base),
    );
  });

  it('keeps the identity fields apart', () => {
    const one = { ...base, actorId: 'sub-a', idempotencyKey: 'bc-key-0001' };
    const two = { ...base, actorId: 'sub-ab', idempotencyKey: 'c-key-0001' };

    expect(transactionRequestToken(one)).not.toBe(transactionRequestToken(two));
  });

  it('rejects unsupported payload values and a payload that includes its token', () => {
    expect(() =>
      transactionRequestToken({ ...base, transaction: { when: new Date() } }),
    ).toThrow(UnsupportedCanonicalValueError);
    expect(() =>
      transactionRequestToken({
        ...base,
        transaction: { ...submitTransaction(), ClientRequestToken: 'x' },
      }),
    ).toThrow('the token cannot be part of its own payload');
  });
});

/** A deep copy with every object's keys inserted in reverse order. */
function reorderKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(reorderKeys);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, inner]) => [key, reorderKeys(inner)]),
    );
  }
  return value;
}
