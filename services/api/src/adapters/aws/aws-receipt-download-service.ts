import { idSchema } from '@claimflow/contracts';
import type { Actor } from '@claimflow/domain';

import { loadVisibleClaim } from '../../application/claim-access.js';
import { NotFoundError } from '../../application/errors.js';
import type { DynamoDbClaimReader } from './dynamodb-claim-reader.js';
import type { DynamoDbReceiptMetadataReader } from './dynamodb-lookups.js';
import type { DownloadUrl, S3DownloadUrlGenerator } from './s3-download-url.js';

/**
 * The receipt download of docs/aws-architecture.md, section 11, "Download", as
 * an isolated read that only the opt-in AWS path uses: the claim is loaded
 * with the existing visibility rule (a claim the actor cannot see is a missing
 * one), a claim without a receipt is `NOT_FOUND`, the receipt metadata must be
 * the `ATTACHED` record of this claim, owned by its employee, with the claim's
 * own file name, and a short-lived presigned `GET` URL is signed locally for
 * `receipts/<receiptId>`. Nothing is read from S3. A metadata record that
 * contradicts the claim is an integrity failure with a fixed message, not a
 * not-found, and a signing failure propagates unchanged.
 */

export interface AwsReceiptDownloadServiceDependencies {
  readonly claimReader: Pick<DynamoDbClaimReader, 'get'>;
  readonly receipts: Pick<DynamoDbReceiptMetadataReader, 'get'>;
  readonly urls: Pick<S3DownloadUrlGenerator, 'createUrl'>;
}

/** The receipt record contradicts the claim that holds the receipt. */
export class ReceiptDownloadIntegrityError extends Error {
  public constructor() {
    super('The receipt record of the claim is inconsistent.');
    this.name = 'ReceiptDownloadIntegrityError';
  }
}

export class AwsReceiptDownloadService {
  public constructor(
    private readonly deps: AwsReceiptDownloadServiceDependencies,
  ) {
    if (typeof deps?.claimReader?.get !== 'function') {
      throw new TypeError('The claim reader is missing.');
    }
    if (typeof deps.receipts?.get !== 'function') {
      throw new TypeError('The receipt metadata reader is missing.');
    }
    if (typeof deps.urls?.createUrl !== 'function') {
      throw new TypeError('The download URL generator is missing.');
    }
  }

  /** The URL and its expiry for the claim's receipt. */
  public async download(actor: Actor, claimId: string): Promise<DownloadUrl> {
    if (!idSchema.safeParse(claimId).success) {
      throw new NotFoundError();
    }
    const claim = await loadVisibleClaim(this.deps.claimReader, actor, claimId);
    const receipt = claim.receipt;
    if (receipt === undefined) {
      throw new NotFoundError('This claim has no receipt.');
    }
    const record = await this.deps.receipts.get(receipt.receiptId);
    if (
      record === undefined ||
      record.state !== 'ATTACHED' ||
      record.attachedClaimId !== claim.claimId ||
      record.ownerId !== claim.employeeId ||
      record.fileName !== receipt.fileName
    ) {
      throw new ReceiptDownloadIntegrityError();
    }
    return this.deps.urls.createUrl(record.receiptId, record.fileName);
  }
}
