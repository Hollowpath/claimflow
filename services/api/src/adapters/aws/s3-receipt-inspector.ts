import {
  GetObjectCommand,
  HeadObjectCommand,
  type GetObjectCommandOutput,
  type HeadObjectCommandOutput,
} from '@aws-sdk/client-s3';
import {
  detectReceiptContentType,
  type UploadedReceipt,
} from '@claimflow/domain';

import {
  encodeReceiptItem,
  pendingObjectKey,
  type PendingReceiptRecord,
} from './dynamodb-receipt-items.js';

/**
 * Verifies the uploaded object of a pending receipt
 * (docs/aws-architecture.md, section 11, step 4): `HeadObject` for the size,
 * type, and stored SHA-256 checksum, then a ranged read of the first 16
 * bytes for the real file type. It never reads the whole object and changes
 * nothing.
 */

/** The commands the inspector sends; an `S3Client` provides them. */
export interface InspectionS3Client {
  send(command: HeadObjectCommand): Promise<HeadObjectCommandOutput>;
  send(command: GetObjectCommand): Promise<GetObjectCommandOutput>;
}

export interface S3ReceiptInspectorOptions {
  readonly client: InspectionS3Client;
  readonly bucketName: string;
}

/** The leading bytes that identify every supported file type. */
export const signatureRange = 'bytes=0-15';
const signatureBytes = 16;

/**
 * The pending upload is missing or does not match what was declared. The
 * message is fixed, so it never exposes buckets, keys, names, or values.
 */
export class ReceiptUnavailableError extends Error {
  public constructor() {
    super('The receipt upload is unavailable.');
    this.name = 'ReceiptUnavailableError';
  }
}

export class S3ReceiptInspector {
  private readonly client: InspectionS3Client;
  private readonly bucketName: string;

  public constructor({ client, bucketName }: S3ReceiptInspectorOptions) {
    this.client = client;
    this.bucketName = bucketName;
  }

  /**
   * The measured upload for a `PENDING` record whose object matches its
   * declaration. Missing objects and every mismatch raise
   * `ReceiptUnavailableError`; other SDK failures propagate unchanged.
   */
  public async inspect(record: PendingReceiptRecord): Promise<UploadedReceipt> {
    if (typeof this.bucketName !== 'string' || this.bucketName.length === 0) {
      throw new TypeError('The receipt bucket name is missing.');
    }
    if ((record as { state: string }).state !== 'PENDING') {
      throw new TypeError('Only a PENDING receipt can be inspected.');
    }
    encodeReceiptItem(record);

    const key = pendingObjectKey(record.receiptId);
    const head = await this.read(() =>
      this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucketName,
          Key: key,
          ChecksumMode: 'ENABLED',
        }),
      ),
    );
    if (
      head.ContentLength !== record.declaredSizeBytes ||
      head.ContentType !== record.declaredContentType ||
      base64ToHex(head.ChecksumSHA256) !== record.declaredChecksumSha256
    ) {
      throw new ReceiptUnavailableError();
    }

    const bytes = await this.readSignature(key);
    if (detectReceiptContentType(bytes) !== record.declaredContentType) {
      throw new ReceiptUnavailableError();
    }

    return {
      receiptId: record.receiptId,
      ownerId: record.ownerId,
      fileName: record.fileName,
      contentType: record.declaredContentType,
      sizeBytes: record.declaredSizeBytes,
      checksumSha256: record.declaredChecksumSha256,
      uploadedAt: record.uploadedAt,
    };
  }

  /** One ranged read of the first 16 bytes, and nothing more of the body. */
  private async readSignature(key: string): Promise<Uint8Array> {
    const object = await this.read(() =>
      this.client.send(
        new GetObjectCommand({
          Bucket: this.bucketName,
          Key: key,
          Range: signatureRange,
        }),
      ),
    );
    const body = object.Body;
    if (
      body === undefined ||
      typeof body.transformToByteArray !== 'function' ||
      // A response longer than the range means the range was ignored.
      object.ContentLength === undefined ||
      object.ContentLength < 1 ||
      object.ContentLength > signatureBytes
    ) {
      throw new ReceiptUnavailableError();
    }
    const bytes = await body.transformToByteArray();
    if (bytes.byteLength < 1 || bytes.byteLength > signatureBytes) {
      throw new ReceiptUnavailableError();
    }
    return bytes;
  }

  /** Runs an S3 call, turning a missing object into the safe error. */
  private async read<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (isMissingObject(error)) {
        throw new ReceiptUnavailableError();
      }
      throw error;
    }
  }
}

/** By error name or HTTP status only, never by message text. */
export function isMissingObject(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const { name, $metadata } = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return (
    name === 'NotFound' ||
    name === 'NoSuchKey' ||
    $metadata?.httpStatusCode === 404
  );
}

/** S3's base64 SHA-256 as canonical lower-case hex, or `undefined`. */
export function base64ToHex(checksum: string | undefined): string | undefined {
  if (checksum === undefined || !/^[A-Za-z0-9+/]{43}=$/.test(checksum)) {
    return undefined;
  }
  return Buffer.from(checksum, 'base64').toString('hex');
}
