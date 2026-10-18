import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';

import {
  toEpochSeconds,
  type CompletedRequest,
} from '../../application/commit.js';
import type { OutboxEvent } from '../../application/events.js';
import {
  encodeIdempotencyItem,
  idempotencyWriteCondition,
} from './dynamodb-idempotency-items.js';
import { encodeOutboxItem, pendingState } from './dynamodb-outbox-items.js';
import { transactionRequestToken } from './transaction-token.js';

/**
 * Composes the common envelope of a business transaction
 * (docs/aws-architecture.md, sections 8 and 10): the business writes, then
 * one pending outbox `Put` per event, then the completed idempotency `Put`,
 * with a `ClientRequestToken` derived from that exact payload. It only builds
 * the input; it never sends a command. Business conditions and category
 * guards belong to the repository builders that supply the business items.
 */

/** One `TransactItems` entry. */
export type TransactionItem = NonNullable<
  TransactWriteCommandInput['TransactItems']
>[number];

export interface BusinessTransactionInput {
  readonly tableName: string;
  /** Claim, category, and receipt operations, in the order to apply them. */
  readonly businessItems: readonly TransactionItem[];
  /** Outbox events, in the order to write them. */
  readonly events: readonly OutboxEvent[];
  readonly completed: CompletedRequest;
}

/** `TransactWriteItems` accepts at most 100 operations. */
export const maxTransactionOperations = 100;

/** Outbox events are written once; a duplicate fails the transaction. */
export const outboxWriteCondition = 'attribute_not_exists(PK)';

/** A transaction that cannot be sent as composed. */
export class TransactionCompositionError extends Error {
  public constructor(problem: string) {
    super(`Cannot compose the transaction: ${problem}.`);
    this.name = 'TransactionCompositionError';
  }
}

const operationTypes = ['Put', 'Update', 'Delete', 'ConditionCheck'] as const;

export function composeBusinessTransaction({
  tableName,
  businessItems,
  events,
  completed,
}: BusinessTransactionInput): TransactWriteCommandInput {
  if (typeof tableName !== 'string' || tableName.length === 0) {
    throw new TransactionCompositionError('the table name is missing');
  }
  if (businessItems.length === 0) {
    throw new TransactionCompositionError('there are no business items');
  }

  const outboxItems: TransactionItem[] = events.map((event) => ({
    Put: {
      TableName: tableName,
      Item: encodeOutboxItem(event, pendingState),
      ConditionExpression: outboxWriteCondition,
    },
  }));
  const idempotencyItem: TransactionItem = {
    Put: {
      TableName: tableName,
      Item: encodeIdempotencyItem({ ...completed, outcome: 'COMPLETED' }),
      ConditionExpression: idempotencyWriteCondition,
      // The codec has validated `createdAt` as a canonical timestamp.
      ExpressionAttributeValues: {
        ':nowEpoch': toEpochSeconds(new Date(completed.createdAt)),
      },
    },
  };

  const TransactItems = [...businessItems, ...outboxItems, idempotencyItem];
  validateOperations(TransactItems, tableName);

  return {
    TransactItems,
    ClientRequestToken: transactionRequestToken({
      actorId: completed.actorId,
      idempotencyKey: completed.key,
      fingerprint: completed.fingerprint,
      transaction: { TransactItems },
    }),
  };
}

/**
 * At most 100 operations, each of exactly one supported type on the
 * supplied table, with a string `PK` and `SK`, and no item touched twice.
 * Problems are reported by operation position, never by key value.
 */
function validateOperations(
  items: readonly TransactionItem[],
  tableName: string,
): void {
  if (items.length > maxTransactionOperations) {
    throw new TransactionCompositionError(
      `it has ${items.length} operations; the limit is ${maxTransactionOperations}`,
    );
  }
  const targets = new Map<string, number>();
  items.forEach((item, index) => {
    const position = `operation ${index + 1}`;
    if (typeof item !== 'object' || item === null) {
      throw new TransactionCompositionError(`${position} is not an object`);
    }
    const kinds = Object.keys(item);
    const [kind] = kinds;
    if (
      kinds.length !== 1 ||
      !operationTypes.includes(kind as (typeof operationTypes)[number])
    ) {
      throw new TransactionCompositionError(
        `${position} must be exactly one of Put, Update, Delete, or ConditionCheck`,
      );
    }
    const operation = (item as Record<string, unknown>)[kind!];
    if (typeof operation !== 'object' || operation === null) {
      throw new TransactionCompositionError(`${position} has no parameters`);
    }
    const { TableName, Item, Key } = operation as Record<string, unknown>;
    if (TableName !== tableName) {
      throw new TransactionCompositionError(
        `${position} does not target the transaction's table`,
      );
    }
    const key = kind === 'Put' ? Item : Key;
    if (
      typeof key !== 'object' ||
      key === null ||
      (kind !== 'Put' &&
        (Object.keys(key).length !== 2 || !('PK' in key) || !('SK' in key)))
    ) {
      throw new TransactionCompositionError(
        `${position} must name an item by exactly PK and SK`,
      );
    }
    const { PK, SK } = key as Record<string, unknown>;
    if (
      typeof PK !== 'string' ||
      typeof SK !== 'string' ||
      PK.length === 0 ||
      SK.length === 0
    ) {
      throw new TransactionCompositionError(
        `${position} must have non-empty string PK and SK values`,
      );
    }
    const target = JSON.stringify([PK, SK]);
    const earlier = targets.get(target);
    if (earlier !== undefined) {
      throw new TransactionCompositionError(
        `${position} touches the same item as operation ${earlier + 1}`,
      );
    }
    targets.set(target, index);
  });
}
