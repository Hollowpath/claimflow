import { S3Client } from '@aws-sdk/client-s3';
import { maxReceiptSizeBytes, receiptContentTypes } from '@claimflow/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  encodeReceiptItem,
  pendingReceiptExpiresAt,
  type AttachedReceiptRecord,
  type PendingReceiptRecord,
} from '../src/adapters/aws/dynamodb-receipt-items.js';
import { ItemEncodingError } from '../src/adapters/aws/dynamodb-items.js';
import {
  createS3UploadFormSigner,
  hexToBase64,
  S3UploadFormGenerator,
  UploadFormError,
  uploadFormLifetimeSeconds,
  type UploadForm,
  type UploadFormRequest,
  type UploadFormSigner,
} from '../src/adapters/aws/s3-upload-form.js';

const bucket = 'claimflow-receipts-test';
const secretFileName = 'Payslip Aisha Rahman October.pdf';
const checksumHex = '9f2c'.repeat(16);
const uploadedAt = '2026-10-14T10:35:00.000Z';

const pending: PendingReceiptRecord = {
  receiptId: 'r-7731',
  ownerId: 'sub-aisha',
  state: 'PENDING',
  fileName: secretFileName,
  declaredContentType: 'application/pdf',
  declaredSizeBytes: 52_144,
  declaredChecksumSha256: checksumHex,
  uploadedAt,
  expiresAt: pendingReceiptExpiresAt(uploadedAt),
};

const url = 'https://claimflow-receipts-test.s3.ap-southeast-1.amazonaws.com/';

/** Echoes the requested fields with a policy and signature, like a signer. */
function echoSigner(requests: UploadFormRequest[]): UploadFormSigner {
  return (request) => {
    requests.push(request);
    return Promise.resolve({
      url,
      fields: {
        ...request.fields,
        Policy: 'cG9saWN5',
        'X-Amz-Signature': 'abc123',
      },
    });
  };
}

let requests: UploadFormRequest[];
let generator: S3UploadFormGenerator;

beforeEach(() => {
  requests = [];
  generator = new S3UploadFormGenerator({
    bucketName: bucket,
    sign: echoSigner(requests),
  });
});

function errorOf(action: () => Promise<unknown>): Promise<unknown> {
  return action().then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('createForm', () => {
  it('asks the signer for the exact bucket, key, fields, conditions, and expiry', async () => {
    const form = await generator.createForm(pending);

    const expectedChecksum = Buffer.from(checksumHex, 'hex').toString('base64');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      bucket,
      key: 'uploads/pending/r-7731',
      fields: {
        key: 'uploads/pending/r-7731',
        'Content-Type': 'application/pdf',
        'x-amz-checksum-algorithm': 'SHA256',
        'x-amz-checksum-sha256': expectedChecksum,
      },
      conditions: [
        { bucket },
        ['eq', '$key', 'uploads/pending/r-7731'],
        ['eq', '$Content-Type', 'application/pdf'],
        ['content-length-range', 52_144, 52_144],
        ['eq', '$x-amz-checksum-algorithm', 'SHA256'],
        ['eq', '$x-amz-checksum-sha256', expectedChecksum],
      ],
      expiresSeconds: 900,
    });
    expect(uploadFormLifetimeSeconds).toBe(15 * 60);
    expect(form.url).toBe(url);
    expect(form.fields).toMatchObject({
      key: 'uploads/pending/r-7731',
      'Content-Type': 'application/pdf',
      'x-amz-checksum-algorithm': 'SHA256',
      'x-amz-checksum-sha256': expectedChecksum,
      Policy: 'cG9saWN5',
    });
  });

  it('converts hexadecimal checksums to base64', () => {
    expect(hexToBase64('00'.repeat(32))).toBe(`${'A'.repeat(43)}=`);
    expect(hexToBase64('ff'.repeat(32))).toBe(`${'/'.repeat(42)}8=`);
    expect(hexToBase64(checksumHex)).toBe(
      Buffer.from(checksumHex, 'hex').toString('base64'),
    );
    expect(
      Buffer.from(hexToBase64(checksumHex), 'base64').toString('hex'),
    ).toBe(checksumHex);
  });

  it.each(receiptContentTypes)('signs the declared type %s', async (type) => {
    await generator.createForm({ ...pending, declaredContentType: type });

    expect(requests[0]!.fields['Content-Type']).toBe(type);
    expect(requests[0]!.conditions).toContainEqual([
      'eq',
      '$Content-Type',
      type,
    ]);
  });

  it.each([1, maxReceiptSizeBytes])(
    'requires exactly %s bytes',
    async (size) => {
      await generator.createForm({ ...pending, declaredSizeBytes: size });

      expect(requests[0]!.conditions).toContainEqual([
        'content-length-range',
        size,
        size,
      ]);
    },
  );

  it.each([0, maxReceiptSizeBytes + 1])(
    'refuses a declared size of %s through the codec, before signing',
    async (size) => {
      const error = await errorOf(() =>
        generator.createForm({ ...pending, declaredSizeBytes: size }),
      );

      expect(error).toBeInstanceOf(ItemEncodingError);
      expect(requests).toEqual([]);
    },
  );

  it.each<[string, Partial<PendingReceiptRecord>]>([
    ['an invalid checksum', { declaredChecksumSha256: 'ABC' }],
    ['an unsupported type', { declaredContentType: 'image/gif' as never }],
    ['an unsanitized file name', { fileName: '../x.pdf' }],
    ['a wrong TTL', { expiresAt: 1 }],
  ])('refuses %s through the codec, before signing', async (_name, change) => {
    const error = await errorOf(() =>
      generator.createForm({ ...pending, ...change }),
    );

    expect(error).toBeInstanceOf(ItemEncodingError);
    expect(requests).toEqual([]);
  });

  it('refuses a record that is not PENDING, before signing', async () => {
    const attached: AttachedReceiptRecord = {
      receiptId: 'r-7731',
      ownerId: 'sub-aisha',
      state: 'ATTACHED',
      fileName: secretFileName,
      contentType: 'application/pdf',
      sizeBytes: 52_144,
      checksumSha256: checksumHex,
      uploadedAt,
      attachedClaimId: 'claim-1',
    };
    const error = await errorOf(() =>
      generator.createForm(attached as unknown as PendingReceiptRecord),
    );

    expect(error).toBeInstanceOf(UploadFormError);
    expect(String(error)).toContain('only a PENDING receipt');
    expect(requests).toEqual([]);
  });

  it.each(['', undefined as unknown as string])(
    'refuses a missing bucket name (%j) before signing',
    async (bucketName) => {
      const bad = new S3UploadFormGenerator({
        bucketName,
        sign: echoSigner(requests),
      });
      const error = await errorOf(() => bad.createForm(pending));

      expect(error).toBeInstanceOf(UploadFormError);
      expect(String(error)).toContain('bucket name is missing');
      expect(requests).toEqual([]);
    },
  );

  it('invokes the signer exactly once per form', async () => {
    const sign = vi.fn(echoSigner(requests));
    await new S3UploadFormGenerator({ bucketName: bucket, sign }).createForm(
      pending,
    );

    expect(sign).toHaveBeenCalledTimes(1);
  });
});

describe('invalid signer output', () => {
  const generate = (form: unknown) =>
    new S3UploadFormGenerator({
      bucketName: bucket,
      sign: () => Promise.resolve(form as UploadForm),
    }).createForm(pending);
  const signedFields = (change: Record<string, unknown> = {}) => ({
    key: 'uploads/pending/r-7731',
    'Content-Type': 'application/pdf',
    'x-amz-checksum-algorithm': 'SHA256',
    'x-amz-checksum-sha256': hexToBase64(checksumHex),
    Policy: 'cG9saWN5',
    'X-Amz-Signature': 'abc123',
    ...change,
  });

  it.each<[string, unknown]>([
    ['nothing', undefined],
    ['no URL', { fields: signedFields() }],
    ['an insecure URL', { url: 'http://example.com/', fields: signedFields() }],
    ['no fields', { url }],
    ['a list of fields', { url, fields: [] }],
    ['a non-string field', { url, fields: signedFields({ extra: 1 }) }],
    [
      'a changed key',
      { url, fields: signedFields({ key: 'uploads/pending/other' }) },
    ],
    [
      'a changed type',
      { url, fields: signedFields({ 'Content-Type': 'image/png' }) },
    ],
    [
      'a changed checksum',
      { url, fields: signedFields({ 'x-amz-checksum-sha256': 'AAAA' }) },
    ],
    [
      'a missing checksum',
      { url, fields: signedFields({ 'x-amz-checksum-sha256': undefined }) },
    ],
    ['no policy', { url, fields: signedFields({ Policy: undefined }) }],
    ['no signature', { url, fields: signedFields({ 'X-Amz-Signature': '' }) }],
  ])('rejects %s', async (_name, form) => {
    const error = await errorOf(() => generate(form));

    expect(error).toBeInstanceOf(UploadFormError);
  });

  it('accepts a valid form', async () => {
    await expect(
      generate({ url, fields: signedFields() }),
    ).resolves.toMatchObject({ url });
  });
});

describe('safety', () => {
  it('keeps file names and checksums out of keys and errors', async () => {
    await generator.createForm(pending);
    const request = requests[0]!;

    expect(request.key).not.toContain('Payslip');
    expect(JSON.stringify(request.conditions)).not.toContain('Payslip');
    expect(Object.values(request.fields).join('|')).not.toContain('Payslip');

    const errors = [
      await errorOf(() =>
        new S3UploadFormGenerator({
          bucketName: '',
          sign: echoSigner([]),
        }).createForm(pending),
      ),
      await errorOf(() =>
        new S3UploadFormGenerator({
          bucketName: bucket,
          sign: () =>
            Promise.resolve({ url: 'http://x', fields: { key: checksumHex } }),
        }).createForm(pending),
      ),
      await errorOf(() =>
        generator.createForm({ ...pending, fileName: `/${secretFileName}` }),
      ),
      await errorOf(() =>
        generator.createForm({
          ...pending,
          declaredChecksumSha256: checksumHex.toUpperCase(),
        }),
      ),
    ];
    for (const error of errors) {
      expect(error).toBeDefined();
      expect(String(error)).not.toContain('Payslip');
      expect(String(error)).not.toContain(checksumHex);
      expect(String(error)).not.toContain(checksumHex.toUpperCase());
      expect(String(error)).not.toContain(hexToBase64(checksumHex));
    }
  });
});

describe('createS3UploadFormSigner', () => {
  it('signs locally with the real SDK, without any network call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const client = new S3Client({
      region: 'ap-southeast-1',
      credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' },
    });
    const form = await new S3UploadFormGenerator({
      bucketName: bucket,
      sign: createS3UploadFormSigner(client),
    }).createForm(pending);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(form.url).toContain(bucket);
    const policy = JSON.parse(
      Buffer.from(form.fields.Policy!, 'base64').toString('utf8'),
    ) as { expiration: string; conditions: unknown[] };
    const lifetime = Date.parse(policy.expiration) - Date.now();
    expect(lifetime).toBeGreaterThan(14 * 60_000);
    expect(lifetime).toBeLessThanOrEqual(15 * 60_000);
    const checksum = hexToBase64(checksumHex);
    expect(policy.conditions).toEqual(
      expect.arrayContaining([
        { bucket },
        ['eq', '$key', 'uploads/pending/r-7731'],
        ['eq', '$Content-Type', 'application/pdf'],
        ['content-length-range', 52_144, 52_144],
        ['eq', '$x-amz-checksum-algorithm', 'SHA256'],
        ['eq', '$x-amz-checksum-sha256', checksum],
      ]),
    );
    expect(form.fields['x-amz-checksum-sha256']).toBe(checksum);
    expect(form.fields.key).toBe('uploads/pending/r-7731');
  });
});

it('creates no S3 command, so nothing is uploaded', () => {
  expect(encodeReceiptItem(pending)).toBeDefined();
  expect(Object.keys(generator)).not.toContain('client');
});
