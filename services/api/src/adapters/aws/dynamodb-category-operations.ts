import { idSchema } from '@claimflow/contracts';
import type { Category } from '@claimflow/domain';

import type { CategoryGuard } from '../../application/commit.js';
import { categoryKey, encodeCategoryItem } from './dynamodb-items.js';
import type { TransactionItem } from './dynamodb-transaction.js';

/**
 * Pure builders for category operations inside a business transaction
 * (docs/aws-architecture.md, sections 8 and 9). They return
 * `TransactionItem` values for the transaction composer and never send a
 * command. Category values are validated by the category codec.
 */

/** Never overwrite an existing category. */
export const categoryCreateCondition = 'attribute_not_exists(PK)';

/** Optimistic concurrency for administrator changes. */
export const categoryVersionCondition = '#version = :expectedVersion';

/** A category still in use, or changed since it was read, is never deleted. */
export const categoryDeleteCondition =
  '#version = :expectedVersion AND (attribute_not_exists(claimCount) OR claimCount = :zero)';

/** The policy the claim was checked against is unchanged and active. */
export const categoryGuardCondition =
  '#version = :readVersion AND #active = :true';

/** The category exists and its counter cannot go below zero. */
export const claimCountDecrementCondition =
  'attribute_exists(PK) AND claimCount >= :one';

/** A category operation that cannot be built from its inputs. */
export class CategoryOperationError extends Error {
  public constructor(problem: string) {
    super(`Cannot build the category operation: ${problem}.`);
    this.name = 'CategoryOperationError';
  }
}

/**
 * `Put` of a new category at version 1, unused, with its creation as the
 * latest publishable event.
 */
export function createCategoryOperation(
  tableName: string,
  category: Category,
): TransactionItem {
  checkTable(tableName);
  if (category.version !== 1) {
    throw new CategoryOperationError('a new category must be at version 1');
  }
  return {
    Put: {
      TableName: tableName,
      Item: encodeCategoryItem(category, {
        claimCount: 0,
        lastEventVersion: category.version,
      }),
      ConditionExpression: categoryCreateCondition,
    },
  };
}

/**
 * `Update` of an administrator change at `expectedVersion`. It sets every
 * mutable field, the new version, and `lastEventVersion`, and leaves
 * `claimCount`, `createdAt`, and the keys alone, so a concurrent counter
 * change is never overwritten.
 */
export function updateCategoryOperation(
  tableName: string,
  category: Category,
  expectedVersion: number,
): TransactionItem {
  checkTable(tableName);
  checkVersion(expectedVersion, 'expectedVersion');
  if (category.version !== expectedVersion + 1) {
    throw new CategoryOperationError(
      'the category version must be one more than expectedVersion',
    );
  }
  // Validates every category value; claimCount is not written.
  encodeCategoryItem(category, {
    claimCount: 0,
    lastEventVersion: category.version,
  });
  return {
    Update: {
      TableName: tableName,
      Key: categoryKey(category.categoryId),
      UpdateExpression:
        'SET #name = :name, #active = :active, #currency = :currency, ' +
        '#maxAmountMinor = :maxAmountMinor, ' +
        '#receiptRequiredAboveMinor = :receiptRequiredAboveMinor, ' +
        '#version = :version, #updatedAt = :updatedAt, ' +
        '#updatedBy = :updatedBy, #lastEventVersion = :lastEventVersion',
      ConditionExpression: categoryVersionCondition,
      ExpressionAttributeNames: {
        '#name': 'name',
        '#active': 'active',
        '#currency': 'currency',
        '#maxAmountMinor': 'maxAmountMinor',
        '#receiptRequiredAboveMinor': 'receiptRequiredAboveMinor',
        '#version': 'version',
        '#updatedAt': 'updatedAt',
        '#updatedBy': 'updatedBy',
        '#lastEventVersion': 'lastEventVersion',
      },
      ExpressionAttributeValues: {
        ':name': category.name,
        ':active': category.active,
        ':currency': category.currency,
        ':maxAmountMinor': category.maxAmountMinor,
        ':receiptRequiredAboveMinor': category.receiptRequiredAboveMinor,
        ':version': category.version,
        ':updatedAt': category.updatedAt,
        ':updatedBy': category.updatedBy,
        ':lastEventVersion': category.version,
        ':expectedVersion': expectedVersion,
      },
    },
  };
}

/** `Delete` at `expectedVersion`, only while no claim uses the category. */
export function deleteCategoryOperation(
  tableName: string,
  categoryId: string,
  expectedVersion: number,
): TransactionItem {
  checkTable(tableName);
  checkCategoryId(categoryId);
  checkVersion(expectedVersion, 'expectedVersion');
  return {
    Delete: {
      TableName: tableName,
      Key: categoryKey(categoryId),
      ConditionExpression: categoryDeleteCondition,
      ExpressionAttributeNames: { '#version': 'version' },
      ExpressionAttributeValues: {
        ':expectedVersion': expectedVersion,
        ':zero': 0,
      },
    },
  };
}

/**
 * `ADD claimCount 1` for a claim that starts using the category, guarded by
 * the version and active state the claim was checked against. It changes
 * neither `version` nor `lastEventVersion`.
 */
export function incrementClaimCountOperation(
  tableName: string,
  guard: CategoryGuard,
): TransactionItem {
  checkTable(tableName);
  checkGuard(guard);
  return {
    Update: {
      TableName: tableName,
      Key: categoryKey(guard.categoryId),
      UpdateExpression: 'ADD claimCount :one',
      ConditionExpression: categoryGuardCondition,
      ExpressionAttributeNames: { '#version': 'version', '#active': 'active' },
      ExpressionAttributeValues: {
        ':one': 1,
        ':readVersion': guard.readVersion,
        ':true': true,
      },
    },
  };
}

/**
 * `ADD claimCount -1` for a claim that stops using the category. The
 * condition stops `ADD` from creating a missing category or going below
 * zero. It changes neither `version` nor `lastEventVersion`.
 */
export function decrementClaimCountOperation(
  tableName: string,
  categoryId: string,
): TransactionItem {
  checkTable(tableName);
  checkCategoryId(categoryId);
  return {
    Update: {
      TableName: tableName,
      Key: categoryKey(categoryId),
      UpdateExpression: 'ADD claimCount :minusOne',
      ConditionExpression: claimCountDecrementCondition,
      ExpressionAttributeValues: { ':minusOne': -1, ':one': 1 },
    },
  };
}

/**
 * The category guard as a separate `ConditionCheck`, for submission and
 * resubmission. Use it only when no counter operation in the same
 * transaction touches the category, because an item may be touched once.
 */
export function categoryGuardCheckOperation(
  tableName: string,
  guard: CategoryGuard,
): TransactionItem {
  checkTable(tableName);
  checkGuard(guard);
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: categoryKey(guard.categoryId),
      ConditionExpression: categoryGuardCondition,
      ExpressionAttributeNames: { '#version': 'version', '#active': 'active' },
      ExpressionAttributeValues: {
        ':readVersion': guard.readVersion,
        ':true': true,
      },
    },
  };
}

function checkTable(tableName: string): void {
  if (typeof tableName !== 'string' || tableName.length === 0) {
    throw new CategoryOperationError('the table name is missing');
  }
}

function checkCategoryId(categoryId: string): void {
  if (!idSchema.safeParse(categoryId).success) {
    throw new CategoryOperationError('the category ID is not valid');
  }
}

/** A safe positive integer; versions start at 1. */
function checkVersion(version: number, name: string): void {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new CategoryOperationError(`${name} must be a positive whole number`);
  }
}

/**
 * Every guard in the approved design requires an active category, so a
 * guard without that requirement is refused rather than reinterpreted.
 */
function checkGuard(guard: CategoryGuard): void {
  checkCategoryId(guard.categoryId);
  checkVersion(guard.readVersion, 'readVersion');
  if (guard.mustBeActive !== true) {
    throw new CategoryOperationError(
      'category guards on claim writes must require an active category',
    );
  }
}
