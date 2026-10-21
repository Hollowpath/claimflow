import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';

import {
  toEpochSeconds,
  type CompletedRequest,
  type EpochSeconds,
} from '../../application/commit.js';
import type { DynamoDbIdempotencyCoordinator } from './dynamodb-idempotency-coordinator.js';
import {
  encodeIdempotencyItem,
  idempotencyKey,
  idempotencyWriteCondition,
  type IdempotencyRecord,
} from './dynamodb-idempotency-items.js';
import type { DynamoDbTransactionExecutor } from './dynamodb-transaction-executor.js';
import { canonicalJson, transactionRequestToken } from './transaction-token.js';

/**
 * Commits one composed business transaction and establishes its outcome
 * through the idempotency record (docs/aws-architecture.md, section 10:
 * "Other DynamoDB errors" and "Ambiguous failures"). It sends the supplied
 * transaction once; after a cancellation it only looks the record up; after
 * an ambiguous failure it looks the record up, retries the identical
 * transaction (same items, same `ClientRequestToken`) at most once, and
 * looks the record up a final time if that retry fails the same way. It
 * never rebuilds a transaction, generates an ID or timestamp, inspects
 * cancellation reasons, recovers business state, logs, or maps errors to
 * HTTP. Errors are classified by SDK error name or structured transport
 * code, never by message. Winners are returned as stored, whether completed,
 * rejected, or a result reference; a fingerprint conflict and every lookup
 * error propagate unchanged. Validation messages are fixed and carry no
 * supplied value.
 */

/** The one executor method the committer uses. */
export type CommitExecutor = Pick<DynamoDbTransactionExecutor, 'execute'>;

/** The one coordinator method the committer uses. */
export type IdempotencyLookup = Pick<DynamoDbIdempotencyCoordinator, 'lookup'>;

export interface DynamoDbIdempotentTransactionCommitterOptions {
  readonly executor: CommitExecutor;
  readonly lookup: IdempotencyLookup;
}

/** The cancellation that enters recovery; reasons are never inspected. */
const cancellationName = 'TransactionCanceledException';

/**
 * Failures that do not prove whether the transaction committed (section 10):
 * internal errors, service unavailability, timeouts, lost connections, and
 * throttling that outlasted the SDK's own retries.
 */
const ambiguousNames: ReadonlySet<string> = new Set([
  'InternalServerError',
  'ServiceUnavailable',
  'ServiceUnavailableException',
  'ThrottlingException',
  'ProvisionedThroughputExceededException',
  'RequestLimitExceeded',
  'TimeoutError',
  'RequestTimeout',
]);
const ambiguousCodes: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
]);

export class DynamoDbIdempotentTransactionCommitter {
  private readonly executor: CommitExecutor;
  private readonly lookup: IdempotencyLookup;

  public constructor({
    executor,
    lookup,
  }: DynamoDbIdempotentTransactionCommitterOptions) {
    if (typeof executor?.execute !== 'function') {
      throw new TypeError('The transaction executor is missing.');
    }
    if (typeof lookup?.lookup !== 'function') {
      throw new TypeError('The idempotency lookup is missing.');
    }
    this.executor = executor;
    this.lookup = lookup;
  }

  /**
   * Returns the `COMPLETED` record of `completed` when the transaction
   * commits, or the stored winner (any outcome) when a concurrent or earlier
   * request with the same key and fingerprint got there first.
   */
  public async commit(
    transaction: TransactWriteCommandInput,
    completed: CompletedRequest,
    nowEpoch: EpochSeconds,
  ): Promise<IdempotencyRecord> {
    const record = checkCommit(transaction, completed, nowEpoch);

    try {
      await this.executor.execute(transaction);
      return record;
    } catch (first) {
      if (isCancellation(first)) {
        const winner = await this.find(completed, nowEpoch);
        if (winner !== undefined) {
          return winner;
        }
        throw first;
      }
      if (!isAmbiguous(first)) {
        throw first;
      }
    }

    const winner = await this.find(completed, nowEpoch);
    if (winner !== undefined) {
      return winner;
    }
    try {
      await this.executor.execute(transaction);
      return record;
    } catch (retry) {
      if (!isCancellation(retry) && !isAmbiguous(retry)) {
        throw retry;
      }
      const final = await this.find(completed, nowEpoch);
      if (final !== undefined) {
        return final;
      }
      throw retry;
    }
  }

  private find(
    completed: CompletedRequest,
    nowEpoch: EpochSeconds,
  ): Promise<IdempotencyRecord | undefined> {
    return this.lookup.lookup(
      completed.actorId,
      completed.key,
      completed.fingerprint,
      nowEpoch,
    );
  }
}

function errorField(
  error: unknown,
  field: 'name' | 'code',
): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const value = (error as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

function isCancellation(error: unknown): boolean {
  return errorField(error, 'name') === cancellationName;
}

function isAmbiguous(error: unknown): boolean {
  const name = errorField(error, 'name');
  const code = errorField(error, 'code');
  return (
    (name !== undefined && ambiguousNames.has(name)) ||
    (code !== undefined && ambiguousCodes.has(code))
  );
}

/**
 * The transaction is exactly the composed input: its last item is the
 * completed idempotency `Put` of `completed`, and its request token is the one
 * derived from its items. Returns the record that a success stores.
 */
function checkCommit(
  transaction: TransactWriteCommandInput,
  completed: CompletedRequest,
  nowEpoch: number,
): IdempotencyRecord {
  if (!Number.isSafeInteger(nowEpoch) || nowEpoch < 0) {
    throw new RangeError('nowEpoch must be whole Unix epoch seconds.');
  }
  if (typeof transaction !== 'object' || transaction === null) {
    throw new TypeError('The transaction is missing.');
  }
  if (typeof completed !== 'object' || completed === null) {
    throw new TypeError('The completed request is missing.');
  }
  const { TransactItems, ClientRequestToken, ...rest } = transaction;
  if (
    Object.keys(rest).length > 0 ||
    !Array.isArray(TransactItems) ||
    TransactItems.length === 0 ||
    typeof ClientRequestToken !== 'string'
  ) {
    throw new TypeError('The transaction is not a composed transaction.');
  }

  const record: IdempotencyRecord = { ...completed, outcome: 'COMPLETED' };
  // Rejects every record the idempotency codec refuses, with its fixed message.
  const item = encodeIdempotencyItem(record);
  // A record expiring exactly now is still present, as in the lookup and the
  // rejection writer.
  if (completed.expiresAt < nowEpoch) {
    throw new RangeError('The idempotency record has already expired.');
  }

  const last = TransactItems[TransactItems.length - 1]?.Put;
  const key = idempotencyKey(completed.actorId, completed.key);
  let matches: boolean;
  try {
    matches =
      last !== undefined &&
      Object.keys(TransactItems[TransactItems.length - 1]!).length === 1 &&
      canonicalJson(last.Item) === canonicalJson(item) &&
      last.Item?.PK === key.PK &&
      last.ConditionExpression === idempotencyWriteCondition &&
      canonicalJson(last.ExpressionAttributeValues) ===
        canonicalJson({
          ':nowEpoch': toEpochSeconds(new Date(completed.createdAt)),
        });
  } catch {
    matches = false;
  }
  if (!matches) {
    throw new TypeError(
      'The transaction does not end with the completed idempotency record.',
    );
  }

  let token: string;
  try {
    token = transactionRequestToken({
      actorId: completed.actorId,
      idempotencyKey: completed.key,
      fingerprint: completed.fingerprint,
      transaction: { TransactItems },
    });
  } catch {
    throw new TypeError('The transaction request token cannot be verified.');
  }
  if (token !== ClientRequestToken) {
    throw new TypeError('The transaction request token is not correct.');
  }
  return record;
}
