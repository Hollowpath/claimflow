import {
  CopyObjectCommand,
  DeleteObjectCommand,
  type CopyObjectCommandOutput,
  type DeleteObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { idSchema } from '@claimflow/contracts';

import {
  encodeReceiptItem,
  pendingObjectKey,
  receiptObjectKey,
  type PendingReceiptRecord,
} from './dynamodb-receipt-items.js';
import {
  base64ToHex,
  isMissingObject,
  ReceiptUnavailableError,
} from './s3-receipt-inspector.js';

/**
 * Moves and removes receipt objects (docs/aws-architecture.md, sections 11
 * and 12). Every step can be repeated: promotion overwrites the same final
 * key and deletion of a missing object succeeds. Which steps run, and when,
 * is decided by the callers; nothing here retries, logs, or reads objects.
 */

/** The commands these operations send; an `S3Client` provides them. */
export interface ObjectS3Client {
  send(command: CopyObjectCommand): Promise<CopyObjectCommandOutput>;
  send(command: DeleteObjectCommand): Promise<DeleteObjectCommandOutput>;
}

export interface S3ReceiptObjectsOptions {
  readonly client: ObjectS3Client;
  readonly bucketName: string;
}

export class S3ReceiptObjects {
  private readonly client: ObjectS3Client;
  private readonly bucketName: string;

  public constructor({ client, bucketName }: S3ReceiptObjectsOptions) {
    this.client = client;
    this.bucketName = bucketName;
  }

  /**
   * One `CopyObject` from `uploads/pending/<id>` to `receipts/<id>` in the
   * same bucket, keeping the object's content metadata and asking S3 for a
   * SHA-256 checksum, which must equal the declared one. A missing source or
   * a missing or different checksum raises `ReceiptUnavailableError`; other
   * S3 failures propagate unchanged. The pending object is left in place.
   */
  public async promote(record: PendingReceiptRecord): Promise<void> {
    this.checkBucket();
    if ((record as { state: string }).state !== 'PENDING') {
      throw new TypeError('Only a PENDING receipt can be promoted.');
    }
    encodeReceiptItem(record);

    let output: CopyObjectCommandOutput;
    try {
      output = await this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucketName,
          Key: receiptObjectKey(record.receiptId),
          CopySource: `${this.bucketName}/${encodeKey(
            pendingObjectKey(record.receiptId),
          )}`,
          MetadataDirective: 'COPY',
          ChecksumAlgorithm: 'SHA256',
        }),
      );
    } catch (error) {
      throw isMissingObject(error) ? new ReceiptUnavailableError() : error;
    }
    if (
      base64ToHex(output.CopyObjectResult?.ChecksumSHA256) !==
      record.declaredChecksumSha256
    ) {
      throw new ReceiptUnavailableError();
    }
  }

  /** One `DeleteObject` of the pending upload; succeeds if it is gone. */
  public async deletePending(receiptId: string): Promise<void> {
    await this.delete(receiptId, pendingObjectKey);
  }

  /** One `DeleteObject` of the final receipt; succeeds if it is gone. */
  public async deleteFinal(receiptId: string): Promise<void> {
    await this.delete(receiptId, receiptObjectKey);
  }

  private async delete(
    receiptId: string,
    keyOf: (receiptId: string) => string,
  ): Promise<void> {
    this.checkBucket();
    if (!idSchema.safeParse(receiptId).success) {
      throw new TypeError('The receipt ID is not valid.');
    }
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: keyOf(receiptId),
      }),
    );
  }

  private checkBucket(): void {
    if (typeof this.bucketName !== 'string' || this.bucketName.length === 0) {
      throw new TypeError('The receipt bucket name is missing.');
    }
  }
}

/** Object keys in `CopySource` are URL-encoded, except for the separators. */
function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}
