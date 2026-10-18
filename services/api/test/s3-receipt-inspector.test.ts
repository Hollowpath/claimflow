/* eslint-disable @typescript-eslint/prefer-promise-reject-errors -- the fake rejects with scripted values, which may not be Errors */
import {
  GetObjectCommand,
  HeadObjectCommand,
  type GetObjectCommandOutput,
  type HeadObjectCommandOutput,
  type S3Client,
} from '@aws-sdk/client-s3';
import { maxReceiptSizeBytes, receiptContentTypes } from '@claimflow/domain';
import { beforeEach, describe, expect, expectTypeOf, it } from 'vitest';

import { ItemEncodingError } from '../src/adapters/aws/dynamodb-items.js';
import {
  pendingReceiptExpiresAt,
  type AttachedReceiptRecord,
  type PendingReceiptRecord,
} from '../src/adapters/aws/dynamodb-receipt-items.js';
import {
  ReceiptUnavailableError,
  S3ReceiptInspector,
  signatureRange,
  type InspectionS3Client,
} from '../src/adapters/aws/s3-receipt-inspector.js';
import { hexToBase64 } from '../src/adapters/aws/s3-upload-form.js';

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

const signatures = {
  'application/pdf': [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37],
  'image/jpeg': [0xff, 0xd8, 0xff, 0xe0, 0, 0x10],
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0],
} as const;

const body = (bytes: readonly number[]) => ({
  transformToByteArray: () => Promise.resolve(new Uint8Array(bytes)),
});

/** A scripted S3: answers HeadObject and GetObject, or fails as set. */
class FakeS3 implements InspectionS3Client {
  public readonly commands: (HeadObjectCommand | GetObjectCommand)[] = [];
  public head: Partial<HeadObjectCommandOutput> = {};
  public get: Partial<GetObjectCommandOutput> = {};
  public headFailure: unknown;
  public getFailure: unknown;
  public bodyReads = 0;

  public constructor(record: PendingReceiptRecord = pending) {
    this.head = {
      ContentLength: record.declaredSizeBytes,
      ContentType: record.declaredContentType,
      ChecksumSHA256: hexToBase64(record.declaredChecksumSha256),
    };
    this.setSignature(signatures[record.declaredContentType]);
  }

  public setSignature(bytes: readonly number[]): void {
    const content = body(bytes);
    this.get = {
      ContentLength: bytes.length,
      Body: {
        ...content,
        transformToByteArray: () => {
          this.bodyReads += 1;
          return content.transformToByteArray();
        },
      } as never,
    };
  }

  public send(command: HeadObjectCommand): Promise<HeadObjectCommandOutput>;
  public send(command: GetObjectCommand): Promise<GetObjectCommandOutput>;
  public send(
    command: HeadObjectCommand | GetObjectCommand,
  ): Promise<HeadObjectCommandOutput | GetObjectCommandOutput> {
    this.commands.push(command);
    if (command instanceof HeadObjectCommand) {
      return this.headFailure === undefined
        ? Promise.resolve({ $metadata: {}, ...this.head })
        : Promise.reject(this.headFailure);
    }
    return this.getFailure === undefined
      ? Promise.resolve({
          $metadata: {},
          ...this.get,
        })
      : Promise.reject(this.getFailure);
  }
}

let s3: FakeS3;
let inspector: S3ReceiptInspector;

beforeEach(() => {
  s3 = new FakeS3();
  inspector = new S3ReceiptInspector({ client: s3, bucketName: bucket });
});

async function errorOf(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  return undefined;
}

it('accepts the real S3 client', () => {
  expectTypeOf<S3Client>().toExtend<InspectionS3Client>();
});

describe('inspect', () => {
  it('sends HeadObject with checksum mode, then one ranged GetObject', async () => {
    await inspector.inspect(pending);

    expect(s3.commands).toHaveLength(2);
    expect(s3.commands[0]).toBeInstanceOf(HeadObjectCommand);
    expect(s3.commands[0]!.input).toEqual({
      Bucket: bucket,
      Key: 'uploads/pending/r-7731',
      ChecksumMode: 'ENABLED',
    });
    expect(s3.commands[1]).toBeInstanceOf(GetObjectCommand);
    expect(s3.commands[1]!.input).toEqual({
      Bucket: bucket,
      Key: 'uploads/pending/r-7731',
      Range: 'bytes=0-15',
    });
    expect(signatureRange).toBe('bytes=0-15');
    expect(s3.bodyReads).toBe(1);
  });

  it('returns the measured upload, keeping the metadata identity', async () => {
    expect(await inspector.inspect(pending)).toEqual({
      receiptId: 'r-7731',
      ownerId: 'sub-aisha',
      fileName: secretFileName,
      contentType: 'application/pdf',
      sizeBytes: 52_144,
      checksumSha256: checksumHex,
      uploadedAt,
    });
  });

  it.each(receiptContentTypes)('verifies a real %s signature', async (type) => {
    const record = { ...pending, declaredContentType: type };
    s3 = new FakeS3(record);
    inspector = new S3ReceiptInspector({ client: s3, bucketName: bucket });

    expect((await inspector.inspect(record)).contentType).toBe(type);
  });

  it.each([1, maxReceiptSizeBytes])(
    'accepts a size of %s bytes',
    async (size) => {
      const record = { ...pending, declaredSizeBytes: size };
      s3 = new FakeS3(record);
      inspector = new S3ReceiptInspector({ client: s3, bucketName: bucket });

      expect((await inspector.inspect(record)).sizeBytes).toBe(size);
    },
  );
});

describe('metadata mismatches', () => {
  it.each<[string, Partial<HeadObjectCommandOutput>]>([
    ['a different size', { ContentLength: 52_145 }],
    ['a missing size', { ContentLength: undefined }],
    ['a different type', { ContentType: 'image/png' }],
    ['a type with parameters', { ContentType: 'application/pdf; charset=x' }],
    ['a missing type', { ContentType: undefined }],
    ['a different checksum', { ChecksumSHA256: hexToBase64('00'.repeat(32)) }],
    ['a missing checksum', { ChecksumSHA256: undefined }],
    ['a malformed checksum', { ChecksumSHA256: 'not-base64' }],
    [
      'a multipart checksum',
      { ChecksumSHA256: `${hexToBase64(checksumHex)}-3` },
    ],
  ])('rejects %s without reading the body', async (_name, change) => {
    s3.head = { ...s3.head, ...change };

    expect(await errorOf(() => inspector.inspect(pending))).toBeInstanceOf(
      ReceiptUnavailableError,
    );
    expect(s3.commands).toHaveLength(1);
    expect(s3.bodyReads).toBe(0);
  });
});

describe('file signatures', () => {
  it.each<[string, readonly number[]]>([
    ['an unknown signature', [0x00, 0x01, 0x02, 0x03, 0x04, 0x05]],
    ['a truncated PDF signature', [0x25, 0x50, 0x44, 0x46]],
    ['a truncated PNG signature', [0x89, 0x50, 0x4e, 0x47]],
    ['a JPEG signature declared as PDF', [...signatures['image/jpeg']]],
    ['a PNG signature declared as PDF', [...signatures['image/png']]],
  ])('rejects %s', async (_name, bytes) => {
    s3.setSignature(bytes);

    expect(await errorOf(() => inspector.inspect(pending))).toBeInstanceOf(
      ReceiptUnavailableError,
    );
    expect(s3.commands).toHaveLength(2);
  });

  it('rejects a PDF declared as an image', async () => {
    const record = { ...pending, declaredContentType: 'image/png' as const };
    s3 = new FakeS3(record);
    s3.setSignature([...signatures['application/pdf']]);
    inspector = new S3ReceiptInspector({ client: s3, bucketName: bucket });

    expect(await errorOf(() => inspector.inspect(record))).toBeInstanceOf(
      ReceiptUnavailableError,
    );
  });

  it.each<[string, Record<string, unknown>]>([
    ['no body', { Body: undefined }],
    ['an unusable body', { Body: {} }],
    ['no length', { ContentLength: undefined }],
    ['an empty range', { ContentLength: 0 }],
    ['a whole object instead of the range', { ContentLength: 52_144 }],
  ])('rejects a ranged response with %s', async (_name, change) => {
    s3.get = { ...s3.get, ...change };

    expect(await errorOf(() => inspector.inspect(pending))).toBeInstanceOf(
      ReceiptUnavailableError,
    );
    expect(s3.bodyReads).toBe(0);
  });

  it('rejects a body longer than the range even if its length is understated', async () => {
    s3.get = {
      ContentLength: 8,
      Body: body(new Array<number>(52_144).fill(0x25)) as never,
    };

    expect(await errorOf(() => inspector.inspect(pending))).toBeInstanceOf(
      ReceiptUnavailableError,
    );
  });
});

describe('missing objects and SDK failures', () => {
  const failure = (name: string, status?: number) =>
    Object.assign(new Error('Some message text'), {
      name,
      ...(status === undefined
        ? {}
        : { $metadata: { httpStatusCode: status } }),
    });

  it.each<[string, unknown]>([
    ['a NotFound name', failure('NotFound')],
    ['a NoSuchKey name', failure('NoSuchKey')],
    ['a 404 status', failure('UnknownError', 404)],
  ])('treats %s on HeadObject as unavailable', async (_name, error) => {
    s3.headFailure = error;

    expect(await errorOf(() => inspector.inspect(pending))).toBeInstanceOf(
      ReceiptUnavailableError,
    );
    expect(s3.commands).toHaveLength(1);
  });

  it('treats a missing object on the ranged read as unavailable', async () => {
    s3.getFailure = failure('NoSuchKey');

    expect(await errorOf(() => inspector.inspect(pending))).toBeInstanceOf(
      ReceiptUnavailableError,
    );
  });

  it('does not recognize a missing object by its message', async () => {
    const lookalike = Object.assign(new Error('NoSuchKey: 404 NotFound'), {
      name: 'Error',
    });
    s3.headFailure = lookalike;

    expect(await errorOf(() => inspector.inspect(pending))).toBe(lookalike);
  });

  it.each([
    failure('AccessDenied', 403),
    failure('SlowDown', 503),
    failure('TimeoutError'),
    failure('InternalError', 500),
  ])('propagates $name unchanged', async (error) => {
    s3.headFailure = error;
    expect(await errorOf(() => inspector.inspect(pending))).toBe(error);

    s3.headFailure = undefined;
    s3.getFailure = error;
    expect(await errorOf(() => inspector.inspect(pending))).toBe(error);
  });
});

describe('validation and safety', () => {
  it('validates the bucket and record before sending any command', async () => {
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
    const noBucket = new S3ReceiptInspector({ client: s3, bucketName: '' });

    expect(await errorOf(() => noBucket.inspect(pending))).toBeInstanceOf(
      TypeError,
    );
    expect(
      await errorOf(() =>
        inspector.inspect(attached as unknown as PendingReceiptRecord),
      ),
    ).toBeInstanceOf(TypeError);
    expect(
      await errorOf(() =>
        inspector.inspect({ ...pending, declaredSizeBytes: 0 }),
      ),
    ).toBeInstanceOf(ItemEncodingError);
    expect(
      await errorOf(() =>
        inspector.inspect({ ...pending, fileName: '../x.pdf' }),
      ),
    ).toBeInstanceOf(ItemEncodingError);
    expect(s3.commands).toEqual([]);
  });

  it('never exposes buckets, keys, names, or values in errors', async () => {
    const errors = [
      await errorOf(async () => {
        s3.head = { ...s3.head, ContentLength: 1 };
        await inspector.inspect(pending);
      }),
      await errorOf(async () => {
        s3.head = { ...s3.head, ContentLength: pending.declaredSizeBytes };
        s3.setSignature([0, 1, 2]);
        await inspector.inspect(pending);
      }),
      await errorOf(async () => {
        s3.headFailure = Object.assign(new Error(`${bucket} r-7731`), {
          name: 'NotFound',
        });
        await inspector.inspect(pending);
      }),
    ];

    for (const error of errors) {
      expect(error).toBeInstanceOf(ReceiptUnavailableError);
      const text = String((error as Error).message);
      for (const value of [
        bucket,
        'r-7731',
        'uploads/pending',
        'Payslip',
        checksumHex,
        hexToBase64(checksumHex),
        'application/pdf',
        '52144',
        'sub-aisha',
      ]) {
        expect(text).not.toContain(value);
      }
    }
  });

  it('sends at most two commands, both read-only, and never reads a whole object', async () => {
    await inspector.inspect(pending);

    expect(s3.commands.length).toBeLessThanOrEqual(2);
    expect(
      s3.commands.every(
        (command) =>
          command instanceof HeadObjectCommand ||
          (command instanceof GetObjectCommand &&
            command.input.Range === 'bytes=0-15'),
      ),
    ).toBe(true);
  });
});
