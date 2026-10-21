import {
  isResultReference,
  type EpochSeconds,
} from '../../application/commit.js';
import { unavailable } from '../../application/receipt-service.js';
import {
  encodeIdempotencyItem,
  type IdempotencyRecord,
} from './dynamodb-idempotency-items.js';
import { invalidKeyIdentifier, ItemIntegrityError } from './dynamodb-items.js';
import type { DynamoDbReceiptMetadataReader } from './dynamodb-lookups.js';
import type { S3UploadFormGenerator, UploadForm } from './s3-upload-form.js';

/**
 * Resolves the stored result reference of a receipt upload into a fresh
 * upload form (docs/aws-architecture.md, section 10, "Reconstructed
 * results"). It reads the referenced receipt metadata once, strongly
 * consistent, requires it to be an unexpired `PENDING` receipt owned by the
 * record's actor, and asks the form generator once for a new form for that
 * same record, so the original upload conditions are kept. It writes nothing,
 * touches no object, retries nothing, generates no ID or metadata, and never
 * stores, caches, logs, or prints a form. It defines no HTTP response.
 * Validation messages are fixed and carry no supplied or stored value;
 * dependency errors propagate unchanged.
 */

/** The metadata read the resolver uses. */
export type ReceiptMetadataFinder = Pick<DynamoDbReceiptMetadataReader, 'get'>;

/** The form creation the resolver uses. */
export type UploadFormCreator = Pick<S3UploadFormGenerator, 'createForm'>;

export interface ReceiptUploadReplayResolverOptions {
  readonly receipts: ReceiptMetadataFinder;
  readonly forms: UploadFormCreator;
}

/** The same receipt, with a newly issued upload form. */
export interface ReceiptUploadReplay {
  readonly receiptId: string;
  readonly form: UploadForm;
}

export class ReceiptUploadReplayResolver {
  private readonly receipts: ReceiptMetadataFinder;
  private readonly forms: UploadFormCreator;

  public constructor({ receipts, forms }: ReceiptUploadReplayResolverOptions) {
    if (typeof receipts?.get !== 'function') {
      throw new TypeError('The receipt metadata reader is missing.');
    }
    if (typeof forms?.createForm !== 'function') {
      throw new TypeError('The upload form generator is missing.');
    }
    this.receipts = receipts;
    this.forms = forms;
  }

  /**
   * One metadata read, then one form for the pending receipt it returns.
   * A missing, expired, non-pending, or foreign receipt is the existing
   * `RECEIPT_UNAVAILABLE` validation error; a receipt that is not the one
   * referenced is an integrity error.
   */
  public async resolve(
    record: IdempotencyRecord,
    nowEpoch: EpochSeconds,
  ): Promise<ReceiptUploadReplay> {
    const receiptId = referencedReceiptId(record, nowEpoch);
    const receipt = await this.receipts.get(receiptId);
    if (receipt === undefined) {
      throw unavailable();
    }
    if (receipt.receiptId !== receiptId) {
      throw new ItemIntegrityError(
        invalidKeyIdentifier,
        'the receipt is not the one referenced by the result',
      );
    }
    if (
      receipt.state !== 'PENDING' ||
      receipt.ownerId !== record.actorId ||
      receipt.expiresAt < nowEpoch
    ) {
      throw unavailable();
    }
    const form = await this.forms.createForm(receipt);
    return { receiptId: receipt.receiptId, form };
  }
}

/** The receipt ID of an unexpired completed receipt-upload result. */
function referencedReceiptId(
  record: IdempotencyRecord,
  nowEpoch: number,
): string {
  if (!Number.isSafeInteger(nowEpoch) || nowEpoch < 0) {
    throw new RangeError('nowEpoch must be whole Unix epoch seconds.');
  }
  if (typeof record !== 'object' || record === null) {
    throw new TypeError('The idempotency record is missing.');
  }
  // Rejects every record the idempotency codec refuses, with its fixed message.
  encodeIdempotencyItem(record);
  if (record.outcome !== 'COMPLETED' || !isResultReference(record.response)) {
    throw new TypeError(
      'The idempotency record is not a receipt upload result.',
    );
  }
  // A record expiring exactly now is still present, as in the lookup.
  if (record.expiresAt < nowEpoch) {
    throw new RangeError('The idempotency record has expired.');
  }
  return record.response.resultRef.receiptId;
}
