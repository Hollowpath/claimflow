/* eslint-disable @typescript-eslint/prefer-promise-reject-errors -- the fake rejects with scripted values, which may not be Errors */
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  type CopyObjectCommandOutput,
  type DeleteObjectCommandOutput,
  type S3Client,
} from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, expectTypeOf, it } from 'vitest';

import { ItemEncodingError } from '../src/adapters/aws/dynamodb-items.js';
import {
  pendingReceiptExpiresAt,
  type AttachedReceiptRecord,
  type PendingReceiptRecord,
} from '../src/adapters/aws/dynamodb-receipt-items.js';
import { ReceiptUnavailableError } from '../src/adapters/aws/s3-receipt-inspector.js';
import {
  S3ReceiptObjects,
  type ObjectS3Client,
} from '../src/adapters/aws/s3-receipt-objects.js';
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

/** Records every command and answers as scripted. */
class FakeS3 implements ObjectS3Client {
  public readonly commands: (CopyObjectCommand | DeleteObjectCommand)[] = [];
  public copyResult: CopyObjectCommandOutput['CopyObjectResult'] = {
    ChecksumSHA256: hexToBase64(checksumHex),
  };
  public failure: unknown;

  public send(command: CopyObjectCommand): Promise<CopyObjectCommandOutput>;
  public send(command: DeleteObjectCommand): Promise<DeleteObjectCommandOutput>;
  public send(
    command: CopyObjectCommand | DeleteObjectCommand,
  ): Promise<CopyObjectCommandOutput | DeleteObjectCommandOutput> {
    this.commands.push(command);
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
    return Promise.resolve(
      command instanceof CopyObjectCommand
        ? {
            $metadata: {},
            CopyObjectResult: this.copyResult,
          }
        : { $metadata: {} },
    );
  }
}

let s3: FakeS3;
let objects: S3ReceiptObjects;

beforeEach(() => {
  s3 = new FakeS3();
  objects = new S3ReceiptObjects({ client: s3, bucketName: bucket });
});

async function errorOf(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  return undefined;
}

const failure = (name: string, status?: number) =>
  Object.assign(new Error('Some message text'), {
    name,
    ...(status === undefined ? {} : { $metadata: { httpStatusCode: status } }),
  });

it('accepts the real S3 client', () => {
  expectTypeOf<S3Client>().toExtend<ObjectS3Client>();
});

describe('promote', () => {
  it('sends exactly one CopyObject to the final key, with a SHA-256 checksum', async () => {
    await objects.promote(pending);

    expect(s3.commands).toHaveLength(1);
    expect(s3.commands[0]).toBeInstanceOf(CopyObjectCommand);
    expect(s3.commands[0]!.input).toEqual({
      Bucket: bucket,
      Key: 'receipts/r-7731',
      CopySource: `${bucket}/uploads/pending/r-7731`,
      MetadataDirective: 'COPY',
      ChecksumAlgorithm: 'SHA256',
    });
  });

  it('accepts a result whose checksum equals the declared one', async () => {
    await expect(objects.promote(pending)).resolves.toBeUndefined();
  });

  it.each<[string, CopyObjectCommandOutput['CopyObjectResult']]>([
    ['no result', undefined],
    ['no checksum', {}],
    ['a different checksum', { ChecksumSHA256: hexToBase64('00'.repeat(32)) }],
    ['a malformed checksum', { ChecksumSHA256: 'not-base64' }],
    [
      'a multipart checksum',
      { ChecksumSHA256: `${hexToBase64(checksumHex)}-2` },
    ],
  ])('rejects %s', async (_name, result) => {
    s3.copyResult = result;

    expect(await errorOf(() => objects.promote(pending))).toBeInstanceOf(
      ReceiptUnavailableError,
    );
    expect(s3.commands).toHaveLength(1);
  });

  it.each([
    ['a NoSuchKey name', failure('NoSuchKey')],
    ['a NotFound name', failure('NotFound')],
    ['a 404 status', failure('UnknownError', 404)],
  ])('treats %s as a missing source', async (_name, error) => {
    s3.failure = error;

    expect(await errorOf(() => objects.promote(pending))).toBeInstanceOf(
      ReceiptUnavailableError,
    );
    expect(s3.commands).toHaveLength(1);
  });

  it('does not recognize a missing source by message text', async () => {
    const lookalike = Object.assign(new Error('NoSuchKey 404'), {
      name: 'Error',
    });
    s3.failure = lookalike;

    expect(await errorOf(() => objects.promote(pending))).toBe(lookalike);
  });

  it.each([
    failure('AccessDenied', 403),
    failure('SlowDown', 503),
    failure('TimeoutError'),
    failure('InternalError', 500),
  ])('propagates $name unchanged', async (error) => {
    s3.failure = error;

    expect(await errorOf(() => objects.promote(pending))).toBe(error);
    expect(s3.commands).toHaveLength(1);
  });

  it('validates the bucket and record before sending anything', async () => {
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
    const noBucket = new S3ReceiptObjects({ client: s3, bucketName: '' });

    expect(await errorOf(() => noBucket.promote(pending))).toBeInstanceOf(
      TypeError,
    );
    expect(
      await errorOf(() =>
        objects.promote(attached as unknown as PendingReceiptRecord),
      ),
    ).toBeInstanceOf(TypeError);
    expect(
      await errorOf(() =>
        objects.promote({ ...pending, declaredSizeBytes: 0 }),
      ),
    ).toBeInstanceOf(ItemEncodingError);
    expect(
      await errorOf(() =>
        objects.promote({ ...pending, fileName: '../x.pdf' }),
      ),
    ).toBeInstanceOf(ItemEncodingError);
    expect(s3.commands).toEqual([]);
  });
});

describe('delete', () => {
  it('sends one DeleteObject for the pending key', async () => {
    await objects.deletePending('r-7731');

    expect(s3.commands).toHaveLength(1);
    expect(s3.commands[0]).toBeInstanceOf(DeleteObjectCommand);
    expect(s3.commands[0]!.input).toEqual({
      Bucket: bucket,
      Key: 'uploads/pending/r-7731',
    });
  });

  it('sends one DeleteObject for the final key', async () => {
    await objects.deleteFinal('r-7731');

    expect(s3.commands).toHaveLength(1);
    expect(s3.commands[0]!.input).toEqual({
      Bucket: bucket,
      Key: 'receipts/r-7731',
    });
  });

  it('does no preliminary read and succeeds for a missing object', async () => {
    await objects.deletePending('r-gone');
    await objects.deleteFinal('r-gone');

    expect(s3.commands.every((c) => c instanceof DeleteObjectCommand)).toBe(
      true,
    );
    expect(s3.commands).toHaveLength(2);
  });

  it.each(['', 'r#1', 'r 1', 'receipts/r-1', '../r-1', 'x'.repeat(65)])(
    'rejects receipt ID %j before sending anything',
    async (receiptId) => {
      expect(
        await errorOf(() => objects.deletePending(receiptId)),
      ).toBeInstanceOf(TypeError);
      expect(
        await errorOf(() => objects.deleteFinal(receiptId)),
      ).toBeInstanceOf(TypeError);
      expect(s3.commands).toEqual([]);
    },
  );

  it('rejects a missing bucket before sending anything', async () => {
    const noBucket = new S3ReceiptObjects({ client: s3, bucketName: '' });

    expect(await errorOf(() => noBucket.deleteFinal('r-7731'))).toBeInstanceOf(
      TypeError,
    );
    expect(s3.commands).toEqual([]);
  });

  it('propagates S3 failures unchanged, without a retry', async () => {
    const error = failure('AccessDenied', 403);
    s3.failure = error;

    expect(await errorOf(() => objects.deleteFinal('r-7731'))).toBe(error);
    expect(s3.commands).toHaveLength(1);
  });
});

describe('safety', () => {
  it('uses fixed messages that expose no bucket, key, name, or value', async () => {
    const errors = [
      await errorOf(async () => {
        s3.copyResult = { ChecksumSHA256: hexToBase64('00'.repeat(32)) };
        await objects.promote(pending);
      }),
      await errorOf(async () => {
        s3.failure = Object.assign(new Error(`${bucket} r-7731`), {
          name: 'NoSuchKey',
        });
        await objects.promote(pending);
      }),
    ];

    for (const error of errors) {
      expect(error).toBeInstanceOf(ReceiptUnavailableError);
      const text = (error as Error).message;
      for (const value of [
        bucket,
        'r-7731',
        'uploads/pending',
        'Payslip',
        checksumHex,
        hexToBase64(checksumHex),
      ]) {
        expect(text).not.toContain(value);
      }
    }
    const typeErrors = [
      await errorOf(() => objects.deletePending(`../${secretFileName}`)),
      await errorOf(() =>
        new S3ReceiptObjects({ client: s3, bucketName: '' }).promote(pending),
      ),
    ];
    for (const error of typeErrors) {
      expect((error as Error).message).not.toContain('Payslip');
      expect((error as Error).message).not.toContain(bucket);
    }
  });

  it('sends only CopyObject and DeleteObject commands', async () => {
    await objects.promote(pending);
    await objects.deletePending('r-7731');
    await objects.deleteFinal('r-7731');

    expect(s3.commands.map((command) => command.constructor.name)).toEqual([
      'CopyObjectCommand',
      'DeleteObjectCommand',
      'DeleteObjectCommand',
    ]);
  });
});
