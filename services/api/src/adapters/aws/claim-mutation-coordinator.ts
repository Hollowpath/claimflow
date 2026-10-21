import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { idempotencyKeySchema, idSchema } from '@claimflow/contracts';

import {
  isResultReference,
  type CompletedRequest,
  type EpochSeconds,
} from '../../application/commit.js';
import type { DynamoDbIdempotencyCoordinator } from './dynamodb-idempotency-coordinator.js';
import {
  encodeIdempotencyItem,
  type IdempotencyRecord,
} from './dynamodb-idempotency-items.js';
import type { RejectedIdempotencyRecord } from './dynamodb-idempotency-writer.js';
import type { DynamoDbIdempotentTransactionCommitter } from './dynamodb-idempotent-transaction-committer.js';

/**
 * Runs one idempotent claim mutation (docs/aws-architecture.md, section 10,
 * steps 1 to 3 and 5) around a lazily prepared transaction or an explicitly
 * prepared business rejection. It looks the key up
 * first and, only when nothing is stored, calls the preparation callback
 * exactly once and commits what it returns through the idempotent committer.
 * The record that wins is returned intact, whether it is this request's
 * completed result or a concurrent request's, including a rejection. It
 * stores a rejection only when the preparation explicitly returns one, through
 * the idempotency coordinator (which owns the race handling), and never
 * guesses a response from a thrown error; it recovers no business state, retries nothing,
 * generates no ID or timestamp, logs nothing, and maps nothing to HTTP.
 * Errors from the preparation and from every dependency propagate unchanged.
 * Validation messages are fixed and name no supplied value.
 */

/** The lookup capability of the idempotency coordinator. */
export type MutationLookup = Pick<DynamoDbIdempotencyCoordinator, 'lookup'>;
/** The commit capability of the idempotent transaction committer. */
export type MutationCommitter = Pick<
  DynamoDbIdempotentTransactionCommitter,
  'commit'
>;

/** The rejection capability of the idempotency coordinator. */
export type MutationRejections = Pick<
  DynamoDbIdempotencyCoordinator,
  'recordRejection'
>;

export interface ClaimMutationCoordinatorOptions {
  readonly lookup: MutationLookup;
  readonly committer: MutationCommitter;
  readonly rejections: MutationRejections;
}

/** Who is acting, under which key, for which request, and at what time. */
export interface ClaimMutationRequest {
  readonly actorId: string;
  readonly key: string;
  /** SHA-256 hex of the request, as stored with the key. */
  readonly fingerprint: string;
  readonly nowEpoch: EpochSeconds;
}

/** The composed transaction and the completed result it stores. */
export interface PreparedClaimMutation {
  readonly transaction: TransactWriteCommandInput;
  readonly completed: CompletedRequest;
}

/** A business rejection, explicitly built by the preparation. */
export interface PreparedClaimRejection {
  readonly rejection: RejectedIdempotencyRecord;
}

export type PrepareClaimMutation = () => Promise<
  PreparedClaimMutation | PreparedClaimRejection
>;

const fingerprintPattern = /^[a-f0-9]{64}$/;

export class ClaimMutationCoordinator {
  private readonly lookup: MutationLookup;
  private readonly committer: MutationCommitter;
  private readonly rejections: MutationRejections;

  public constructor({
    lookup,
    committer,
    rejections,
  }: ClaimMutationCoordinatorOptions) {
    if (typeof lookup?.lookup !== 'function') {
      throw new TypeError('The idempotency lookup is missing.');
    }
    if (typeof committer?.commit !== 'function') {
      throw new TypeError('The transaction committer is missing.');
    }
    if (typeof rejections?.recordRejection !== 'function') {
      throw new TypeError('The rejection recorder is missing.');
    }
    this.lookup = lookup;
    this.committer = committer;
    this.rejections = rejections;
  }

  /**
   * A stored record for the key is returned without preparing anything (a
   * different fingerprint is a conflict). Otherwise the transaction is
   * prepared once and either committed once (a transaction) or stored once
   * (an explicit rejection).
   */
  public async run(
    request: ClaimMutationRequest,
    prepare: PrepareClaimMutation,
  ): Promise<IdempotencyRecord> {
    checkRequest(request, prepare);

    const existing = await this.lookup.lookup(
      request.actorId,
      request.key,
      request.fingerprint,
      request.nowEpoch,
    );
    if (existing !== undefined) {
      return existing;
    }

    const prepared = await prepare();
    if (checkPrepared(prepared, request) === 'rejection') {
      return this.rejections.recordRejection(
        (prepared as PreparedClaimRejection).rejection,
        request.nowEpoch,
      );
    }
    const mutation = prepared as PreparedClaimMutation;
    return this.committer.commit(
      mutation.transaction,
      mutation.completed,
      request.nowEpoch,
    );
  }
}

function checkRequest(
  request: ClaimMutationRequest,
  prepare: PrepareClaimMutation,
): void {
  if (typeof request !== 'object' || request === null) {
    throw new TypeError('The mutation request is missing.');
  }
  if (!idSchema.safeParse(request.actorId).success) {
    throw new TypeError('The actor ID is not valid.');
  }
  if (!idempotencyKeySchema.safeParse(request.key).success) {
    throw new TypeError('The idempotency key is not valid.');
  }
  if (
    typeof request.fingerprint !== 'string' ||
    !fingerprintPattern.test(request.fingerprint)
  ) {
    throw new TypeError('The request fingerprint is not valid.');
  }
  if (!Number.isSafeInteger(request.nowEpoch) || request.nowEpoch < 0) {
    throw new RangeError('nowEpoch must be whole Unix epoch seconds.');
  }
  if (typeof prepare !== 'function') {
    throw new TypeError('The mutation preparation is missing.');
  }
}

/**
 * The prepared result is exactly one of two shapes, each for this very
 * request: a codec-valid, unexpired response snapshot with its transaction
 * (the transaction itself is verified by the committer), or a codec-valid,
 * unexpired rejection. Returns which one it is.
 */
function checkPrepared(
  prepared: PreparedClaimMutation | PreparedClaimRejection,
  request: ClaimMutationRequest,
): 'mutation' | 'rejection' {
  if (typeof prepared !== 'object' || prepared === null) {
    throw new TypeError('The prepared mutation is missing.');
  }
  const shape = prepared as Partial<
    PreparedClaimMutation & PreparedClaimRejection
  >;
  const hasRejection = shape.rejection !== undefined;
  const hasMutation =
    shape.transaction !== undefined || shape.completed !== undefined;
  if (hasRejection && hasMutation) {
    throw new TypeError(
      'The prepared mutation mixes a rejection and a transaction.',
    );
  }
  if (hasRejection) {
    checkRejection(shape.rejection, request);
    return 'rejection';
  }
  checkMutation(prepared as PreparedClaimMutation, request);
  return 'mutation';
}

function checkRejection(
  rejection: unknown,
  request: ClaimMutationRequest,
): void {
  if (typeof rejection !== 'object' || rejection === null) {
    throw new TypeError('The prepared rejection is missing.');
  }
  const record = rejection as RejectedIdempotencyRecord;
  if ((record as IdempotencyRecord).outcome !== 'REJECTED') {
    throw new TypeError('The prepared rejection must be a rejected request.');
  }
  // Rejects every record the idempotency codec refuses, with its fixed message.
  encodeIdempotencyItem(record);
  if (
    record.actorId !== request.actorId ||
    record.key !== request.key ||
    record.fingerprint !== request.fingerprint
  ) {
    throw new TypeError('The prepared rejection is not for this request.');
  }
  // A record expiring exactly now is still present, as in the lookups.
  if (record.expiresAt < request.nowEpoch) {
    throw new RangeError('The idempotency record has already expired.');
  }
}

function checkMutation(
  prepared: PreparedClaimMutation,
  request: ClaimMutationRequest,
): void {
  const { transaction, completed } = prepared;
  if (typeof transaction !== 'object' || transaction === null) {
    throw new TypeError('The prepared transaction is missing.');
  }
  if (typeof completed !== 'object' || completed === null) {
    throw new TypeError('The completed request is missing.');
  }
  // Rejects every record the idempotency codec refuses, with its fixed message.
  encodeIdempotencyItem({ ...completed, outcome: 'COMPLETED' });
  if (
    completed.actorId !== request.actorId ||
    completed.key !== request.key ||
    completed.fingerprint !== request.fingerprint
  ) {
    throw new TypeError('The completed request is not for this request.');
  }
  // A record expiring exactly now is still present, as in the lookups.
  if (completed.expiresAt < request.nowEpoch) {
    throw new RangeError('The idempotency record has already expired.');
  }
  if (isResultReference(completed.response)) {
    throw new TypeError('A claim mutation stores a response snapshot.');
  }
}
