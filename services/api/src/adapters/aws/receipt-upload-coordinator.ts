import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { idempotencyKeySchema, idSchema } from '@claimflow/contracts';

import {
  isResultReference,
  type CommitOptions,
  type CompletedRequest,
  type EpochSeconds,
} from '../../application/commit.js';
import type { DynamoDbIdempotentTransactionCommitter } from './dynamodb-idempotent-transaction-committer.js';
import {
  encodeIdempotencyItem,
  type IdempotencyRecord,
} from './dynamodb-idempotency-items.js';
import {
  encodeReceiptItem,
  type PendingReceiptRecord,
} from './dynamodb-receipt-items.js';
import type { DynamoDbReceiptUploadWriter } from './dynamodb-receipt-upload-writer.js';
import type {
  ReceiptUploadReplay,
  ReceiptUploadReplayResolver,
} from './receipt-upload-replay-resolver.js';
import type { DynamoDbIdempotencyCoordinator } from './dynamodb-idempotency-coordinator.js';
import type { RejectedIdempotencyRecord } from './dynamodb-idempotency-writer.js';

/**
 * Orchestrates the creation of a pending receipt upload
 * (docs/aws-architecture.md, sections 10 and 11) from a prebuilt record and a
 * prebuilt completed result, without any service, route, or runtime wiring.
 * It looks the idempotency key up first and, only when nothing is stored,
 * prepares the pending-receipt transaction once and commits it through the
 * idempotent committer. Whatever record wins is the one used: a result
 * reference (possibly to another, earlier receipt) is resolved into a fresh
 * upload form; a snapshot, such as a concurrent rejection, is returned intact
 * without the resolver. It generates no ID or timestamp, defines no HTTP
 * contract, persists no rejection, and adds no retry or recovery of its own.
 * A failure to resolve or sign after the commit never removes the metadata: a
 * retry finds the stored reference through the lookup. Errors propagate
 * unchanged; validation messages are fixed and name no supplied value.
 */

/** The preparation capability of the upload writer. */
export type PendingTransactionPreparer = Pick<
  DynamoDbReceiptUploadWriter,
  'preparePending'
>;
/** The lookup capability of the idempotency coordinator. */
export type UploadIdempotencyLookup = Pick<
  DynamoDbIdempotencyCoordinator,
  'lookup'
>;
/** The commit capability of the idempotent transaction committer. */
export type UploadTransactionCommitter = Pick<
  DynamoDbIdempotentTransactionCommitter,
  'commit'
>;
/** The replay capability of the upload replay resolver. */
export type UploadReplayResolver = Pick<ReceiptUploadReplayResolver, 'resolve'>;

/** The rejection capability of the idempotency coordinator. */
export type UploadRejections = Pick<
  DynamoDbIdempotencyCoordinator,
  'recordRejection'
>;

/** Who is acting, under which key, for which request, and at what time. */
export interface ReceiptUploadRequest {
  readonly actorId: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly nowEpoch: EpochSeconds;
}

/** The pending receipt and completed reference that `run` commits. */
export interface PreparedReceiptUpload {
  readonly pending: PendingReceiptRecord;
  readonly completed: CompletedRequest;
}

/** An explicit business rejection, built by the preparation. */
export interface PreparedReceiptRejection {
  readonly rejection: RejectedIdempotencyRecord;
}

export interface ReceiptUploadCoordinatorOptions {
  readonly preparer: PendingTransactionPreparer;
  readonly lookup: UploadIdempotencyLookup;
  readonly committer: UploadTransactionCommitter;
  readonly resolver: UploadReplayResolver;
  /** Needed by `run` only, to persist an explicitly prepared rejection. */
  readonly rejections?: UploadRejections;
}

/**
 * The record that governs the request, and the reconstructed upload when it
 * is a receipt result reference. Whether this request committed or replayed
 * is not reported.
 */
export interface ReceiptUploadResult {
  readonly record: IdempotencyRecord;
  readonly upload?: ReceiptUploadReplay;
}

export class ReceiptUploadCoordinator {
  private readonly preparer: PendingTransactionPreparer;
  private readonly lookup: UploadIdempotencyLookup;
  private readonly committer: UploadTransactionCommitter;
  private readonly resolver: UploadReplayResolver;
  private readonly rejections: UploadRejections | undefined;

  public constructor({
    preparer,
    lookup,
    committer,
    resolver,
    rejections,
  }: ReceiptUploadCoordinatorOptions) {
    if (typeof preparer?.preparePending !== 'function') {
      throw new TypeError('The pending transaction preparer is missing.');
    }
    if (typeof lookup?.lookup !== 'function') {
      throw new TypeError('The idempotency lookup is missing.');
    }
    if (typeof committer?.commit !== 'function') {
      throw new TypeError('The transaction committer is missing.');
    }
    if (typeof resolver?.resolve !== 'function') {
      throw new TypeError('The upload replay resolver is missing.');
    }
    this.preparer = preparer;
    this.lookup = lookup;
    this.committer = committer;
    if (
      rejections !== undefined &&
      typeof rejections.recordRejection !== 'function'
    ) {
      throw new TypeError('The rejection recorder is missing.');
    }
    this.resolver = resolver;
    this.rejections = rejections;
  }

  /**
   * Looks the key up; with no stored record prepares and commits the
   * candidate once; then resolves the governing record when it is a result
   * reference.
   */
  public async create(
    pending: PendingReceiptRecord,
    completed: CompletedRequest,
    nowEpoch: EpochSeconds,
  ): Promise<ReceiptUploadResult> {
    checkCandidate(pending, completed, nowEpoch);

    let record = await this.lookup.lookup(
      completed.actorId,
      completed.key,
      completed.fingerprint,
      nowEpoch,
    );
    if (record === undefined) {
      record = await this.commitCandidate(pending, completed, nowEpoch);
    }
    return this.resolve(record, nowEpoch);
  }

  /**
   * The lazy form of `create`, for a flow that must not build anything before
   * the idempotency lookup: it looks the key up first (a stored record is used
   * as is, and a fingerprint conflict propagates), and only then calls
   * `prepare` once. The preparation returns the pending receipt and completed
   * reference to commit, or an explicit business rejection, which is stored
   * through the idempotency coordinator (a concurrent winner is returned).
   * Whatever record governs is resolved as in `create`.
   */
  public async run(
    request: ReceiptUploadRequest,
    prepare: () => Promise<PreparedReceiptUpload | PreparedReceiptRejection>,
  ): Promise<ReceiptUploadResult> {
    checkRequest(request, prepare);
    let record = await this.lookup.lookup(
      request.actorId,
      request.key,
      request.fingerprint,
      request.nowEpoch,
    );
    if (record === undefined) {
      const prepared = await prepare();
      if (typeof prepared !== 'object' || prepared === null) {
        throw new TypeError('The prepared upload is missing.');
      }
      if ('rejection' in prepared) {
        if ('pending' in prepared || 'completed' in prepared) {
          throw new TypeError('The prepared upload mixes its shapes.');
        }
        checkRejection(prepared.rejection, request);
        if (this.rejections === undefined) {
          throw new TypeError('The rejection recorder is missing.');
        }
        record = await this.rejections.recordRejection(
          prepared.rejection,
          request.nowEpoch,
        );
      } else {
        checkCandidate(prepared.pending, prepared.completed, request.nowEpoch);
        checkSameRequest(prepared.completed, request);
        record = await this.commitCandidate(
          prepared.pending,
          prepared.completed,
          request.nowEpoch,
        );
      }
    }
    return this.resolve(record, request.nowEpoch);
  }

  private commitCandidate(
    pending: PendingReceiptRecord,
    completed: CompletedRequest,
    nowEpoch: EpochSeconds,
  ): Promise<IdempotencyRecord> {
    const options: CommitOptions = { events: [], idempotency: completed };
    const transaction: TransactWriteCommandInput = this.preparer.preparePending(
      pending,
      options,
    );
    return this.committer.commit(transaction, completed, nowEpoch);
  }

  private async resolve(
    record: IdempotencyRecord,
    nowEpoch: EpochSeconds,
  ): Promise<ReceiptUploadResult> {
    if (record.outcome === 'COMPLETED' && isResultReference(record.response)) {
      return { record, upload: await this.resolver.resolve(record, nowEpoch) };
    }
    return { record };
  }
}

function checkRequest(request: ReceiptUploadRequest, prepare: unknown): void {
  if (typeof request !== 'object' || request === null) {
    throw new TypeError('The upload request is missing.');
  }
  if (!idSchema.safeParse(request.actorId).success) {
    throw new TypeError('The actor ID is not valid.');
  }
  if (!idempotencyKeySchema.safeParse(request.key).success) {
    throw new TypeError('The idempotency key is not valid.');
  }
  if (
    typeof request.fingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(request.fingerprint)
  ) {
    throw new TypeError('The request fingerprint is not valid.');
  }
  if (!Number.isSafeInteger(request.nowEpoch) || request.nowEpoch < 0) {
    throw new RangeError('nowEpoch must be whole Unix epoch seconds.');
  }
  if (typeof prepare !== 'function') {
    throw new TypeError('The upload preparation is missing.');
  }
}

function checkSameRequest(
  completed: CompletedRequest,
  request: ReceiptUploadRequest,
): void {
  if (
    completed.actorId !== request.actorId ||
    completed.key !== request.key ||
    completed.fingerprint !== request.fingerprint
  ) {
    throw new TypeError('The completed request is not for this request.');
  }
}

/** A codec-valid, unexpired REJECTED snapshot for this very request. */
function checkRejection(
  rejection: RejectedIdempotencyRecord,
  request: ReceiptUploadRequest,
): void {
  if (typeof rejection !== 'object' || rejection === null) {
    throw new TypeError('The prepared rejection is missing.');
  }
  if ((rejection as IdempotencyRecord).outcome !== 'REJECTED') {
    throw new TypeError('The prepared rejection must be a rejected request.');
  }
  // Rejects every record the idempotency codec refuses, with its fixed message.
  encodeIdempotencyItem(rejection);
  checkSameRequest(rejection, request);
  if (rejection.expiresAt < request.nowEpoch) {
    throw new RangeError('The idempotency record has already expired.');
  }
}

/**
 * The candidate is a codec-valid, unexpired pending receipt owned by the
 * actor, and the completed result is a codec-valid, unexpired 201 reference
 * naming it.
 */
function checkCandidate(
  pending: PendingReceiptRecord,
  completed: CompletedRequest,
  nowEpoch: number,
): void {
  if (!Number.isSafeInteger(nowEpoch) || nowEpoch < 0) {
    throw new RangeError('nowEpoch must be whole Unix epoch seconds.');
  }
  if (typeof pending !== 'object' || pending === null) {
    throw new TypeError('The pending receipt is missing.');
  }
  if (typeof completed !== 'object' || completed === null) {
    throw new TypeError('The completed request is missing.');
  }
  if ((pending as { state: string }).state !== 'PENDING') {
    throw new TypeError('The receipt must be pending.');
  }
  // Reject every record the codecs refuse, with their fixed messages.
  encodeReceiptItem(pending);
  encodeIdempotencyItem({ ...completed, outcome: 'COMPLETED' });
  // A record expiring exactly now is still present, as in the lookups.
  if (pending.expiresAt < nowEpoch || completed.expiresAt < nowEpoch) {
    throw new RangeError('The receipt upload has already expired.');
  }
  if (pending.ownerId !== completed.actorId) {
    throw new TypeError('The pending receipt is not owned by the actor.');
  }
  if (
    !isResultReference(completed.response) ||
    completed.response.resultRef.receiptId !== pending.receiptId
  ) {
    throw new TypeError(
      'The completed result must reference the pending receipt.',
    );
  }
}
