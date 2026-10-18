import { idSchema } from '@claimflow/contracts';
import {
  claimHistoryActions,
  claimTransitions,
  type Claim,
  type ClaimAction,
  type ClaimChange,
  type ClaimHistoryAction,
} from '@claimflow/domain';

import { isPublishableAction } from '../../application/claim-events.js';
import {
  claimAttributeNames,
  claimKey,
  encodeClaimItem,
  encodeHistoryItem,
} from './dynamodb-items.js';
import type { TransactionItem } from './dynamodb-transaction.js';

/**
 * Pure builders for claim and history operations inside a business
 * transaction (docs/aws-architecture.md, sections 8, 9, and 12). They return
 * `TransactionItem` values for the transaction composer and never send a
 * command. Claims and history entries are validated by their codecs.
 */

/** Claims and history entries are written once. */
export const claimCreateCondition = 'attribute_not_exists(PK)';
export const historyCreateCondition = 'attribute_not_exists(PK)';

/** Owner operations: the write itself refuses anyone but the employee. */
export const claimOwnerCondition =
  '#version = :expectedVersion AND #employeeId = :actorId';

/** Review operations: the write refuses anyone but the assigned manager. */
export const claimManagerCondition =
  '#version = :expectedVersion AND #assignedManagerId = :actorId';

/** Payment: administrator authorization is decided by the application. */
export const claimVersionCondition = '#version = :expectedVersion';

/** A draft that was never submitted, still owned and unchanged. */
export const draftDeleteCondition =
  '#version = :expectedVersion AND #employeeId = :actorId AND #status = :draft AND attribute_not_exists(#submittedAt)';

type UpdateAction = Exclude<ClaimHistoryAction, 'CREATE'>;
type ActorRule = 'owner' | 'manager' | 'version';

/** Who the write condition requires the actor to be, for every action. */
const actorRules: Readonly<Record<UpdateAction, ActorRule>> = {
  UPDATE: 'owner',
  ATTACH_RECEIPT: 'owner',
  REPLACE_RECEIPT: 'owner',
  REMOVE_RECEIPT: 'owner',
  SUBMIT: 'owner',
  REOPEN: 'owner',
  START_REVIEW: 'manager',
  APPROVE: 'manager',
  REJECT: 'manager',
  MARK_PAID: 'version',
};

const actorConditions: Readonly<Record<ActorRule, string>> = {
  owner: claimOwnerCondition,
  manager: claimManagerCondition,
  version: claimVersionCondition,
};

/** A claim operation that cannot be built from its inputs. */
export class ClaimOperationError extends Error {
  public constructor(problem: string) {
    super(`Cannot build the claim operation: ${problem}.`);
    this.name = 'ClaimOperationError';
  }
}

/**
 * The new claim's `Put` and its first history entry's `Put`, both written
 * only if absent. Creation is not published, so there is no
 * `lastEventVersion`.
 */
export function createClaimOperations(
  tableName: string,
  { claim, history }: ClaimChange,
): [TransactionItem, TransactionItem] {
  checkTable(tableName);
  if (history.action !== 'CREATE') {
    throw new ClaimOperationError('a new claim needs a CREATE history entry');
  }
  if (claim.version !== 1) {
    throw new ClaimOperationError('a new claim must be at version 1');
  }
  // Every claim starts as a draft (`createDraftClaim`).
  if (claim.status !== 'DRAFT') {
    throw new ClaimOperationError('a new claim must be a DRAFT');
  }
  checkHistoryMatches({ claim, history });
  if (history.fromStatus !== undefined) {
    throw new ClaimOperationError('a CREATE entry has no previous status');
  }
  if (history.toStatus !== 'DRAFT') {
    throw new ClaimOperationError('a CREATE entry must result in DRAFT');
  }
  return [
    {
      Put: {
        TableName: tableName,
        Item: encodeClaimItem(claim),
        ConditionExpression: claimCreateCondition,
      },
    },
    historyPut(tableName, history),
  ];
}

/**
 * An `Update` that brings the stored claim to the codec-encoded shape of the
 * new claim, at `expectedVersion` and guarded by who may act, followed by the
 * new history entry's `Put`. A publishable action records the new version
 * as `lastEventVersion`; any other action keeps the stored value.
 */
export function updateClaimOperations(
  tableName: string,
  { claim, history }: ClaimChange,
  expectedVersion: number,
  storedLastEventVersion: number | undefined,
): [TransactionItem, TransactionItem] {
  checkTable(tableName);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw new ClaimOperationError(
      'expectedVersion must be a positive whole number',
    );
  }
  if (!Number.isSafeInteger(expectedVersion + 1)) {
    throw new ClaimOperationError('the next version would not be exact');
  }
  // Read from the claim at `expectedVersion`, so it cannot be newer than that
  // version, whether or not this action replaces it.
  if (
    storedLastEventVersion !== undefined &&
    (!Number.isSafeInteger(storedLastEventVersion) ||
      storedLastEventVersion < 0 ||
      storedLastEventVersion > expectedVersion)
  ) {
    throw new ClaimOperationError(
      'storedLastEventVersion must be a whole number from 0 to expectedVersion',
    );
  }
  if (claim.version !== expectedVersion + 1) {
    throw new ClaimOperationError(
      'the claim version must be one more than expectedVersion',
    );
  }
  checkHistoryMatches({ claim, history });

  const action = history.action;
  if (
    !(claimHistoryActions as readonly string[]).includes(action) ||
    action === 'CREATE'
  ) {
    throw new ClaimOperationError('the history action cannot update a claim');
  }
  checkTransition(action, history.fromStatus, history.toStatus);

  const lastEventVersion = isPublishableAction(action)
    ? claim.version
    : storedLastEventVersion;
  const item = encodeClaimItem(
    claim,
    lastEventVersion === undefined ? {} : { lastEventVersion },
  );

  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const set: string[] = [];
  const remove: string[] = [];
  for (const name of claimAttributeNames) {
    if (name === 'PK' || name === 'SK') {
      continue;
    }
    names[`#${name}`] = name;
    if (item[name] === undefined) {
      remove.push(`#${name}`);
    } else {
      set.push(`#${name} = :${name}`);
      values[`:${name}`] = item[name];
    }
  }

  const rule = actorRules[action];
  values[':expectedVersion'] = expectedVersion;
  if (rule !== 'version') {
    values[':actorId'] = history.actorId;
  }

  return [
    {
      Update: {
        TableName: tableName,
        Key: claimKey(claim.claimId),
        UpdateExpression:
          `SET ${set.join(', ')}` +
          (remove.length === 0 ? '' : ` REMOVE ${remove.join(', ')}`),
        ConditionExpression: actorConditions[rule],
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      },
    },
    historyPut(tableName, history),
  ];
}

/**
 * A `Delete` of a draft that was never submitted, by its owner, at the
 * claim's current version. History is purged afterwards by the cleanup
 * worker (section 12), not in this transaction.
 */
export function deleteDraftOperation(
  tableName: string,
  claim: Claim,
  actorId: string,
  expectedVersion: number,
): TransactionItem {
  checkTable(tableName);
  encodeClaimItem(claim);
  if (!idSchema.safeParse(actorId).success) {
    throw new ClaimOperationError('the actor ID is not valid');
  }
  if (claim.status !== 'DRAFT' || claim.submittedAt !== undefined) {
    throw new ClaimOperationError(
      'only a never-submitted draft can be deleted',
    );
  }
  if (claim.employeeId !== actorId) {
    throw new ClaimOperationError('only the owner can delete a draft');
  }
  if (expectedVersion !== claim.version) {
    throw new ClaimOperationError(
      'expectedVersion must be the version of the draft',
    );
  }
  return {
    Delete: {
      TableName: tableName,
      Key: claimKey(claim.claimId),
      ConditionExpression: draftDeleteCondition,
      ExpressionAttributeNames: {
        '#version': 'version',
        '#employeeId': 'employeeId',
        '#status': 'status',
        '#submittedAt': 'submittedAt',
      },
      ExpressionAttributeValues: {
        ':expectedVersion': expectedVersion,
        ':actorId': actorId,
        ':draft': 'DRAFT',
      },
    },
  };
}

function historyPut(
  tableName: string,
  history: ClaimChange['history'],
): TransactionItem {
  return {
    Put: {
      TableName: tableName,
      Item: encodeHistoryItem(history),
      ConditionExpression: historyCreateCondition,
    },
  };
}

/** The entry describes this claim change: same claim, version, and status. */
function checkHistoryMatches({ claim, history }: ClaimChange): void {
  if (history.claimId !== claim.claimId) {
    throw new ClaimOperationError('the history entry is for another claim');
  }
  if (history.version !== claim.version) {
    throw new ClaimOperationError(
      'the history version must equal the claim version',
    );
  }
  if (history.toStatus !== claim.status) {
    throw new ClaimOperationError(
      "the history entry's resulting status must equal the claim status",
    );
  }
}

/**
 * Lifecycle actions follow `claimTransitions`; draft and receipt changes
 * keep a claim in `DRAFT`.
 */
function checkTransition(
  action: UpdateAction,
  fromStatus: string | undefined,
  toStatus: string,
): void {
  const expected = isPublishableAction(action)
    ? claimTransitions[action as ClaimAction]
    : { from: 'DRAFT', to: 'DRAFT' };
  if (fromStatus !== expected.from || toStatus !== expected.to) {
    throw new ClaimOperationError(
      'the history statuses do not match the action',
    );
  }
}

function checkTable(tableName: string): void {
  if (typeof tableName !== 'string' || tableName.length === 0) {
    throw new ClaimOperationError('the table name is missing');
  }
}
