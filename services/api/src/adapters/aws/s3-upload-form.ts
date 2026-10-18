import {
  createPresignedPost,
  type PresignedPostOptions,
} from '@aws-sdk/s3-presigned-post';
import type { S3Client } from '@aws-sdk/client-s3';

import {
  encodeReceiptItem,
  pendingObjectKey,
  type PendingReceiptRecord,
} from './dynamodb-receipt-items.js';

/**
 * The presigned `POST` form for uploading a pending receipt
 * (docs/aws-architecture.md, section 11). S3 enforces the declared size,
 * content type, and SHA-256 checksum, so any other upload is rejected. The
 * signer is injected; nothing here uploads or sends an S3 command.
 */

/** The browser form: where to post, and the signed fields to send first. */
export interface UploadForm {
  readonly url: string;
  readonly fields: Readonly<Record<string, string>>;
}

/** A POST policy condition, in the forms this design uses. */
export type UploadCondition =
  | { readonly bucket: string }
  | readonly ['eq', string, string]
  | readonly ['content-length-range', number, number];

export interface UploadFormRequest {
  readonly bucket: string;
  readonly key: string;
  /** Form fields to sign in addition to the signing fields. */
  readonly fields: Readonly<Record<string, string>>;
  readonly conditions: readonly UploadCondition[];
  readonly expiresSeconds: number;
}

/** Signs a POST policy; the real signer is `createS3UploadFormSigner`. */
export type UploadFormSigner = (
  request: UploadFormRequest,
) => Promise<UploadForm>;

/** The policy is valid for 15 minutes. */
export const uploadFormLifetimeSeconds = 15 * 60;

/** An upload form that cannot be produced; messages carry no stored values. */
export class UploadFormError extends Error {
  public constructor(problem: string) {
    super(`Cannot create the upload form: ${problem}.`);
    this.name = 'UploadFormError';
  }
}

export interface S3UploadFormGeneratorOptions {
  readonly bucketName: string;
  readonly sign: UploadFormSigner;
}

export class S3UploadFormGenerator {
  private readonly bucketName: string;
  private readonly sign: UploadFormSigner;

  public constructor({ bucketName, sign }: S3UploadFormGeneratorOptions) {
    this.bucketName = bucketName;
    this.sign = sign;
  }

  /**
   * The form for a validated `PENDING` record. The record is checked by the
   * receipt codec before anything is signed, and the signer runs once.
   */
  public async createForm(record: PendingReceiptRecord): Promise<UploadForm> {
    if (typeof this.bucketName !== 'string' || this.bucketName.length === 0) {
      throw new UploadFormError('the receipt bucket name is missing');
    }
    if ((record as { state: string }).state !== 'PENDING') {
      throw new UploadFormError('only a PENDING receipt can be uploaded');
    }
    encodeReceiptItem(record);

    const key = pendingObjectKey(record.receiptId);
    const checksum = hexToBase64(record.declaredChecksumSha256);
    const fields = {
      key,
      'Content-Type': record.declaredContentType,
      'x-amz-checksum-algorithm': 'SHA256',
      'x-amz-checksum-sha256': checksum,
    };
    const form = await this.sign({
      bucket: this.bucketName,
      key,
      fields,
      conditions: [
        { bucket: this.bucketName },
        ['eq', '$key', key],
        ['eq', '$Content-Type', record.declaredContentType],
        [
          'content-length-range',
          record.declaredSizeBytes,
          record.declaredSizeBytes,
        ],
        ['eq', '$x-amz-checksum-algorithm', 'SHA256'],
        ['eq', '$x-amz-checksum-sha256', checksum],
      ],
      expiresSeconds: uploadFormLifetimeSeconds,
    });
    return checkSigned(form, fields);
  }
}

/** The real signer: local SigV4 signing with the client's credentials. */
export function createS3UploadFormSigner(client: S3Client): UploadFormSigner {
  return async ({ bucket, key, fields, conditions, expiresSeconds }) => {
    const options: PresignedPostOptions = {
      Bucket: bucket,
      Key: key,
      Fields: { ...fields },
      Conditions: conditions.map((condition) =>
        Array.isArray(condition) ? [...condition] : condition,
      ) as NonNullable<PresignedPostOptions['Conditions']>,
      Expires: expiresSeconds,
    };
    const { url, fields: signed } = await createPresignedPost(client, options);
    return { url, fields: signed };
  };
}

/** Canonical lower-case hex SHA-256 to the base64 S3 expects. */
export function hexToBase64(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64');
}

/**
 * The signer must return an HTTPS URL and string fields that keep the
 * requested values and carry a policy and signature; otherwise the form
 * would not enforce the upload conditions.
 */
function checkSigned(
  form: UploadForm,
  requested: Readonly<Record<string, string>>,
): UploadForm {
  const fields = (form as { fields?: unknown } | undefined)?.fields;
  const url = (form as { url?: unknown } | undefined)?.url;
  if (
    typeof url !== 'string' ||
    !url.startsWith('https://') ||
    typeof fields !== 'object' ||
    fields === null ||
    Array.isArray(fields) ||
    !Object.values(fields).every((value) => typeof value === 'string')
  ) {
    throw new UploadFormError('the signer returned an invalid form');
  }
  const signed = fields as Record<string, string>;
  for (const [name, value] of Object.entries(requested)) {
    if (signed[name] !== value) {
      throw new UploadFormError('the signed form changed a requested field');
    }
  }
  const policy = signed.Policy ?? signed.policy;
  const signature = signed['X-Amz-Signature'] ?? signed['x-amz-signature'];
  if (
    policy === undefined ||
    policy === '' ||
    signature === undefined ||
    signature === ''
  ) {
    throw new UploadFormError('the signed form has no policy or signature');
  }
  return { url, fields: { ...signed } };
}
