import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import type { Claim, ClaimChange } from '@claimflow/domain';

import {
  buildClaimLifecycleEvent,
  type ClaimEventIds,
} from '../../application/claim-events.js';
import {
  buildHistoryPurgeEvent,
  buildReceiptDeletionEvent,
} from '../../application/cleanup-events.js';
import type {
  CategoryGuard,
  CommitOptions,
  CompletedRequest,
} from '../../application/commit.js';
import {
  categoryGuardCheckOperation,
  decrementClaimCountOperation,
  incrementClaimCountOperation,
} from './dynamodb-category-operations.js';
import {
  createClaimOperations,
  deleteDraftOperation,
  updateClaimOperations,
} from './dynamodb-claim-operations.js';
import { encodeClaimItem, isIsoTimestamp } from './dynamodb-items.js';
import {
  receiptObjectKey,
  type AttachedReceiptRecord,
  type PendingReceiptRecord,
  type RetiredReceiptRecord,
} from './dynamodb-receipt-items.js';
import {
  attachReceiptOperation,
  retireReceiptOperation,
} from './dynamodb-receipt-operations.js';
import { canonicalJson } from './transaction-token.js';
import type { DynamoDbTransactionExecutor } from './dynamodb-transaction-executor.js';
import {
  composeBusinessTransaction,
  type TransactionItem,
} from './dynamodb-transaction.js';

/**
 * The creation, draft-editing, submission, lifecycle, receipt, and deletion side of the DynamoDB claim
 * repository (docs/aws-architecture.md, sections 8, 9, 15, and 18, access
 * patterns A2 and A3). Each method builds the claim and history operations and the category
 * counter operations the change needs, composes them with the completed
 * idempotency record, and sends the result once through the executor. A
 * category guard is applied by the counter increment itself, never by a
 * separate `ConditionCheck`. Creation and draft edits publish no event; a lifecycle change publishes
 * exactly one, which must equal the event rebuilt from the change. It inspects no
 * cancellation reason, retries nothing, and rereads nothing: every executor
 * and SDK error propagates unchanged for the idempotency orchestration.
 * Validation errors are fixed messages that name no supplied or stored value.
 */

/** The one executor method the writer uses. */
export type ClaimTransactionExecutor = Pick<
  DynamoDbTransactionExecutor,
  'execute'
>;

export interface DynamoDbClaimWriterOptions {
  readonly executor: ClaimTransactionExecutor;
  readonly tableName: string;
}

export class DynamoDbClaimWriter {
  private readonly executor: ClaimTransactionExecutor;
  private readonly tableName: string;

  public constructor({ executor, tableName }: DynamoDbClaimWriterOptions) {
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
   * A2: the claim, its first history entry, the category counter increment
   * (only for a categorized claim), then the completed idempotency record, in
   * one transaction.
   */
  public async create(
    change: ClaimChange,
    options: CommitOptions,
  ): Promise<void> {
    await this.executor.execute(this.prepareCreate(change, options));
  }

  /**
   * The composed transaction of `create`, without sending it, for an
   * orchestration that commits it through the idempotent committer. Every
   * validation of `create` happens here, synchronously.
   */
  public prepareCreate(
    change: ClaimChange,
    options: CommitOptions,
  ): TransactWriteCommandInput {
    const completed = checkCreateOptions(change, options);
    const businessItems: TransactionItem[] = [
      ...createClaimOperations(this.tableName, change),
    ];
    if (options.categoryGuard !== undefined) {
      businessItems.push(
        incrementClaimCountOperation(this.tableName, options.categoryGuard),
      );
    }
    const input = composeBusinessTransaction({
      tableName: this.tableName,
      businessItems,
      events: [],
      completed,
    });
    return input;
  }

  /**
   * A3 for a draft edit: the claim update at `previousClaim.version`, the new
   * history entry, the old category's decrement and the new category's guarded
   * increment (each only when the category changed), then the completed
   * idempotency record, in one transaction. `storedLastEventVersion` is the
   * value read with `previousClaim`; the update keeps it.
   */
  public async updateDraft(
    previousClaim: Claim,
    change: ClaimChange,
    storedLastEventVersion: number | undefined,
    options: CommitOptions,
  ): Promise<void> {
    await this.executor.execute(
      this.prepareUpdateDraft(
        previousClaim,
        change,
        storedLastEventVersion,
        options,
      ),
    );
  }

  /**
   * The composed transaction of `updateDraft`, without sending it, for an
   * orchestration that commits it through the idempotent committer. Every
   * validation of `updateDraft` happens here, synchronously.
   */
  public prepareUpdateDraft(
    previousClaim: Claim,
    change: ClaimChange,
    storedLastEventVersion: number | undefined,
    options: CommitOptions,
  ): TransactWriteCommandInput {
    const completed = checkUpdateOptions(previousClaim, change, options);
    const oldCategoryId = previousClaim.categoryId;
    const newCategoryId = change.claim.categoryId;
    const businessItems: TransactionItem[] = [
      ...updateClaimOperations(
        this.tableName,
        change,
        previousClaim.version,
        storedLastEventVersion,
      ),
    ];
    if (oldCategoryId !== newCategoryId) {
      if (oldCategoryId !== undefined) {
        businessItems.push(
          decrementClaimCountOperation(this.tableName, oldCategoryId),
        );
      }
      if (options.categoryGuard !== undefined) {
        businessItems.push(
          incrementClaimCountOperation(this.tableName, options.categoryGuard),
        );
      }
    }
    const input = composeBusinessTransaction({
      tableName: this.tableName,
      businessItems,
      events: [],
      completed,
    });
    return input;
  }

  /**
   * A3 for START_REVIEW, APPROVE, REJECT, REOPEN, and MARK_PAID: the claim
   * update at `previousClaim.version`, the history entry, the one lifecycle
   * outbox event, then the completed idempotency record, in one transaction.
   * The supplied event must equal `buildClaimLifecycleEvent` for the change
   * and the supplied event IDs; the writer generates no ID or timestamp.
   * `storedLastEventVersion` is the value read with `previousClaim`.
   */
  public async updateLifecycle(
    previousClaim: Claim,
    change: ClaimChange,
    storedLastEventVersion: number | undefined,
    options: CommitOptions,
  ): Promise<void> {
    await this.executor.execute(
      this.prepareUpdateLifecycle(
        previousClaim,
        change,
        storedLastEventVersion,
        options,
      ),
    );
  }

  /**
   * The composed transaction of `updateLifecycle`, without sending it, for an
   * orchestration that commits it through the idempotent committer. Every
   * validation of `updateLifecycle` happens here, synchronously.
   */
  public prepareUpdateLifecycle(
    previousClaim: Claim,
    change: ClaimChange,
    storedLastEventVersion: number | undefined,
    options: CommitOptions,
  ): TransactWriteCommandInput {
    const completed = checkLifecycleOptions(
      previousClaim,
      change,
      storedLastEventVersion,
      options,
    );
    const input = composeBusinessTransaction({
      tableName: this.tableName,
      businessItems: updateClaimOperations(
        this.tableName,
        change,
        previousClaim.version,
        storedLastEventVersion,
      ),
      events: options.events,
      completed,
    });
    return input;
  }

  /**
   * A3 for SUBMIT, first submission or resubmission after reopening: the claim
   * update at `previousClaim.version`, the history entry, the category
   * `ConditionCheck` that applies the guard (the category's counter is not
   * touched), the one `claim.submitted` outbox event, then the completed
   * idempotency record, in one transaction. The supplied event must equal
   * `buildClaimLifecycleEvent` for the change; the writer generates no ID or
   * timestamp. `storedLastEventVersion` is the value read with `previousClaim`.
   */
  public async submit(
    previousClaim: Claim,
    change: ClaimChange,
    storedLastEventVersion: number | undefined,
    options: CommitOptions,
  ): Promise<void> {
    await this.executor.execute(
      this.prepareSubmit(
        previousClaim,
        change,
        storedLastEventVersion,
        options,
      ),
    );
  }

  /**
   * The composed transaction of `submit`, without sending it, for an
   * orchestration that commits it through the idempotent committer. Every
   * validation of `submit` happens here, synchronously.
   */
  public prepareSubmit(
    previousClaim: Claim,
    change: ClaimChange,
    storedLastEventVersion: number | undefined,
    options: CommitOptions,
  ): TransactWriteCommandInput {
    const { completed, guard } = checkSubmitOptions(
      previousClaim,
      change,
      storedLastEventVersion,
      options,
    );
    const input = composeBusinessTransaction({
      tableName: this.tableName,
      businessItems: [
        ...updateClaimOperations(
          this.tableName,
          change,
          previousClaim.version,
          storedLastEventVersion,
        ),
        categoryGuardCheckOperation(this.tableName, guard),
      ],
      events: options.events,
      completed,
    });
    return input;
  }

  /**
   * A3 and R5 for the first receipt of a draft (ATTACH_RECEIPT): the claim
   * update at `previousClaim.version`, the history entry, the receipt
   * metadata update from `PENDING` to `ATTACHED`, then the completed
   * idempotency record, in one transaction. The upload was already inspected
   * and promoted elsewhere; this writer performs no S3 operation and
   * generates no ID or timestamp. `storedLastEventVersion` is the value read
   * with `previousClaim`, and the update keeps it.
   */
  public async attachReceipt(
    previousClaim: Claim,
    change: ClaimChange,
    pendingReceipt: PendingReceiptRecord,
    attachedReceipt: AttachedReceiptRecord,
    storedLastEventVersion: number | undefined,
    options: CommitOptions,
  ): Promise<void> {
    await this.executor.execute(
      this.prepareAttachReceipt(
        previousClaim,
        change,
        pendingReceipt,
        attachedReceipt,
        storedLastEventVersion,
        options,
      ),
    );
  }

  /**
   * The composed transaction of `attachReceipt`, without sending it, for an
   * orchestration that commits it through the idempotent committer. Every
   * validation of `attachReceipt` happens here, synchronously.
   */
  public prepareAttachReceipt(
    previousClaim: Claim,
    change: ClaimChange,
    pendingReceipt: PendingReceiptRecord,
    attachedReceipt: AttachedReceiptRecord,
    storedLastEventVersion: number | undefined,
    options: CommitOptions,
  ): TransactWriteCommandInput {
    const completed = checkAttachOptions(
      previousClaim,
      change,
      pendingReceipt,
      attachedReceipt,
      options,
    );
    const input = composeBusinessTransaction({
      tableName: this.tableName,
      businessItems: [
        ...updateClaimOperations(
          this.tableName,
          change,
          previousClaim.version,
          storedLastEventVersion,
        ),
        attachReceiptOperation(
          this.tableName,
          pendingReceipt,
          attachedReceipt,
          change.history.actorId,
        ),
      ],
      events: [],
      completed,
    });
    return input;
  }

  /**
   * A3 and R5 for replacing a draft's receipt (REPLACE_RECEIPT): the claim
   * update at `previousClaim.version`, the history entry, the new receipt's
   * `PENDING` to `ATTACHED` update, the old receipt's retirement to
   * `REPLACED`, the cleanup outbox event for the old object, then the
   * completed idempotency record, in one transaction. The cleanup event must
   * equal `buildReceiptDeletionEvent` for the old receipt; the writer
   * performs no S3 operation and generates no ID or timestamp. The cleanup
   * event is not part of the published sequence, so
   * `storedLastEventVersion` is kept.
   */
  public async replaceReceipt(
    input: ReplaceReceiptInput,
    options: CommitOptions,
  ): Promise<void> {
    await this.executor.execute(this.prepareReplaceReceipt(input, options));
  }

  /**
   * The composed transaction of `replaceReceipt`, without sending it, for an
   * orchestration that commits it through the idempotent committer. Every
   * validation of `replaceReceipt` happens here, synchronously.
   */
  public prepareReplaceReceipt(
    input: ReplaceReceiptInput,
    options: CommitOptions,
  ): TransactWriteCommandInput {
    const completed = checkReplaceOptions(input, options);
    const { previousClaim, change } = input;
    const transaction = composeBusinessTransaction({
      tableName: this.tableName,
      businessItems: [
        ...updateClaimOperations(
          this.tableName,
          change,
          previousClaim.version,
          input.storedLastEventVersion,
        ),
        attachReceiptOperation(
          this.tableName,
          input.newPendingReceipt,
          input.newAttachedReceipt,
          change.history.actorId,
        ),
        retireReceiptOperation(
          this.tableName,
          input.oldAttachedReceipt,
          input.oldRetiredReceipt,
          change.history.occurredAt,
        ),
      ],
      events: options.events,
      completed,
    });
    return transaction;
  }

  /**
   * A3 and R5 for removing a draft's receipt (REMOVE_RECEIPT): the claim
   * update at `previousClaim.version` that drops the claim's receipt, the
   * history entry, the receipt's retirement to `REMOVED`, the cleanup outbox
   * event for its object, then the completed idempotency record, in one
   * transaction. The cleanup event must equal `buildReceiptDeletionEvent` for
   * the removed receipt; the writer performs no S3 operation and generates no
   * ID or timestamp. The cleanup event is outside the published sequence, so
   * `storedLastEventVersion` is kept.
   */
  public async removeReceipt(
    input: RemoveReceiptInput,
    options: CommitOptions,
  ): Promise<void> {
    await this.executor.execute(this.prepareRemoveReceipt(input, options));
  }

  /**
   * The composed transaction of `removeReceipt`, without sending it, for an
   * orchestration that commits it through the idempotent committer. Every
   * validation of `removeReceipt` happens here, synchronously.
   */
  public prepareRemoveReceipt(
    input: RemoveReceiptInput,
    options: CommitOptions,
  ): TransactWriteCommandInput {
    const completed = checkRemoveOptions(input, options);
    const { previousClaim, change } = input;
    const transaction = composeBusinessTransaction({
      tableName: this.tableName,
      businessItems: [
        ...updateClaimOperations(
          this.tableName,
          change,
          previousClaim.version,
          input.storedLastEventVersion,
        ),
        retireReceiptOperation(
          this.tableName,
          input.attachedReceipt,
          input.retiredReceipt,
          change.history.occurredAt,
        ),
      ],
      events: options.events,
      completed,
    });
    return transaction;
  }

  /**
   * A4 and section 12 for deleting a never-submitted draft: the claim
   * `Delete`, the category counter decrement (when the draft has a category),
   * the receipt retirement to `REMOVED` (when it has a receipt), the
   * history-purge event, the receipt-deletion event (with a receipt), then the
   * completed idempotency record, in one transaction of at most six
   * operations. No history entry is written or deleted here: the cleanup
   * worker purges history later. The writer performs no S3 operation and
   * generates no ID or timestamp.
   */
  public async deleteDraft(
    input: DeleteDraftInput,
    options: CommitOptions,
  ): Promise<void> {
    await this.executor.execute(this.prepareDeleteDraft(input, options));
  }

  /**
   * The composed transaction of `deleteDraft`, without sending it, for an
   * orchestration that commits it through the idempotent committer. Every
   * validation of `deleteDraft` happens here, synchronously.
   */
  public prepareDeleteDraft(
    input: DeleteDraftInput,
    options: CommitOptions,
  ): TransactWriteCommandInput {
    const completed = checkDeleteOptions(input, options);
    const { claim, actorId, changedAt, attachedReceipt, retiredReceipt } =
      input;
    const businessItems: TransactionItem[] = [
      deleteDraftOperation(this.tableName, claim, actorId, claim.version),
    ];
    if (claim.categoryId !== undefined) {
      businessItems.push(
        decrementClaimCountOperation(this.tableName, claim.categoryId),
      );
    }
    if (attachedReceipt !== undefined && retiredReceipt !== undefined) {
      businessItems.push(
        retireReceiptOperation(
          this.tableName,
          attachedReceipt,
          retiredReceipt,
          changedAt,
        ),
      );
    }
    const transaction = composeBusinessTransaction({
      tableName: this.tableName,
      businessItems,
      events: options.events,
      completed,
    });
    return transaction;
  }
}

/** What a draft deletion is built from. */
export interface DeleteDraftInput {
  readonly claim: Claim;
  readonly actorId: string;
  /** The deletion time: canonical, and not before `claim.updatedAt`. */
  readonly changedAt: string;
  /** The claim receipt's records; both or neither. */
  readonly attachedReceipt?: AttachedReceiptRecord;
  readonly retiredReceipt?: RetiredReceiptRecord;
}

/** What a receipt removal is built from. */
export interface RemoveReceiptInput {
  readonly previousClaim: Claim;
  readonly change: ClaimChange;
  readonly attachedReceipt: AttachedReceiptRecord;
  readonly retiredReceipt: RetiredReceiptRecord;
  readonly storedLastEventVersion: number | undefined;
}

/** What a receipt replacement is built from. */
export interface ReplaceReceiptInput {
  readonly previousClaim: Claim;
  readonly change: ClaimChange;
  readonly newPendingReceipt: PendingReceiptRecord;
  readonly newAttachedReceipt: AttachedReceiptRecord;
  readonly oldAttachedReceipt: AttachedReceiptRecord;
  readonly oldRetiredReceipt: RetiredReceiptRecord;
  readonly storedLastEventVersion: number | undefined;
}

/** The lifecycle actions this writer commits; SUBMIT is not one of them. */
const lifecycleActions: readonly string[] = [
  'START_REVIEW',
  'APPROVE',
  'REJECT',
  'REOPEN',
  'MARK_PAID',
];

/**
 * The idempotency record to commit. The claim, history, and guard values are
 * validated downstream by the builders and codecs.
 */
function checkCreateOptions(
  change: ClaimChange,
  options: CommitOptions,
): CompletedRequest {
  if (typeof change !== 'object' || change === null) {
    throw new TypeError('The claim change is missing.');
  }
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('The commit options are missing.');
  }
  if (!Array.isArray(options.events)) {
    throw new TypeError('The commit options must list their events.');
  }
  if (options.events.length > 0) {
    throw new TypeError('Creating a claim publishes no events.');
  }
  if (options.idempotency === undefined) {
    throw new TypeError('Creating a claim requires an idempotency record.');
  }
  const categoryId = change.claim?.categoryId;
  const guard = options.categoryGuard;
  if (categoryId === undefined) {
    if (guard !== undefined) {
      throw new TypeError(
        'An uncategorized claim cannot carry a category guard.',
      );
    }
  } else {
    if (guard === undefined) {
      throw new TypeError('A categorized claim requires a category guard.');
    }
    if (typeof guard !== 'object' || guard === null) {
      throw new TypeError('The category guard is invalid.');
    }
    if (guard.categoryId !== categoryId) {
      throw new TypeError('The category guard does not match the claim.');
    }
    if (guard.mustBeActive !== true) {
      throw new TypeError(
        'The category guard must require an active category.',
      );
    }
  }
  return options.idempotency;
}

/**
 * The idempotency record to commit for a draft edit. The claims, history, and
 * guard values are validated downstream by the builders and codecs.
 */
function checkUpdateOptions(
  previousClaim: Claim,
  change: ClaimChange,
  options: CommitOptions,
): CompletedRequest {
  if (typeof previousClaim !== 'object' || previousClaim === null) {
    throw new TypeError('The previous claim is missing.');
  }
  if (typeof change !== 'object' || change === null) {
    throw new TypeError('The claim change is missing.');
  }
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('The commit options are missing.');
  }
  if (!Array.isArray(options.events)) {
    throw new TypeError('The commit options must list their events.');
  }
  if (options.events.length > 0) {
    throw new TypeError('Editing a draft publishes no events.');
  }
  if (options.idempotency === undefined) {
    throw new TypeError('Editing a draft requires an idempotency record.');
  }
  const { claim, history } = change;
  if (typeof claim !== 'object' || claim === null) {
    throw new TypeError('The claim change is missing.');
  }
  if (typeof history !== 'object' || history === null) {
    throw new TypeError('The claim change is missing.');
  }
  if (history.action !== 'UPDATE') {
    throw new TypeError('Only a draft edit can be written.');
  }
  if (previousClaim.status !== 'DRAFT' || claim.status !== 'DRAFT') {
    throw new TypeError('Only a draft can be edited.');
  }
  if (claim.claimId !== previousClaim.claimId) {
    throw new TypeError('The edited claim does not match the previous claim.');
  }
  if (claim.employeeId !== previousClaim.employeeId) {
    throw new TypeError('The edited claim does not match the previous claim.');
  }
  // Rejects a previous claim the claim codec refuses, with its fixed message.
  encodeClaimItem(previousClaim);
  const guard = options.categoryGuard;
  const entering =
    claim.categoryId !== undefined &&
    claim.categoryId !== previousClaim.categoryId;
  if (!entering) {
    if (guard !== undefined) {
      throw new TypeError(
        'A category guard is only allowed when entering a different category.',
      );
    }
  } else {
    if (guard === undefined) {
      throw new TypeError(
        'Entering a different category requires a category guard.',
      );
    }
    if (typeof guard !== 'object' || guard === null) {
      throw new TypeError('The category guard is invalid.');
    }
    if (guard.categoryId !== claim.categoryId) {
      throw new TypeError('The category guard does not match the claim.');
    }
    if (guard.mustBeActive !== true) {
      throw new TypeError(
        'The category guard must require an active category.',
      );
    }
  }
  return options.idempotency;
}

/**
 * The idempotency record to commit for a lifecycle change. The claims,
 * history, and event values are validated by comparison with the rebuilt
 * event and downstream by the builders and codecs.
 */
function checkLifecycleOptions(
  previousClaim: Claim,
  change: ClaimChange,
  storedLastEventVersion: number | undefined,
  options: CommitOptions,
): CompletedRequest {
  if (typeof previousClaim !== 'object' || previousClaim === null) {
    throw new TypeError('The previous claim is missing.');
  }
  if (typeof change !== 'object' || change === null) {
    throw new TypeError('The claim change is missing.');
  }
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('The commit options are missing.');
  }
  const { claim, history } = change;
  if (typeof claim !== 'object' || claim === null) {
    throw new TypeError('The claim change is missing.');
  }
  if (typeof history !== 'object' || history === null) {
    throw new TypeError('The claim change is missing.');
  }
  if (!lifecycleActions.includes(history.action)) {
    throw new TypeError('Only a review, reopen, or payment can be written.');
  }
  if (
    claim.claimId !== previousClaim.claimId ||
    claim.employeeId !== previousClaim.employeeId ||
    claim.categoryId !== previousClaim.categoryId
  ) {
    throw new TypeError('The changed claim does not match the previous claim.');
  }
  if (previousClaim.status !== history.fromStatus) {
    throw new TypeError('The previous claim is not in the expected status.');
  }
  // Rejects a previous claim the claim codec refuses, with its fixed message.
  encodeClaimItem(previousClaim);
  if (options.categoryGuard !== undefined) {
    throw new TypeError('A lifecycle change cannot carry a category guard.');
  }
  if (options.idempotency === undefined) {
    throw new TypeError('A lifecycle change requires an idempotency record.');
  }
  checkSingleEvent(change, storedLastEventVersion, options);
  return options.idempotency;
}

/** The fixed messages of the single-event check. */
interface SingleEventMessages {
  readonly count: string;
  readonly mismatch: string;
}

const lifecycleEventMessages: SingleEventMessages = {
  count: 'A lifecycle change publishes exactly one event.',
  mismatch: 'The lifecycle event does not match the change.',
};

/**
 * Exactly one event, equal to the event rebuilt by `build` from the supplied
 * event's own IDs, compared in canonical form. `build` may throw or return
 * `undefined`; either is a mismatch.
 */
function checkOneEvent(
  options: CommitOptions,
  build: (ids: ClaimEventIds) => unknown,
  messages: SingleEventMessages,
): void {
  if (!Array.isArray(options.events)) {
    throw new TypeError('The commit options must list their events.');
  }
  if (options.events.length !== 1) {
    throw new TypeError(messages.count);
  }
  checkEventMatches(options.events[0], build, messages.mismatch);
}

/**
 * One supplied event equals the event rebuilt by `build` from its own IDs, in
 * canonical form. `build` may throw or return `undefined`; either is a
 * mismatch.
 */
function checkEventMatches(
  supplied: unknown,
  build: (ids: ClaimEventIds) => unknown,
  mismatch: string,
): void {
  if (typeof supplied !== 'object' || supplied === null) {
    throw new TypeError(mismatch);
  }
  const { eventId, correlationId, causationId } = supplied as Record<
    string,
    unknown
  >;
  if (
    typeof eventId !== 'string' ||
    typeof correlationId !== 'string' ||
    typeof causationId !== 'string'
  ) {
    throw new TypeError(mismatch);
  }
  let matches: boolean;
  try {
    const expected = build({ eventId, correlationId, causationId });
    matches =
      expected !== undefined &&
      canonicalJson(expected) === canonicalJson(supplied);
  } catch {
    // The builders and canonical form name no values, but the writer's own
    // message stays fixed whatever the cause.
    matches = false;
  }
  if (!matches) {
    throw new TypeError(mismatch);
  }
}

/** Exactly one event, equal to the rebuilt lifecycle event. */
function checkSingleEvent(
  change: ClaimChange,
  storedLastEventVersion: number | undefined,
  options: CommitOptions,
): void {
  checkOneEvent(
    options,
    (ids) => buildClaimLifecycleEvent(change, ids, storedLastEventVersion),
    lifecycleEventMessages,
  );
}

/**
 * The idempotency record and category guard to commit for a submission. The
 * claims, history, and event values are validated by comparison with the
 * rebuilt event and downstream by the builders and codecs.
 */
function checkSubmitOptions(
  previousClaim: Claim,
  change: ClaimChange,
  storedLastEventVersion: number | undefined,
  options: CommitOptions,
): { completed: CompletedRequest; guard: CategoryGuard } {
  if (typeof previousClaim !== 'object' || previousClaim === null) {
    throw new TypeError('The previous claim is missing.');
  }
  if (typeof change !== 'object' || change === null) {
    throw new TypeError('The claim change is missing.');
  }
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('The commit options are missing.');
  }
  const { claim, history } = change;
  if (typeof claim !== 'object' || claim === null) {
    throw new TypeError('The claim change is missing.');
  }
  if (typeof history !== 'object' || history === null) {
    throw new TypeError('The claim change is missing.');
  }
  if (history.action !== 'SUBMIT') {
    throw new TypeError('Only a submission can be written.');
  }
  if (
    claim.claimId !== previousClaim.claimId ||
    claim.employeeId !== previousClaim.employeeId ||
    claim.categoryId !== previousClaim.categoryId
  ) {
    throw new TypeError(
      'The submitted claim does not match the previous claim.',
    );
  }
  if (claim.categoryId === undefined) {
    throw new TypeError('A submitted claim requires a category.');
  }
  if (
    previousClaim.status !== 'DRAFT' ||
    history.fromStatus !== 'DRAFT' ||
    claim.status !== 'SUBMITTED' ||
    history.toStatus !== 'SUBMITTED'
  ) {
    throw new TypeError('Only a draft can be submitted.');
  }
  // Rejects a previous claim the claim codec refuses, with its fixed message.
  encodeClaimItem(previousClaim);
  const guard = options.categoryGuard;
  if (guard === undefined) {
    throw new TypeError('A submission requires a category guard.');
  }
  if (typeof guard !== 'object' || guard === null) {
    throw new TypeError('The category guard is invalid.');
  }
  if (guard.categoryId !== claim.categoryId) {
    throw new TypeError('The category guard does not match the claim.');
  }
  if (guard.mustBeActive !== true) {
    throw new TypeError('The category guard must require an active category.');
  }
  if (options.idempotency === undefined) {
    throw new TypeError('A submission requires an idempotency record.');
  }
  checkSingleEvent(change, storedLastEventVersion, options);
  return { completed: options.idempotency, guard };
}

/**
 * The idempotency record to commit for a first receipt attachment. The claims,
 * history, and receipt records are validated downstream by the builders and
 * codecs; this checks how they relate to each other.
 */
function checkAttachOptions(
  previousClaim: Claim,
  change: ClaimChange,
  pendingReceipt: PendingReceiptRecord,
  attachedReceipt: AttachedReceiptRecord,
  options: CommitOptions,
): CompletedRequest {
  if (typeof previousClaim !== 'object' || previousClaim === null) {
    throw new TypeError('The previous claim is missing.');
  }
  if (typeof change !== 'object' || change === null) {
    throw new TypeError('The claim change is missing.');
  }
  if (typeof pendingReceipt !== 'object' || pendingReceipt === null) {
    throw new TypeError('The pending receipt is missing.');
  }
  if (typeof attachedReceipt !== 'object' || attachedReceipt === null) {
    throw new TypeError('The attached receipt is missing.');
  }
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('The commit options are missing.');
  }
  const { claim, history } = change;
  if (typeof claim !== 'object' || claim === null) {
    throw new TypeError('The claim change is missing.');
  }
  if (typeof history !== 'object' || history === null) {
    throw new TypeError('The claim change is missing.');
  }
  if (history.action !== 'ATTACH_RECEIPT') {
    throw new TypeError('Only a first receipt attachment can be written.');
  }
  if (previousClaim.status !== 'DRAFT' || claim.status !== 'DRAFT') {
    throw new TypeError('Only a draft can have a receipt attached.');
  }
  if (
    claim.claimId !== previousClaim.claimId ||
    claim.employeeId !== previousClaim.employeeId ||
    claim.categoryId !== previousClaim.categoryId
  ) {
    throw new TypeError('The changed claim does not match the previous claim.');
  }
  if (previousClaim.receipt !== undefined) {
    throw new TypeError('The previous claim already has a receipt.');
  }
  checkAttachedLink(claim, history, attachedReceipt);
  // Rejects a previous claim the claim codec refuses, with its fixed message.
  encodeClaimItem(previousClaim);
  if (options.categoryGuard !== undefined) {
    throw new TypeError('A receipt attachment cannot carry a category guard.');
  }
  if (options.idempotency === undefined) {
    throw new TypeError('A receipt attachment requires an idempotency record.');
  }
  if (!Array.isArray(options.events)) {
    throw new TypeError('The commit options must list their events.');
  }
  if (options.events.length > 0) {
    throw new TypeError('A receipt attachment publishes no events.');
  }
  return options.idempotency;
}

/**
 * The changed claim has a receipt, and it is the attached record: owned by the
 * claim owner and the history actor, for this claim, with equal receipt
 * values and an attachment time equal to the history time.
 */
function checkAttachedLink(
  claim: Claim,
  history: ClaimChange['history'],
  attachedReceipt: AttachedReceiptRecord,
): void {
  const receipt = claim.receipt;
  if (receipt === undefined) {
    throw new TypeError('The changed claim has no receipt.');
  }
  if (
    attachedReceipt.attachedClaimId !== claim.claimId ||
    attachedReceipt.ownerId !== claim.employeeId ||
    attachedReceipt.ownerId !== history.actorId
  ) {
    throw new TypeError('The attached receipt does not belong to the claim.');
  }
  if (
    receipt.receiptId !== attachedReceipt.receiptId ||
    receipt.fileName !== attachedReceipt.fileName ||
    receipt.contentType !== attachedReceipt.contentType ||
    receipt.sizeBytes !== attachedReceipt.sizeBytes ||
    receipt.checksumSha256 !== attachedReceipt.checksumSha256 ||
    receipt.attachedAt !== history.occurredAt
  ) {
    throw new TypeError(
      'The claim receipt does not match the attached receipt.',
    );
  }
}

/**
 * The idempotency record to commit for a receipt replacement. The claims,
 * history, and receipt records are validated downstream by the builders and
 * codecs; this checks how they relate to each other and to the cleanup event.
 */
function checkReplaceOptions(
  input: ReplaceReceiptInput,
  options: CommitOptions,
): CompletedRequest {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError('The receipt replacement is missing.');
  }
  const {
    previousClaim,
    change,
    newPendingReceipt,
    newAttachedReceipt,
    oldAttachedReceipt,
    oldRetiredReceipt,
  } = input;
  if (typeof previousClaim !== 'object' || previousClaim === null) {
    throw new TypeError('The previous claim is missing.');
  }
  if (typeof change !== 'object' || change === null) {
    throw new TypeError('The claim change is missing.');
  }
  for (const record of [
    newPendingReceipt,
    newAttachedReceipt,
    oldAttachedReceipt,
    oldRetiredReceipt,
  ]) {
    if (typeof record !== 'object' || record === null) {
      throw new TypeError('A receipt record is missing.');
    }
  }
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('The commit options are missing.');
  }
  const { claim, history } = change;
  if (typeof claim !== 'object' || claim === null) {
    throw new TypeError('The claim change is missing.');
  }
  if (typeof history !== 'object' || history === null) {
    throw new TypeError('The claim change is missing.');
  }
  if (history.action !== 'REPLACE_RECEIPT') {
    throw new TypeError('Only a receipt replacement can be written.');
  }
  if (previousClaim.status !== 'DRAFT' || claim.status !== 'DRAFT') {
    throw new TypeError('Only a draft can have its receipt replaced.');
  }
  if (
    claim.claimId !== previousClaim.claimId ||
    claim.employeeId !== previousClaim.employeeId ||
    claim.categoryId !== previousClaim.categoryId
  ) {
    throw new TypeError('The changed claim does not match the previous claim.');
  }
  const previousReceipt = previousClaim.receipt;
  if (previousReceipt === undefined) {
    throw new TypeError('The previous claim has no receipt.');
  }
  if (claim.receipt === undefined) {
    throw new TypeError('The changed claim has no receipt.');
  }
  if (claim.receipt.receiptId === previousReceipt.receiptId) {
    throw new TypeError('The new receipt must differ from the previous one.');
  }
  checkSourceReceipt(previousClaim, previousReceipt, oldAttachedReceipt);
  if (oldRetiredReceipt.state !== 'REPLACED') {
    throw new TypeError('The previous receipt must be marked as replaced.');
  }
  checkAttachedLink(claim, history, newAttachedReceipt);
  // Rejects a previous claim the claim codec refuses, with its fixed message.
  encodeClaimItem(previousClaim);
  if (options.categoryGuard !== undefined) {
    throw new TypeError('A receipt replacement cannot carry a category guard.');
  }
  if (options.idempotency === undefined) {
    throw new TypeError(
      'A receipt replacement requires an idempotency record.',
    );
  }
  checkOneEvent(
    options,
    cleanupEventBuilder(change, oldAttachedReceipt.receiptId),
    {
      count: 'A receipt replacement publishes exactly one cleanup event.',
      mismatch: cleanupMismatch,
    },
  );
  return options.idempotency;
}

const cleanupMismatch = 'The cleanup event does not match the change.';

/** Rebuilds the cleanup event for the final object of one receipt. */
function cleanupEventBuilder(
  { claim, history }: ClaimChange,
  receiptId: string,
): (ids: ClaimEventIds) => unknown {
  return (ids) =>
    buildReceiptDeletionEvent({
      ...ids,
      actorId: history.actorId,
      occurredAt: history.occurredAt,
      claimVersion: claim.version,
      claimId: claim.claimId,
      receiptId,
      objectKey: receiptObjectKey(receiptId),
    });
}

/**
 * The attached record is the previous claim's receipt: same claim, owner,
 * receipt ID, file name, content type, size, and checksum. The old
 * attachment time is not compared.
 */
function checkSourceReceipt(
  previousClaim: Claim,
  previousReceipt: NonNullable<Claim['receipt']>,
  attachedReceipt: AttachedReceiptRecord,
): void {
  if (
    attachedReceipt.attachedClaimId !== previousClaim.claimId ||
    attachedReceipt.ownerId !== previousClaim.employeeId ||
    attachedReceipt.receiptId !== previousReceipt.receiptId ||
    attachedReceipt.fileName !== previousReceipt.fileName ||
    attachedReceipt.contentType !== previousReceipt.contentType ||
    attachedReceipt.sizeBytes !== previousReceipt.sizeBytes ||
    attachedReceipt.checksumSha256 !== previousReceipt.checksumSha256
  ) {
    throw new TypeError(
      'The previous receipt record does not match the previous claim.',
    );
  }
}

/**
 * The idempotency record to commit for a receipt removal. The claims,
 * history, and receipt records are validated downstream by the builders and
 * codecs; this checks how they relate to each other and to the cleanup event.
 */
function checkRemoveOptions(
  input: RemoveReceiptInput,
  options: CommitOptions,
): CompletedRequest {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError('The receipt removal is missing.');
  }
  const { previousClaim, change, attachedReceipt, retiredReceipt } = input;
  if (typeof previousClaim !== 'object' || previousClaim === null) {
    throw new TypeError('The previous claim is missing.');
  }
  if (typeof change !== 'object' || change === null) {
    throw new TypeError('The claim change is missing.');
  }
  for (const record of [attachedReceipt, retiredReceipt]) {
    if (typeof record !== 'object' || record === null) {
      throw new TypeError('A receipt record is missing.');
    }
  }
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('The commit options are missing.');
  }
  const { claim, history } = change;
  if (typeof claim !== 'object' || claim === null) {
    throw new TypeError('The claim change is missing.');
  }
  if (typeof history !== 'object' || history === null) {
    throw new TypeError('The claim change is missing.');
  }
  if (history.action !== 'REMOVE_RECEIPT') {
    throw new TypeError('Only a receipt removal can be written.');
  }
  if (previousClaim.status !== 'DRAFT' || claim.status !== 'DRAFT') {
    throw new TypeError('Only a draft can have its receipt removed.');
  }
  if (
    claim.claimId !== previousClaim.claimId ||
    claim.employeeId !== previousClaim.employeeId ||
    claim.categoryId !== previousClaim.categoryId
  ) {
    throw new TypeError('The changed claim does not match the previous claim.');
  }
  const previousReceipt = previousClaim.receipt;
  if (previousReceipt === undefined) {
    throw new TypeError('The previous claim has no receipt.');
  }
  if (claim.receipt !== undefined) {
    throw new TypeError('The changed claim still has a receipt.');
  }
  checkSourceReceipt(previousClaim, previousReceipt, attachedReceipt);
  if (attachedReceipt.ownerId !== history.actorId) {
    throw new TypeError('The attached receipt does not belong to the actor.');
  }
  if (retiredReceipt.state !== 'REMOVED') {
    throw new TypeError('The removed receipt must be marked as removed.');
  }
  // Rejects a previous claim the claim codec refuses, with its fixed message.
  encodeClaimItem(previousClaim);
  if (options.categoryGuard !== undefined) {
    throw new TypeError('A receipt removal cannot carry a category guard.');
  }
  if (options.idempotency === undefined) {
    throw new TypeError('A receipt removal requires an idempotency record.');
  }
  checkOneEvent(
    options,
    cleanupEventBuilder(change, attachedReceipt.receiptId),
    {
      count: 'A receipt removal publishes exactly one cleanup event.',
      mismatch: cleanupMismatch,
    },
  );
  return options.idempotency;
}

/**
 * The idempotency record to commit for a draft deletion. Draft eligibility,
 * the owner, and the receipt records are validated downstream by the builders
 * and codecs; this checks how they relate to each other and to the events.
 */
function checkDeleteOptions(
  input: DeleteDraftInput,
  options: CommitOptions,
): CompletedRequest {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError('The draft deletion is missing.');
  }
  const { claim, actorId, changedAt, attachedReceipt, retiredReceipt } = input;
  if (typeof claim !== 'object' || claim === null) {
    throw new TypeError('The claim is missing.');
  }
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('The commit options are missing.');
  }
  if (typeof changedAt !== 'string' || !isIsoTimestamp(changedAt)) {
    throw new TypeError('The deletion time is not valid.');
  }
  if (changedAt < claim.updatedAt) {
    throw new TypeError('The deletion time is before the last update.');
  }
  if (!Number.isSafeInteger(claim.version + 1)) {
    throw new TypeError('The claim version is too large to delete.');
  }
  const receipt = claim.receipt;
  if (receipt === undefined) {
    if (attachedReceipt !== undefined || retiredReceipt !== undefined) {
      throw new TypeError(
        'A draft without a receipt cannot carry receipt records.',
      );
    }
  } else {
    if (
      typeof attachedReceipt !== 'object' ||
      attachedReceipt === null ||
      typeof retiredReceipt !== 'object' ||
      retiredReceipt === null
    ) {
      throw new TypeError('A receipt record is missing.');
    }
    checkSourceReceipt(claim, receipt, attachedReceipt);
    if (retiredReceipt.state !== 'REMOVED') {
      throw new TypeError('The deleted receipt must be marked as removed.');
    }
  }
  // Rejects a claim the claim codec refuses, with its fixed message.
  encodeClaimItem(claim);
  if (options.categoryGuard !== undefined) {
    throw new TypeError('A draft deletion cannot carry a category guard.');
  }
  if (options.idempotency === undefined) {
    throw new TypeError('A draft deletion requires an idempotency record.');
  }
  if (!Array.isArray(options.events)) {
    throw new TypeError('The commit options must list their events.');
  }
  const expectedCount = receipt === undefined ? 1 : 2;
  if (options.events.length !== expectedCount) {
    throw new TypeError(
      'A draft deletion publishes exactly its required cleanup events.',
    );
  }
  const eventIds = options.events
    .map((event: unknown) =>
      typeof event === 'object' && event !== null
        ? (event as Record<string, unknown>).eventId
        : undefined,
    )
    .filter((id): id is string => typeof id === 'string');
  if (new Set(eventIds).size !== eventIds.length) {
    throw new TypeError('The cleanup events must have distinct IDs.');
  }
  const cleanup = (ids: ClaimEventIds) => ({
    ...ids,
    actorId,
    occurredAt: changedAt,
    claimVersion: claim.version + 1,
    claimId: claim.claimId,
  });
  checkEventMatches(
    options.events[0],
    (ids) => buildHistoryPurgeEvent(cleanup(ids)),
    cleanupMismatch,
  );
  if (receipt !== undefined) {
    checkEventMatches(
      options.events[1],
      (ids) =>
        buildReceiptDeletionEvent({
          ...cleanup(ids),
          receiptId: receipt.receiptId,
          objectKey: receiptObjectKey(receipt.receiptId),
        }),
      cleanupMismatch,
    );
  }
  return options.idempotency;
}
