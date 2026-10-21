import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import type { Category } from '@claimflow/domain';

import type {
  CompletedRequest,
  CommitOptions,
} from '../../application/commit.js';
import {
  createCategoryOperation,
  deleteCategoryOperation,
  updateCategoryOperation,
} from './dynamodb-category-operations.js';
import type { DynamoDbTransactionExecutor } from './dynamodb-transaction-executor.js';
import {
  composeBusinessTransaction,
  type TransactionItem,
} from './dynamodb-transaction.js';

/**
 * The write side of the DynamoDB category repository
 * (docs/aws-architecture.md, sections 8 to 10 and 18). Each method builds the
 * category operation, composes it with the outbox events and the completed
 * idempotency record into one transaction, and sends that transaction
 * through the executor. It inspects no cancellation reason, retries nothing,
 * and rereads nothing: every error propagates unchanged for the idempotency
 * orchestration. Validation errors are fixed messages that name no value.
 * Category administration is an idempotent HTTP operation without a claim-write
 * category guard, so an idempotency record is required and a guard refused.
 */

/** The one executor method the writer uses. */
export type CategoryTransactionExecutor = Pick<
  DynamoDbTransactionExecutor,
  'execute'
>;

export interface DynamoDbCategoryWriterOptions {
  readonly executor: CategoryTransactionExecutor;
  readonly tableName: string;
}

export class DynamoDbCategoryWriter {
  private readonly executor: CategoryTransactionExecutor;
  private readonly tableName: string;

  public constructor({ executor, tableName }: DynamoDbCategoryWriterOptions) {
    if (typeof executor?.execute !== 'function') {
      throw new TypeError('The transaction executor is missing.');
    }
    if (typeof tableName !== 'string' || tableName.length === 0) {
      throw new TypeError('The table name is missing.');
    }
    this.executor = executor;
    this.tableName = tableName;
  }

  /** C3: a new category at version 1, with its creation event. */
  public async create(
    category: Category,
    options: CommitOptions,
  ): Promise<void> {
    await this.executor.execute(this.prepareCreate(category, options));
  }

  /** The composed transaction of `create`, without sending it. */
  public prepareCreate(
    category: Category,
    options: CommitOptions,
  ): TransactWriteCommandInput {
    const completed = checkOptions(options);
    return this.compose(
      [createCategoryOperation(this.tableName, category)],
      options,
      completed,
    );
  }

  /**
   * C4: an administrator change at `expectedVersion`. Only a change that
   * publishes an event records it as the latest event version, so a
   * name-only change keeps `lastEventVersion`.
   */
  public async update(
    category: Category,
    expectedVersion: number,
    options: CommitOptions,
  ): Promise<void> {
    await this.executor.execute(
      this.prepareUpdate(category, expectedVersion, options),
    );
  }

  /** The composed transaction of `update`, without sending it. */
  public prepareUpdate(
    category: Category,
    expectedVersion: number,
    options: CommitOptions,
  ): TransactWriteCommandInput {
    const completed = checkOptions(options);
    return this.compose(
      [
        updateCategoryOperation(
          this.tableName,
          category,
          expectedVersion,
          options.events.length > 0,
        ),
      ],
      options,
      completed,
    );
  }

  /** C5: deletion at `expectedVersion`, only while no claim uses the category. */
  public async delete(
    categoryId: string,
    expectedVersion: number,
    options: CommitOptions,
  ): Promise<void> {
    await this.executor.execute(
      this.prepareDelete(categoryId, expectedVersion, options),
    );
  }

  /** The composed transaction of `delete`, without sending it. */
  public prepareDelete(
    categoryId: string,
    expectedVersion: number,
    options: CommitOptions,
  ): TransactWriteCommandInput {
    const completed = checkOptions(options);
    return this.compose(
      [deleteCategoryOperation(this.tableName, categoryId, expectedVersion)],
      options,
      completed,
    );
  }

  private compose(
    businessItems: readonly TransactionItem[],
    options: CommitOptions,
    completed: CompletedRequest,
  ): TransactWriteCommandInput {
    return composeBusinessTransaction({
      tableName: this.tableName,
      businessItems,
      events: options.events,
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
  if (options.categoryGuard !== undefined) {
    throw new TypeError('A category change cannot carry a category guard.');
  }
  if (options.idempotency === undefined) {
    throw new TypeError('A category change requires an idempotency record.');
  }
  return options.idempotency;
}
