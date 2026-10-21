import { describe, expect, it } from 'vitest';

import {
  decodeIdempotencyItem,
  encodeIdempotencyItem,
  idempotencyKey,
  maxResponseBodyBytes,
  type IdempotencyRecord,
} from '../src/adapters/aws/dynamodb-idempotency-items.js';
import {
  invalidKeyIdentifier,
  ItemEncodingError,
  ItemIntegrityError,
  type DynamoItem,
} from '../src/adapters/aws/dynamodb-items.js';
import { canonicalJson } from '../src/adapters/aws/transaction-token.js';
import { expiresAfter } from '../src/application/commit.js';
import { idempotencyRetentionMs } from '../src/application/idempotency.js';

const fingerprint = 'ab'.repeat(32);
const claimId = '4ce0c74b-9c64-46d6-87ba-07fb71b0628c';

/** The approved example record (section 7), with a real fingerprint. */
const completed: IdempotencyRecord = {
  actorId: 'sub-aisha',
  key: '5b0d6a8e-retry-key',
  fingerprint,
  outcome: 'COMPLETED',
  response: { status: 200, body: { claimId, version: 4 } },
  createdAt: '2026-10-14T10:41:00.000Z',
  expiresAt: 1_792_060_860,
};

const rejected: IdempotencyRecord = {
  ...completed,
  key: 'retry-key-rejected',
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
};

const noContent: IdempotencyRecord = {
  ...completed,
  key: 'retry-key-delete',
  response: { status: 204, body: undefined },
};

function nested(depth: number): unknown {
  return depth === 0 ? 'leaf' : { next: nested(depth - 1) };
}

function errorOf(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('idempotency items', () => {
  it('encode the approved example item exactly', () => {
    expect(encodeIdempotencyItem(completed)).toEqual({
      PK: 'IDEMPOTENCY#sub-aisha#5b0d6a8e-retry-key',
      SK: 'IDEMPOTENCY',
      entityType: 'IdempotencyRecord',
      fingerprint,
      outcome: 'COMPLETED',
      response: { status: 200, body: { claimId, version: 4 } },
      createdAt: '2026-10-14T10:41:00.000Z',
      expiresAt: 1_792_060_860,
    });
    expect(idempotencyKey('sub-aisha', '5b0d6a8e-retry-key')).toEqual({
      PK: 'IDEMPOTENCY#sub-aisha#5b0d6a8e-retry-key',
      SK: 'IDEMPOTENCY',
    });
  });

  it.each([
    ['a completed 200', completed],
    [
      'a completed 201',
      { ...completed, response: { status: 201, body: { claimId } } },
    ],
    ['a rejected 409', rejected],
    [
      'a rejected 400 with field details',
      {
        ...rejected,
        response: {
          status: 400,
          body: {
            error: {
              code: 'VALIDATION_FAILED',
              message: 'The request is not valid.',
              requestId: 'request-2',
              details: [{ field: 'amount', code: 'INVALID', message: 'x' }],
            },
          },
        },
      },
    ],
  ] as [string, IdempotencyRecord][])('round-trip %s', (_name, record) => {
    expect(decodeIdempotencyItem(encodeIdempotencyItem(record))).toEqual(
      record,
    );
  });

  it('store a 204 response without a body and read it back without one', () => {
    const item = encodeIdempotencyItem(noContent);

    expect(item.response).toEqual({ status: 204 });
    expect(Object.values(item)).not.toContain(undefined);
    const decoded = decodeIdempotencyItem(item);
    expect(decoded.response).toEqual({ status: 204, body: undefined });
    expect(decoded).toEqual(noContent);
  });

  it('store the TTL as whole epoch seconds and no index attributes', () => {
    const item = encodeIdempotencyItem(completed);

    expect(typeof item.expiresAt).toBe('number');
    expect(Number.isInteger(item.expiresAt)).toBe(true);
    expect(Object.keys(item).filter((k) => k.startsWith('GSI'))).toEqual([]);
  });

  it.each<[string, Partial<IdempotencyRecord>]>([
    ['an actor ID with a key separator', { actorId: 'sub#aisha' }],
    ['an idempotency key that is too short', { key: 'short' }],
    ['an idempotency key with a separator', { key: 'retry#key-0001' }],
    ['an upper-case fingerprint', { fingerprint: 'AB'.repeat(32) }],
    ['a short fingerprint', { fingerprint: 'ab'.repeat(31) }],
    ['a non-canonical creation time', { createdAt: '2026-10-14T10:41:00Z' }],
    ['a fractional TTL', { expiresAt: 1_792_060_860.5 }],
    ['a TTL before creation', { expiresAt: 1_791_974_460 }],
    ['a completed 4xx', { response: { status: 400, body: {} } }],
    ['a completed 5xx', { response: { status: 500, body: {} } }],
    [
      'a rejected 2xx',
      { outcome: 'REJECTED', response: { status: 200, body: {} } },
    ],
    ['an out-of-range status', { response: { status: 99, body: {} } }],
    ['a fractional status', { response: { status: 200.5, body: {} } }],
    ['a 204 with a body', { response: { status: 204, body: {} } }],
    ['a 200 without a body', { response: { status: 200, body: undefined } }],
    [
      'a body with an undefined field',
      { response: { status: 200, body: { a: undefined } } },
    ],
    ['a body with a date', { response: { status: 200, body: new Date(0) } }],
    [
      'a body with a non-finite number',
      { response: { status: 200, body: { n: Number.NaN } } },
    ],
    [
      'a body with a set',
      { response: { status: 200, body: { s: new Set(['a']) } } },
    ],
    [
      'a body nested too deeply',
      { response: { status: 200, body: nested(31) } },
    ],
    [
      'a body too large for an item',
      { response: { status: 200, body: { text: 'x'.repeat(310 * 1024) } } },
    ],
  ])('refuse to encode %s', (_name, changes) => {
    expect(() =>
      encodeIdempotencyItem({ ...completed, ...changes } as IdempotencyRecord),
    ).toThrow(ItemEncodingError);
  });

  it('expire exactly 24 hours after creation', () => {
    const exact = expiresAfter(
      new Date(completed.createdAt),
      idempotencyRetentionMs,
    );

    expect(idempotencyRetentionMs).toBe(24 * 60 * 60 * 1000);
    expect(completed.expiresAt).toBe(exact);
    for (const expiresAt of [exact - 1, exact + 1, exact + 3600]) {
      expect(() => encodeIdempotencyItem({ ...completed, expiresAt })).toThrow(
        ItemEncodingError,
      );
      expect(() =>
        decodeIdempotencyItem({
          ...encodeIdempotencyItem(completed),
          expiresAt,
        }),
      ).toThrow('expiresAt must be exactly 24 hours after createdAt');
    }
  });

  describe('body size in UTF-8 bytes', () => {
    /** A body whose canonical JSON has exactly `bytes` UTF-8 bytes. */
    function bodyOfBytes(bytes: number): { text: string } {
      // Two-byte characters, padded with ASCII to the exact size.
      const overhead = Buffer.byteLength(canonicalJson({ text: '' }));
      const twoByte = 100_000;
      const text =
        'é'.repeat(twoByte) + 'a'.repeat(bytes - overhead - 2 * twoByte);
      expect(Buffer.byteLength(canonicalJson({ text }))).toBe(bytes);
      return { text };
    }
    const withBody = (body: unknown): IdempotencyRecord => ({
      ...completed,
      response: { status: 200, body },
    });

    it('accept a body of exactly 300 KB of multibyte text', () => {
      const record = withBody(bodyOfBytes(maxResponseBodyBytes));

      expect(decodeIdempotencyItem(encodeIdempotencyItem(record))).toEqual(
        record,
      );
    });

    it('reject a body one byte over the limit', () => {
      const record = withBody(bodyOfBytes(maxResponseBodyBytes + 1));

      expect(() => encodeIdempotencyItem(record)).toThrow(ItemEncodingError);
      expect(() =>
        decodeIdempotencyItem({
          ...encodeIdempotencyItem(completed),
          response: {
            status: 200,
            body: (record.response as { body?: unknown }).body,
          },
        }),
      ).toThrow('response.body is too large');
    });

    it('count bytes, not characters', () => {
      const text = 'é'.repeat(160_000);
      const record = withBody({ text });

      expect(canonicalJson({ text }).length).toBeLessThan(maxResponseBodyBytes);
      expect(() => encodeIdempotencyItem(record)).toThrow(ItemEncodingError);
    });
  });

  describe('bounded body checks', () => {
    const decodeWith = (body: unknown) => () =>
      decodeIdempotencyItem({
        ...encodeIdempotencyItem(completed),
        response: { status: 200, body },
      });

    /** Nested maps built without recursion, deeper than any stack allows. */
    function deeplyNested(depth: number): unknown {
      let value: unknown = 'leaf';
      for (let i = 0; i < depth; i += 1) {
        value = { next: value };
      }
      return value;
    }

    it.each<[string, () => unknown, string]>([
      ['a very wide list', () => new Array(500_000).fill(0), 'too large'],
      [
        'a very wide map',
        () =>
          Object.fromEntries(
            Array.from({ length: 400_000 }, (_, i) => [`k${i}`, i]),
          ),
        'too large',
      ],
      [
        'a list of many small maps',
        () => Array.from({ length: 200_000 }, () => ({})),
        'too large',
      ],
      ['a very deep map', () => deeplyNested(200_000), 'nested too deeply'],
      [
        'a very deep list',
        () => {
          let value: unknown = 0;
          for (let i = 0; i < 200_000; i += 1) {
            value = [value];
          }
          return value;
        },
        'nested too deeply',
      ],
    ])('reject %s with the item-integrity error', (_name, build, problem) => {
      const decode = decodeWith(build());
      let error: unknown;
      try {
        decode();
      } catch (e) {
        error = e;
      }

      expect(error).toBeInstanceOf(ItemIntegrityError);
      expect(error).not.toBeInstanceOf(RangeError);
      expect(String(error)).toContain(`response.body is ${problem}`);
    });

    it('refuse to encode a cyclic body without overflowing the stack', () => {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;

      expect(() =>
        encodeIdempotencyItem({
          ...completed,
          response: { status: 200, body: cyclic },
        }),
      ).toThrow('response.body is nested too deeply');
    });
  });

  it('accept a body nested exactly to the limit', () => {
    const record = {
      ...completed,
      response: { status: 200, body: nested(30) },
    };

    expect(decodeIdempotencyItem(encodeIdempotencyItem(record))).toEqual(
      record,
    );
  });

  const valid = () => encodeIdempotencyItem(completed);

  it.each<[string, DynamoItem, string]>([
    ['a wrong sort key', { SK: 'IDEMPOTENT' }, 'key'],
    ['a wrong entity type', { entityType: 'Claim' }, 'entityType'],
    [
      'a key that is not an idempotency key',
      { PK: `CLAIM#${claimId}` },
      'idempotency key',
    ],
    [
      'an extra key separator',
      { PK: 'IDEMPOTENCY#sub-aisha#retry-key#extra' },
      'valid actor',
    ],
    [
      'an invalid stored key',
      { PK: 'IDEMPOTENCY#sub-aisha#short' },
      'idempotency key',
    ],
    ['an unknown outcome', { outcome: 'IN_PROGRESS' }, 'outcome'],
    [
      'a fingerprint placeholder',
      { fingerprint: 'sha256-of-method-path-and-body' },
      'fingerprint',
    ],
    [
      'a TTL stored as an ISO string',
      { expiresAt: '2026-10-15T10:41:00.000Z' },
      'expiresAt',
    ],
    ['a missing TTL', { expiresAt: undefined }, 'expiresAt'],
    ['a date-only creation time', { createdAt: '2026-10-14' }, 'createdAt'],
    ['a response that is not a map', { response: 'OK' }, 'response'],
    [
      'a response with extra fields',
      { response: { status: 200, body: {}, headers: {} } },
      'response',
    ],
    [
      'a response status as text',
      { response: { status: '200', body: {} } },
      'response.status',
    ],
    [
      'a response without its body',
      { response: { status: 200 } },
      'response.body is missing',
    ],
    [
      'an index attribute',
      { GSI4PK: 'OUTBOX#PENDING' },
      'must not have GSI4PK',
    ],
    ['an unexpected attribute', { state: 'COMPLETED' }, 'unexpected attribute'],
  ])('reject an item with %s', (_name, changes, problem) => {
    const item: DynamoItem = { ...valid(), ...changes };
    for (const [name, value] of Object.entries(changes)) {
      if (value === undefined) {
        delete item[name];
      }
    }
    const decode = () => decodeIdempotencyItem(item);

    expect(decode).toThrow(ItemIntegrityError);
    expect(decode).toThrow(problem);
  });

  it('never echo malformed keys or stored bodies in errors', () => {
    const secret = 'Salary review for Aisha Rahman';
    const badKey = errorOf(() =>
      decodeIdempotencyItem({
        ...valid(),
        PK: `IDEMPOTENCY#${secret}#key-0001`,
      }),
    );
    const badBody = errorOf(() =>
      decodeIdempotencyItem({
        ...valid(),
        response: { status: 200, body: { note: secret, at: new Date(0) } },
      }),
    );

    for (const error of [badKey, badBody]) {
      expect(error).toBeInstanceOf(ItemIntegrityError);
      expect(String(error)).not.toContain(secret);
    }
    expect(String(badKey)).toContain(invalidKeyIdentifier);
    expect(String(badBody)).toContain(
      'IDEMPOTENCY#sub-aisha#5b0d6a8e-retry-key / IDEMPOTENCY',
    );
  });
});

describe('result references', () => {
  const reference: IdempotencyRecord = {
    ...completed,
    key: 'retry-key-upload',
    response: { status: 201, resultRef: { receiptId: 'r-7731' } },
  };
  const referenceItem = () => encodeIdempotencyItem(reference);
  const withResponse = (response: unknown): IdempotencyRecord =>
    ({ ...reference, response }) as IdempotencyRecord;
  const itemWithResponse = (response: unknown): DynamoItem => ({
    ...referenceItem(),
    response,
  });

  it('encodes exactly a status and a receipt reference, with no body', () => {
    const item = referenceItem();

    expect(item.response).toEqual({
      status: 201,
      resultRef: { receiptId: 'r-7731' },
    });
    expect(item.response).not.toHaveProperty('body');
    expect(Object.keys(item).sort()).toEqual(
      Object.keys(encodeIdempotencyItem(completed)).sort(),
    );
    expect(item).toMatchObject({
      outcome: 'COMPLETED',
      entityType: 'IdempotencyRecord',
    });
  });

  it('round-trips without gaining or losing a field', () => {
    const decoded = decodeIdempotencyItem(referenceItem());

    expect(decoded).toEqual(reference);
    expect(decoded.response).toEqual({
      status: 201,
      resultRef: { receiptId: 'r-7731' },
    });
    expect(decoded.response).not.toHaveProperty('body');
    expect(Object.keys(decoded.response)).toEqual(['status', 'resultRef']);
  });

  it('stores a reference that holds no upload URL or form field', () => {
    const serialized = JSON.stringify(referenceItem());
    for (const word of ['url', 'fields', 'policy', 'signature', 'https']) {
      expect(serialized.toLowerCase()).not.toContain(word);
    }
  });

  it('leaves snapshots, 204 results, and rejected snapshots unchanged', () => {
    for (const record of [completed, noContent, rejected]) {
      const decoded = decodeIdempotencyItem(encodeIdempotencyItem(record));
      expect(decoded).toEqual(record);
      expect(decoded.response).not.toHaveProperty('resultRef');
    }
    expect(encodeIdempotencyItem(noContent).response).toEqual({ status: 204 });
  });

  it.each([
    [
      'a body together with a reference',
      withResponse({
        status: 201,
        resultRef: { receiptId: 'r-7731' },
        body: { a: 1 },
      }),
    ],
    [
      'an unknown reference field',
      withResponse({
        status: 201,
        resultRef: { receiptId: 'r-7731', url: 'x' },
      }),
    ],
    [
      'a reference without a receipt ID',
      withResponse({ status: 201, resultRef: {} }),
    ],
    [
      'an empty receipt ID',
      withResponse({ status: 201, resultRef: { receiptId: '' } }),
    ],
    [
      'an unsafe receipt ID',
      withResponse({ status: 201, resultRef: { receiptId: 'a b' } }),
    ],
    [
      'a numeric receipt ID',
      withResponse({ status: 201, resultRef: { receiptId: 7 } }),
    ],
    [
      'an oversized receipt ID',
      withResponse({ status: 201, resultRef: { receiptId: 'r'.repeat(200) } }),
    ],
    [
      'a reference that is not a map',
      withResponse({ status: 201, resultRef: 'r-7731' }),
    ],
    ['a list reference', withResponse({ status: 201, resultRef: ['r-7731'] })],
    [
      'a 200 status',
      withResponse({ status: 200, resultRef: { receiptId: 'r-7731' } }),
    ],
    [
      'a 202 status',
      withResponse({ status: 202, resultRef: { receiptId: 'r-7731' } }),
    ],
    [
      'a 204 status',
      withResponse({ status: 204, resultRef: { receiptId: 'r-7731' } }),
    ],
    [
      'a rejected record',
      {
        ...reference,
        outcome: 'REJECTED',
        response: { status: 201, resultRef: { receiptId: 'r-7731' } },
      } as unknown as IdempotencyRecord,
    ],
    [
      'a rejected 409 reference',
      {
        ...reference,
        outcome: 'REJECTED',
        response: { status: 409, resultRef: { receiptId: 'r-7731' } },
      } as unknown as IdempotencyRecord,
    ],
  ])('refuses to encode %s', (_name, record) => {
    expect(() => encodeIdempotencyItem(record)).toThrow(ItemEncodingError);
  });

  it.each([
    [
      'a body together with a reference',
      { status: 201, resultRef: { receiptId: 'r-7731' }, body: { a: 1 } },
      'response.body must be absent with response.resultRef',
    ],
    [
      'an unknown reference field',
      { status: 201, resultRef: { receiptId: 'r-7731', url: 'x' } },
      'response.resultRef has an unexpected field',
    ],
    [
      'a reference without a receipt ID',
      { status: 201, resultRef: {} },
      'response.resultRef.receiptId must be a string',
    ],
    [
      'an invalid receipt ID',
      { status: 201, resultRef: { receiptId: 'a b' } },
      'response.resultRef.receiptId is not valid',
    ],
    [
      'a reference that is not a map',
      { status: 201, resultRef: 'r-7731' },
      'response.resultRef must be a map',
    ],
    [
      'a 200 status',
      { status: 200, resultRef: { receiptId: 'r-7731' } },
      'response.resultRef is only valid for a COMPLETED 201 result',
    ],
    [
      'a 204 status',
      { status: 204, resultRef: { receiptId: 'r-7731' } },
      'response.resultRef is only valid for a COMPLETED 201 result',
    ],
  ])(
    'refuses to decode %s with a fixed message',
    (_name, response, message) => {
      expect(() => decodeIdempotencyItem(itemWithResponse(response))).toThrow(
        ItemIntegrityError,
      );
      expect(() => decodeIdempotencyItem(itemWithResponse(response))).toThrow(
        message,
      );
    },
  );

  it('refuses to decode a rejected record that holds a reference', () => {
    for (const status of [201, 409]) {
      const item = {
        ...encodeIdempotencyItem(rejected),
        response: { status, resultRef: { receiptId: 'r-7731' } },
      };
      expect(() => decodeIdempotencyItem(item)).toThrow(ItemIntegrityError);
      expect(() => decodeIdempotencyItem(item)).toThrow(
        'response.resultRef is only valid for a COMPLETED 201 result',
      );
    }
  });

  it('names no stored or supplied value in a message', () => {
    const secret = 'Secret Receipt';
    const failures = [
      errorOf(() =>
        decodeIdempotencyItem(
          itemWithResponse({ status: 201, resultRef: { receiptId: secret } }),
        ),
      ),
      errorOf(() =>
        decodeIdempotencyItem(
          itemWithResponse({
            status: 201,
            resultRef: { receiptId: 'r-7731', [secret]: 1 },
          }),
        ),
      ),
      errorOf(() =>
        encodeIdempotencyItem(
          withResponse({ status: 201, resultRef: { receiptId: secret } }),
        ),
      ),
    ];
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toContain('Secret');
    }
  });
});
