import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';

import type {
  CommitOptions,
  CompletedRequest,
} from '../../application/commit.js';
import { createPendingReceiptOperation } from './dynamodb-receipt-operations.js';
import type { PendingReceiptRecord } from './dynamodb-receipt-items.js';
import type { DynamoDbTransactionExecutor } from './dynamodb-transaction-executor.js';
import { composeBusinessTransaction } from './dynamodb-transaction.js';

/**
 * Creates the metadata of a pending receipt upload
 * (docs/aws-architecture.md, sections 8, 10, 11, and 18, access pattern R1).
 * It builds the pending receipt `Put`, composes it with the completed
 * idempotency record, and sends the result once through the executor. Creating
 * an upload target publishes no event and has no category guard, so events
 * must be empty and a guard is refused. It performs no S3 operation and
 * inspects no cancellation reason, retries nothing, and rereads nothing:
 * every executor and SDK error propagates unchanged. Attachment, replacement,
 * and removal are committed with their claim mutation instead. Validation
 * errors are fixed messages that name no supplied or stored value.
 */

/** The one executor method the writer uses. */
export type ReceiptTransactionExecutor = Pick<
  DynamoDbTransactionExecutor,
  'execute'
>;

export interface DynamoDbReceiptUploadWriterOptions {
  readonly executor: ReceiptTransactionExecutor;
  readonly tableName: string;
}

export class DynamoDbReceiptUploadWriter {
  private readonly executor: ReceiptTransactionExecutor;
  private readonly tableName: string;

  public constructor({
    executor,
    tableName,
  }: DynamoDbReceiptUploadWriterOptions) {
    if (typeof executor?.execute !== 'function') {
      throw new TypeError('The transaction executor is missing.');
    }
    if (typeof tableName !== 'string' || tableName.length === 0) {
      throw new TypeError('The table name is missing.');
    }
    this.executor = executor;
    this.tableName = tableName;
  }

  /**
   * R1: the pending receipt, then the completed idempotency record, in one
   * transaction. The record is validated by the receipt codec.
   */
  public async createPending(
    record: PendingReceiptRecord,
    options: CommitOptions,
  ): Promise<void> {
    await this.executor.execute(this.preparePending(record, options));
  }

  /**
   * The composed transaction of `createPending`, without sending it, for an
   * orchestration that commits it through the idempotent committer. Every
   * validation of `createPending` happens here, synchronously.
   */
  public preparePending(
    record: PendingReceiptRecord,
    options: CommitOptions,
  ): TransactWriteCommandInput {
    const completed = checkOptions(options);
    return composeBusinessTransaction({
      tableName: this.tableName,
      businessItems: [createPendingReceiptOperation(this.tableName, record)],
      events: [],
      completed,
    });
  }
}

/** The idempotency record to commit; everything else is validated downstream. */
function checkOptions(options: CommitOptions): CompletedRequest {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('The commit options are missing.');
  }
  if (!Array.isArray(options.events)) {
    throw new TypeError('The commit options must list their events.');
  }
  if (options.events.length > 0) {
    throw new TypeError('A receipt upload publishes no events.');
  }
  if (options.categoryGuard !== undefined) {
    throw new TypeError('A receipt upload cannot carry a category guard.');
  }
  if (options.idempotency === undefined) {
    throw new TypeError('A receipt upload requires an idempotency record.');
  }
  return options.idempotency;
}
