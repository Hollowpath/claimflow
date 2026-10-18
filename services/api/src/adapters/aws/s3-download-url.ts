import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { idSchema } from '@claimflow/contracts';
import { sanitizeFileName } from '@claimflow/domain';

import { contentDisposition } from '../../application/content-disposition.js';
import type { Clock } from '../../application/ports.js';
import { receiptObjectKey } from './dynamodb-receipt-items.js';

/**
 * Presigned download URLs for attached receipts (docs/aws-architecture.md,
 * section 11): a `GetObject` URL for `receipts/<receiptId>`, valid for five
 * minutes, that names the file for the browser. Signing is local; nothing is
 * read from S3.
 */

/** Download URLs are valid for five minutes. */
export const downloadUrlLifetimeSeconds = 5 * 60;

export interface DownloadUrl {
  readonly url: string;
  /** Canonical ISO time exactly five minutes after signing. */
  readonly expiresAt: string;
}

export interface DownloadUrlRequest {
  readonly bucket: string;
  readonly key: string;
  readonly responseContentDisposition: string;
  readonly expiresInSeconds: number;
  readonly signingDate: Date;
}

/** Signs a download URL; the real signer is `createS3DownloadSigner`. */
export type DownloadUrlSigner = (
  request: DownloadUrlRequest,
) => Promise<string>;

/** A download URL that cannot be produced; messages carry no stored values. */
export class DownloadUrlError extends Error {
  public constructor(problem: string) {
    super(`Cannot create the download URL: ${problem}.`);
    this.name = 'DownloadUrlError';
  }
}

export interface S3DownloadUrlGeneratorOptions {
  readonly bucketName: string;
  readonly sign: DownloadUrlSigner;
  readonly clock: Clock;
}

export class S3DownloadUrlGenerator {
  private readonly bucketName: string;
  private readonly sign: DownloadUrlSigner;
  private readonly clock: Clock;

  public constructor({
    bucketName,
    sign,
    clock,
  }: S3DownloadUrlGeneratorOptions) {
    this.bucketName = bucketName;
    this.sign = sign;
    this.clock = clock;
  }

  /**
   * The URL for an attached receipt. The bucket, receipt ID, and file name
   * (already in its sanitized form) are validated before signing, and the
   * signer runs once, at one captured time.
   */
  public async createUrl(
    receiptId: string,
    fileName: string,
  ): Promise<DownloadUrl> {
    if (typeof this.bucketName !== 'string' || this.bucketName.length === 0) {
      throw new DownloadUrlError('the receipt bucket name is missing');
    }
    if (!idSchema.safeParse(receiptId).success) {
      throw new DownloadUrlError('the receipt ID is not valid');
    }
    if (fileName !== sanitizeFileName(fileName)) {
      throw new DownloadUrlError('the file name is not in its sanitized form');
    }

    const signingDate = this.clock.now();
    const url = await this.sign({
      bucket: this.bucketName,
      key: receiptObjectKey(receiptId),
      responseContentDisposition: contentDisposition(fileName),
      expiresInSeconds: downloadUrlLifetimeSeconds,
      signingDate,
    });
    if (
      typeof url !== 'string' ||
      !url.startsWith('https://') ||
      url.length <= 8
    ) {
      throw new DownloadUrlError('the signer returned an invalid URL');
    }
    return {
      url,
      expiresAt: new Date(
        signingDate.getTime() + downloadUrlLifetimeSeconds * 1000,
      ).toISOString(),
    };
  }
}

/** The real signer: local SigV4 signing of a `GetObject`, sent nowhere. */
export function createS3DownloadSigner(client: S3Client): DownloadUrlSigner {
  return ({
    bucket,
    key,
    responseContentDisposition,
    expiresInSeconds,
    signingDate,
  }) =>
    getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentDisposition: responseContentDisposition,
      }),
      { expiresIn: expiresInSeconds, signingDate },
    );
}
