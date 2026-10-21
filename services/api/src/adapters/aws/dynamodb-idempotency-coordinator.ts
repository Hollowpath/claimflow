import { idempotencyKeySchema, idSchema } from '@claimflow/contracts';

import type { EpochSeconds } from '../../application/commit.js';
import { IdempotencyConflictError } from '../../application/errors.js';
import {
  encodeIdempotencyItem,
  type IdempotencyRecord,
} from './dynamodb-idempotency-items.js';
import type {
  DynamoDbRejectionWriter,
  RejectedIdempotencyRecord,
} from './dynamodb-idempotency-writer.js';
import type { DynamoDbIdempotencyReader } from './dynamodb-lookups.js';

/**
 * The first part of the AWS idempotency orchestration
 * (docs/aws-architecture.md, section 10, steps 1 and 5): the preflight lookup
 * and the persistence of a business rejection with its race handling. It only
 * combines the idempotency reader's `find` and the rejection writer's
 * `recordRejection`; it executes no domain logic, commits no transaction,
 * recovers from no cancellation, retries nothing, keeps no in-progress state,
 * reads no clock, generates no ID, and logs nothing. Stored records are
 * returned as stored: a record is not assumed to be a permanent HTTP response
 * snapshot, because receipt-upload results will store a reference instead.
 * Messages are fixed and name no supplied or stored value; dependency errors
 * propagate unchanged.
 */

/** The reader capability the coordinator uses. */
export type IdempotencyFinder = Pick<DynamoDbIdempotencyReader, 'find'>;

/** The writer capability the coordinator uses. */
export type RejectionRecorder = Pick<
  DynamoDbRejectionWriter,
  'recordRejection'
>;

export interface DynamoDbIdempotencyCoordinatorOptions {
  readonly finder: IdempotencyFinder;
  readonly rejections: RejectionRecorder;
}

const fingerprintPattern = /^[a-f0-9]{64}$/;
const conflictMessage =
  'This idempotency key was already used for a different request.';

export class DynamoDbIdempotencyCoordinator {
  private readonly finder: IdempotencyFinder;
  private readonly rejections: RejectionRecorder;

  public constructor({
    finder,
    rejections,
  }: DynamoDbIdempotencyCoordinatorOptions) {
    if (typeof finder?.find !== 'function') {
      throw new TypeError('The idempotency finder is missing.');
    }
    if (typeof rejections?.recordRejection !== 'function') {
      throw new TypeError('The rejection recorder is missing.');
    }
    this.finder = finder;
    this.rejections = rejections;
  }

  /**
   * Step 1: one strongly consistent lookup. An absent or expired record is
   * `undefined`; a record with the same fingerprint is returned to be
   * replayed; a record with another fingerprint is an idempotency conflict.
   */
  public async lookup(
    actorId: string,
    key: string,
    fingerprint: string,
    nowEpoch: EpochSeconds,
  ): Promise<IdempotencyRecord | undefined> {
    checkIdentity(actorId, key, nowEpoch);
    checkFingerprint(fingerprint);
    const found = await this.finder.find(actorId, key, nowEpoch);
    return resolve(found, fingerprint);
  }

  /**
   * Step 5: one conditional write of the rejection. If a record already
   * exists (a `ConditionalCheckFailedException`, identified by the SDK error
   * name), the record is reread once, strongly consistent: the winner is
   * returned for the same fingerprint, whether it completed or was rejected,
   * and another fingerprint is an idempotency conflict. If no unexpired
   * record is found, the original conditional failure is rethrown unchanged.
   */
  public async recordRejection(
    record: RejectedIdempotencyRecord,
    nowEpoch: EpochSeconds,
  ): Promise<IdempotencyRecord> {
    checkRejection(record, nowEpoch);
    try {
      await this.rejections.recordRejection(record, nowEpoch);
      return record;
    } catch (error) {
      if (!isConditionalCheckFailure(error)) {
        throw error;
      }
      const winner = await this.finder.find(
        record.actorId,
        record.key,
        nowEpoch,
      );
      const resolved = resolve(winner, record.fingerprint);
      if (resolved === undefined) {
        throw error;
      }
      return resolved;
    }
  }
}

/** Same fingerprint: the stored record; another fingerprint: a conflict. */
function resolve(
  found: IdempotencyRecord | undefined,
  fingerprint: string,
): IdempotencyRecord | undefined {
  if (found === undefined) {
    return undefined;
  }
  if (found.fingerprint !== fingerprint) {
    throw new IdempotencyConflictError(conflictMessage);
  }
  return found;
}

/** The SDK's error type, not its message. */
function isConditionalCheckFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'ConditionalCheckFailedException'
  );
}

function checkIdentity(actorId: string, key: string, nowEpoch: number): void {
  if (!idSchema.safeParse(actorId).success) {
    throw new TypeError('The actor ID is not valid.');
  }
  if (!idempotencyKeySchema.safeParse(key).success) {
    throw new TypeError('The idempotency key is not valid.');
  }
  checkTime(nowEpoch);
}

function checkTime(nowEpoch: number): void {
  if (!Number.isSafeInteger(nowEpoch) || nowEpoch < 0) {
    throw new RangeError('nowEpoch must be whole Unix epoch seconds.');
  }
}

function checkFingerprint(fingerprint: string): void {
  if (
    typeof fingerprint !== 'string' ||
    !fingerprintPattern.test(fingerprint)
  ) {
    throw new TypeError('The request fingerprint is not valid.');
  }
}

/** The record the rejection writer would store, checked before any call. */
function checkRejection(
  record: RejectedIdempotencyRecord,
  nowEpoch: number,
): void {
  checkTime(nowEpoch);
  if (typeof record !== 'object' || record === null) {
    throw new TypeError('The rejection record is missing.');
  }
  if ((record as IdempotencyRecord).outcome !== 'REJECTED') {
    throw new TypeError('Only a rejected request can be stored here.');
  }
  // Rejects every record the idempotency codec refuses, with its fixed message.
  encodeIdempotencyItem(record);
  if (record.expiresAt < nowEpoch) {
    throw new RangeError('The idempotency record has already expired.');
  }
}
