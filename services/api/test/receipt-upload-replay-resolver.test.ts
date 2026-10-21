import { describe, expect, it } from 'vitest';

import type { IdempotencyRecord } from '../src/adapters/aws/dynamodb-idempotency-items.js';
import { ItemIntegrityError } from '../src/adapters/aws/dynamodb-items.js';
import {
  pendingReceiptExpiresAt,
  retiredReceiptExpiresAt,
  type PendingReceiptRecord,
  type ReceiptRecord,
} from '../src/adapters/aws/dynamodb-receipt-items.js';
import {
  ReceiptUploadReplayResolver,
  type ReceiptMetadataFinder,
  type UploadFormCreator,
} from '../src/adapters/aws/receipt-upload-replay-resolver.js';
import {
  S3UploadFormGenerator,
  type UploadForm,
  type UploadFormRequest,
} from '../src/adapters/aws/s3-upload-form.js';
import { ValidationError } from '../src/application/errors.js';

const uploadedAt = '2026-10-14T10:35:00.000Z';
const secretFileName = 'Payslip Aisha Rahman October.pdf';

const pending: PendingReceiptRecord = {
  receiptId: 'r-7731',
  ownerId: 'sub-aisha',
  state: 'PENDING',
  fileName: secretFileName,
  declaredContentType: 'application/pdf',
  declaredSizeBytes: 52_144,
  declaredChecksumSha256: 'a1b2'.repeat(16),
  uploadedAt,
  expiresAt: pendingReceiptExpiresAt(uploadedAt),
};

const record: IdempotencyRecord = {
  actorId: 'sub-aisha',
  key: 'upload-key-0001',
  fingerprint: 'ef'.repeat(32),
  outcome: 'COMPLETED',
  response: { status: 201, resultRef: { receiptId: 'r-7731' } },
  createdAt: uploadedAt,
  expiresAt: 1_792_060_500,
};

/** Inside both the record's and the receipt's lifetime. */
const now = pending.expiresAt - 60;

const form = (n: number): UploadForm => ({
  url: 'https://claimflow-receipts-test.s3.ap-southeast-1.amazonaws.com/',
  fields: { Policy: `policy-${n}`, 'X-Amz-Signature': `signature-${n}` },
});

type Event =
  | { readonly kind: 'get'; readonly args: unknown[] }
  | { readonly kind: 'createForm'; readonly args: unknown[] };

function setup(
  metadata: (ReceiptRecord | undefined | Error)[] = [pending],
  formFailure?: Error,
) {
  const events: Event[] = [];
  let issued = 0;
  const receipts: ReceiptMetadataFinder = {
    get: (...args) => {
      events.push({ kind: 'get', args });
      const next = metadata.shift();
      return next instanceof Error
        ? Promise.reject(next)
        : Promise.resolve(next);
    },
  };
  const forms: UploadFormCreator = {
    createForm: (...args) => {
      events.push({ kind: 'createForm', args });
      issued += 1;
      return formFailure === undefined
        ? Promise.resolve(form(issued))
        : Promise.reject(formFailure);
    },
  };
  return {
    events,
    resolver: new ReceiptUploadReplayResolver({ receipts, forms }),
  };
}

const unavailable = (failure: unknown) => {
  expect(failure).toBeInstanceOf(ValidationError);
  expect(failure).toMatchObject({
    code: 'VALIDATION_FAILED',
    details: [
      expect.objectContaining({
        field: 'receiptId',
        code: 'RECEIPT_UNAVAILABLE',
      }),
    ],
  });
  expect(String((failure as Error).message)).not.toContain('r-7731');
  expect(JSON.stringify(failure)).not.toContain('Payslip');
};

describe('construction', () => {
  it.each([undefined, null, {}, { get: 'get' }])(
    'rejects the metadata reader %j',
    (receipts) => {
      expect(
        () =>
          new ReceiptUploadReplayResolver({
            receipts: receipts as unknown as ReceiptMetadataFinder,
            forms: { createForm: () => Promise.resolve(form(1)) },
          }),
      ).toThrow(new TypeError('The receipt metadata reader is missing.'));
    },
  );

  it.each([undefined, null, {}, { createForm: 1 }])(
    'rejects the form generator %j',
    (forms) => {
      expect(
        () =>
          new ReceiptUploadReplayResolver({
            receipts: { get: () => Promise.resolve(undefined) },
            forms: forms as unknown as UploadFormCreator,
          }),
      ).toThrow(new TypeError('The upload form generator is missing.'));
    },
  );

  it('exposes only resolve', () => {
    expect(
      Object.getOwnPropertyNames(ReceiptUploadReplayResolver.prototype),
    ).toEqual(['constructor', 'resolve']);
  });
});

describe('resolve', () => {
  it('reads the receipt once, then creates one form for that same record', async () => {
    const { events, resolver } = setup();

    const replay = await resolver.resolve(record, now);

    expect(replay).toEqual({ receiptId: 'r-7731', form: form(1) });
    expect(events).toEqual([
      { kind: 'get', args: ['r-7731'] },
      { kind: 'createForm', args: [pending] },
    ]);
    expect(events[1]!.args[0]).toBe(pending);
  });

  it('issues a fresh form for each replay of the same receipt', async () => {
    const { events, resolver } = setup([pending, pending]);

    const first = await resolver.resolve(record, now);
    const second = await resolver.resolve(record, now);

    expect(first.receiptId).toBe(second.receiptId);
    expect(first.form).not.toEqual(second.form);
    expect(events.map((event) => event.kind)).toEqual([
      'get',
      'createForm',
      'get',
      'createForm',
    ]);
  });

  it('preserves the original upload conditions in every form', async () => {
    const requests: UploadFormRequest[] = [];
    const generator = new S3UploadFormGenerator({
      bucketName: 'claimflow-receipts-test',
      sign: (request) => {
        requests.push(request);
        return Promise.resolve({
          url: form(1).url,
          fields: {
            ...request.fields,
            Policy: `policy-${requests.length}`,
            'X-Amz-Signature': `signature-${requests.length}`,
          },
        });
      },
    });
    const resolver = new ReceiptUploadReplayResolver({
      receipts: { get: () => Promise.resolve(pending) },
      forms: generator,
    });

    const first = await resolver.resolve(record, now);
    const second = await resolver.resolve(record, now);

    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[0]!.key).toBe('uploads/pending/r-7731');
    expect(requests[0]!.conditions).toContainEqual([
      'content-length-range',
      52_144,
      52_144,
    ]);
    expect(requests[0]!.conditions).toContainEqual([
      'eq',
      '$Content-Type',
      'application/pdf',
    ]);
    expect(first.form.fields.Policy).not.toBe(second.form.fields.Policy);
  });

  describe('expiry boundaries', () => {
    it('accepts a record and a receipt expiring exactly now', async () => {
      expect(record.expiresAt).toBe(pending.expiresAt);
      const { events, resolver } = setup();

      await expect(
        resolver.resolve(record, record.expiresAt),
      ).resolves.toMatchObject({ receiptId: 'r-7731' });
      expect(events).toHaveLength(2);
    });

    it('refuses a receipt that expired one second ago, without a form', async () => {
      const { events, resolver } = setup([{ ...pending, expiresAt: now - 1 }]);

      unavailable(await resolver.resolve(record, now).catch((e: unknown) => e));
      expect(events.map((event) => event.kind)).toEqual(['get']);
    });

    it('refuses a record that expired one second ago before reading anything', async () => {
      const { events, resolver } = setup();

      await expect(
        resolver.resolve(record, record.expiresAt + 1),
      ).rejects.toThrow(new RangeError('The idempotency record has expired.'));
      expect(events).toEqual([]);
    });
  });

  describe('unavailable receipts', () => {
    it('refuses a missing receipt', async () => {
      const { events, resolver } = setup([undefined]);
      unavailable(await resolver.resolve(record, now).catch((e: unknown) => e));
      expect(events.map((event) => event.kind)).toEqual(['get']);
    });

    it.each([
      [
        'an attached receipt',
        {
          receiptId: 'r-7731',
          ownerId: 'sub-aisha',
          state: 'ATTACHED',
          fileName: secretFileName,
          contentType: 'application/pdf',
          sizeBytes: 52_144,
          checksumSha256: 'a1b2'.repeat(16),
          uploadedAt,
          attachedClaimId: 'claim-1',
        },
      ],
      [
        'a replaced receipt',
        {
          receiptId: 'r-7731',
          ownerId: 'sub-aisha',
          state: 'REPLACED',
          fileName: secretFileName,
          contentType: 'application/pdf',
          sizeBytes: 52_144,
          checksumSha256: 'a1b2'.repeat(16),
          uploadedAt,
          attachedClaimId: 'claim-1',
          expiresAt: retiredReceiptExpiresAt('2026-10-15T00:00:00.000Z'),
        },
      ],
      ['a receipt owned by someone else', { ...pending, ownerId: 'sub-ben' }],
    ])('refuses %s without a form', async (_name, receipt) => {
      const { events, resolver } = setup([receipt as ReceiptRecord]);

      unavailable(await resolver.resolve(record, now).catch((e: unknown) => e));
      expect(events.map((event) => event.kind)).toEqual(['get']);
    });
  });

  describe('identity', () => {
    it('refuses a receipt that is not the one referenced, with a fixed message', async () => {
      const { events, resolver } = setup([{ ...pending, receiptId: 'r-9999' }]);

      const failure = await resolver
        .resolve(record, now)
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ItemIntegrityError);
      expect(String(failure)).not.toContain('r-9999');
      expect(String(failure)).not.toContain('r-7731');
      expect(events.map((event) => event.kind)).toEqual(['get']);
    });
  });

  describe('invalid idempotency records', () => {
    const snapshot: IdempotencyRecord = {
      ...record,
      response: { status: 201, body: { receiptId: 'r-7731' } },
    };

    it.each([
      [
        'a response snapshot',
        snapshot,
        new TypeError('The idempotency record is not a receipt upload result.'),
      ],
      [
        'a rejected record',
        {
          ...record,
          outcome: 'REJECTED',
          response: { status: 409, body: { error: {} } },
        },
        new TypeError('The idempotency record is not a receipt upload result.'),
      ],
      [
        'a missing record',
        undefined,
        new TypeError('The idempotency record is missing.'),
      ],
    ])('refuses %s before any call', async (_name, bad, error) => {
      const { events, resolver } = setup();
      await expect(
        resolver.resolve(bad as unknown as IdempotencyRecord, now),
      ).rejects.toThrow(error);
      expect(events).toEqual([]);
    });

    it.each([
      [
        'a body with the reference',
        { status: 201, resultRef: { receiptId: 'r-7731' }, body: {} },
      ],
      [
        'an unknown reference field',
        { status: 201, resultRef: { receiptId: 'r-7731', url: 'x' } },
      ],
      [
        'an invalid receipt ID',
        { status: 201, resultRef: { receiptId: 'a b' } },
      ],
      ['a missing receipt ID', { status: 201, resultRef: {} }],
      [
        'a reference with a 200 status',
        { status: 200, resultRef: { receiptId: 'r-7731' } },
      ],
    ])(
      'refuses %s through the codec before any call',
      async (_name, response) => {
        const { events, resolver } = setup();
        await expect(
          resolver.resolve(
            { ...record, response } as unknown as IdempotencyRecord,
            now,
          ),
        ).rejects.toBeInstanceOf(Error);
        expect(events).toEqual([]);
      },
    );

    it.each([
      ['a malformed fingerprint', { fingerprint: 'short' }],
      ['an invalid key', { key: '' }],
      ['a wrong TTL', { expiresAt: 5 }],
    ])('refuses %s through the codec before any call', async (_name, patch) => {
      const { events, resolver } = setup();
      await expect(
        resolver.resolve({ ...record, ...patch }, now),
      ).rejects.toBeInstanceOf(Error);
      expect(events).toEqual([]);
    });

    it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
      'refuses the time %s before any call',
      async (bad) => {
        const { events, resolver } = setup();
        await expect(resolver.resolve(record, bad)).rejects.toThrow(
          new RangeError('nowEpoch must be whole Unix epoch seconds.'),
        );
        expect(events).toEqual([]);
      },
    );

    it('echoes no supplied value in its messages', async () => {
      const { resolver } = setup();
      const failures = await Promise.allSettled([
        resolver.resolve(
          { ...record, response: { status: 201, body: 'Secret Body' } },
          now,
        ),
        resolver.resolve({ ...record, actorId: 'Secret Actor' }, now),
      ]);
      for (const failure of failures) {
        expect(failure.status).toBe('rejected');
        expect(String((failure as PromiseRejectedResult).reason)).not.toContain(
          'Secret',
        );
      }
    });
  });

  describe('dependency errors', () => {
    it('propagates a metadata error unchanged, without a form', async () => {
      const failure = new Error('ThrottlingException');
      const { events, resolver } = setup([failure]);

      await expect(resolver.resolve(record, now)).rejects.toBe(failure);
      expect(events.map((event) => event.kind)).toEqual(['get']);
    });

    it('propagates a form error unchanged, after one read and one attempt', async () => {
      const failure = new Error('SignerFailure');
      const { events, resolver } = setup([pending], failure);

      await expect(resolver.resolve(record, now)).rejects.toBe(failure);
      expect(events.map((event) => event.kind)).toEqual(['get', 'createForm']);
    });
  });
});
