import {
  attachReceiptRequestSchema,
  idSchema,
  type AttachReceiptRequest,
} from '@claimflow/contracts';
import {
  assertEditable,
  attachReceipt,
  canViewClaim,
  type Actor,
  type Claim,
  type ClaimChange,
  type UploadedReceipt,
} from '@claimflow/domain';

import { assertVersion } from '../../application/claim-access.js';
import { buildReceiptDeletionEvent } from '../../application/cleanup-events.js';
import {
  expiresAfter,
  toEpochSeconds,
  type CommitOptions,
  type CompletedRequest,
} from '../../application/commit.js';
import { NotFoundError } from '../../application/errors.js';
import { idempotencyRetentionMs } from '../../application/idempotency.js';
import type {
  IdGenerator,
  Logger,
  UserDirectory,
} from '../../application/ports.js';
import {
  claimUserIds,
  loadNames,
  toClaimDto,
} from '../../application/presenters.js';
import { unavailable } from '../../application/receipt-service.js';
import { isTraceId } from '../../application/tracing.js';
import {
  backoffDelay,
  businessRejection,
  checkContext,
  isCancellation,
  maxCommitAttempts,
} from './aws-claim-creation-service.js';
import type { ClaimLifecycleContext } from './aws-claim-lifecycle-service.js';
import type {
  ClaimMutationCoordinator,
  ClaimMutationRequest,
  PreparedClaimMutation,
  PreparedClaimRejection,
} from './claim-mutation-coordinator.js';
import type { DynamoDbCategoryReader } from './dynamodb-category-reader.js';
import type { DynamoDbClaimReader } from './dynamodb-claim-reader.js';
import type { DynamoDbClaimWriter } from './dynamodb-claim-writer.js';
import type { IdempotencyRecord } from './dynamodb-idempotency-items.js';
import type { StoredClaim } from './dynamodb-items.js';
import type { DynamoDbReceiptMetadataReader } from './dynamodb-lookups.js';
import {
  receiptObjectKey,
  retiredReceiptExpiresAt,
  type AttachedReceiptRecord,
  type PendingReceiptRecord,
} from './dynamodb-receipt-items.js';
import {
  ReceiptUnavailableError,
  type S3ReceiptInspector,
} from './s3-receipt-inspector.js';
import type { S3ReceiptObjects } from './s3-receipt-objects.js';

/**
 * Receipt attachment and replacement on the AWS persistence
 * (docs/aws-architecture.md, section 11, "Attach or replace"), as an isolated
 * service that no route or composition uses yet. It runs through
 * `ClaimMutationCoordinator`, so a replay returns the stored claim snapshot
 * before the input is parsed and before any claim or receipt is read, any
 * object is inspected or promoted, or any ID is generated.
 *
 * Inside the lazy preparation, in order: validate the claim ID and the strict
 * request, strongly read the claim and apply the visibility and
 * `expectedVersion` rules, strongly read the receipt metadata (it must be a
 * `PENDING`, unexpired receipt owned by the actor), for a replacement read the
 * attached record of the old receipt, inspect the pending object against the
 * declaration (size, type, checksum, and real file type), apply the existing
 * domain rule `attachReceipt` to the measured values, promote the object to
 * `receipts/<id>`, present the claim, and prepare one transaction: the claim
 * update, history, the new receipt's `ATTACHED` metadata, for a replacement
 * the old receipt's `REPLACED` metadata with the cleanup event for the old
 * object, and the idempotency snapshot. Expected input, access, domain, and
 * receipt-availability errors become explicit `REJECTED` records; dependency,
 * codec, S3, and programming failures propagate unchanged.
 *
 * Only after the result is confirmed (the winning record is a completed
 * snapshot of a claim holding this receipt, and this call promoted it) is the
 * pending object deleted, best effort. The promoted final object is never
 * deleted here, so an uncertain outcome leaves the janitor's recovery intact.
 *
 * A cancelled commit is recovered within `maxCommitAttempts` prepared commits
 * as in the claim services: each attempt rechecks the idempotency record,
 * rereads the claim and the receipt (a changed claim version is a
 * `VERSION_CONFLICT`, a receipt that is no longer pending and owned is
 * `RECEIPT_UNAVAILABLE`), re-inspects and re-promotes, and rebuilds after a
 * bounded, jittered backoff; at exhaustion the same checks run and an
 * unresolved cancellation is rethrown unchanged.
 */

export interface AwsReceiptAttachmentServiceDependencies {
  readonly mutations: Pick<ClaimMutationCoordinator, 'run'>;
  readonly claimReader: Pick<DynamoDbClaimReader, 'getStored'>;
  readonly receipts: Pick<DynamoDbReceiptMetadataReader, 'get'>;
  readonly inspector: Pick<S3ReceiptInspector, 'inspect'>;
  readonly objects: Pick<S3ReceiptObjects, 'promote' | 'deletePending'>;
  readonly categories: Pick<DynamoDbCategoryReader, 'list'>;
  readonly users: UserDirectory;
  readonly claims: Pick<
    DynamoDbClaimWriter,
    'prepareAttachReceipt' | 'prepareReplaceReceipt'
  >;
  readonly ids: IdGenerator;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
  readonly logger: Logger;
}

/** The receipt records of the claim contradict the claim itself. */
export class ReceiptAttachmentIntegrityError extends Error {
  public constructor() {
    super('The receipt records of the claim are inconsistent.');
    this.name = 'ReceiptAttachmentIntegrityError';
  }
}

const operation = 'receipt.attach';

export class AwsReceiptAttachmentService {
  public constructor(
    private readonly deps: AwsReceiptAttachmentServiceDependencies,
  ) {
    if (typeof deps?.mutations?.run !== 'function') {
      throw new TypeError('The mutation coordinator is missing.');
    }
    if (typeof deps.claimReader?.getStored !== 'function') {
      throw new TypeError('The claim reader is missing.');
    }
    if (typeof deps.receipts?.get !== 'function') {
      throw new TypeError('The receipt metadata reader is missing.');
    }
    if (typeof deps.inspector?.inspect !== 'function') {
      throw new TypeError('The receipt inspector is missing.');
    }
    if (
      typeof deps.objects?.promote !== 'function' ||
      typeof deps.objects.deletePending !== 'function'
    ) {
      throw new TypeError('The receipt objects are missing.');
    }
    if (typeof deps.categories?.list !== 'function') {
      throw new TypeError('The category reader is missing.');
    }
    if (typeof deps.users?.getMany !== 'function') {
      throw new TypeError('The user directory is missing.');
    }
    if (
      typeof deps.claims?.prepareAttachReceipt !== 'function' ||
      typeof deps.claims.prepareReplaceReceipt !== 'function'
    ) {
      throw new TypeError('The claim writer is missing.');
    }
    if (typeof deps.ids?.newId !== 'function') {
      throw new TypeError('The ID generator is missing.');
    }
    if (typeof deps.sleep !== 'function') {
      throw new TypeError('The sleep function is missing.');
    }
    if (typeof deps.random !== 'function') {
      throw new TypeError('The random function is missing.');
    }
    if (
      typeof deps.logger?.info !== 'function' ||
      typeof deps.logger.warn !== 'function'
    ) {
      throw new TypeError('The logger is missing.');
    }
  }

  /**
   * The winning idempotency record: this request's `200` snapshot, a stored or
   * concurrent result, or an explicit business rejection. Whether this request
   * committed or replayed is not reported.
   */
  public async attach(
    actor: Actor,
    claimId: string,
    input: unknown,
    context: ClaimLifecycleContext,
  ): Promise<IdempotencyRecord> {
    checkContext(actor, context);
    if (
      typeof context.correlationId !== 'string' ||
      !isTraceId(context.correlationId)
    ) {
      throw new TypeError('The correlation ID is not valid.');
    }
    const call: Call = {
      actor,
      claimId,
      input,
      context,
      request: {
        actorId: actor.userId,
        key: context.idempotencyKey,
        fingerprint: context.fingerprint,
        nowEpoch: toEpochSeconds(new Date(context.now)),
      },
      expiresAt: expiresAfter(new Date(context.now), idempotencyRetentionMs),
    };
    const state: State = { commits: 0, committing: false, promoted: false };
    const record = await this.run(call, state);
    await this.discardPending(state, record);
    return record;
  }

  /** The first attempt, then the bounded recovery of a cancelled commit. */
  private async run(call: Call, state: State): Promise<IdempotencyRecord> {
    let prepare = (): Promise<Prepared> => this.prepare(call, state);
    let retries = 0;

    for (;;) {
      try {
        return await this.deps.mutations.run(call.request, prepare);
      } catch (error) {
        if (!isCancellation(error) || !state.committing) {
          throw error;
        }
        if (state.commits >= maxCommitAttempts) {
          return this.settle(call, state, error, retries);
        }
        retries += 1;
        this.deps.logger.info('receipt.attach.retry', { operation, retries });
        await this.deps.sleep(backoffDelay(retries, this.deps.random));
        prepare = () => this.recover(call, state);
      }
    }
  }

  /**
   * The cancellations are used up. Recheck the idempotency record, the claim,
   * and the receipt a last time: a winner is returned, a claim that is gone,
   * invisible, or at another version, or a receipt that is no longer pending
   * and owned, is a business rejection, and anything else is an unresolved
   * cancellation, rethrown unchanged.
   */
  private async settle(
    call: Call,
    state: State,
    cancellation: unknown,
    retries: number,
  ): Promise<IdempotencyRecord> {
    state.committing = false;
    return this.deps.mutations.run(call.request, async () => {
      const access = await this.reread(call, state);
      if ('rejection' in access) {
        return access;
      }
      const receipt = await this.pendingReceipt(call, state);
      if (receipt === undefined) {
        return this.unavailable(call);
      }
      await this.oldAttached(access.previous, state);
      this.deps.logger.warn('receipt.attach.retries_exhausted', {
        operation,
        retries,
      });
      throw cancellation;
    });
  }

  /** One recovery attempt, inside a coordinator run (the recheck comes first). */
  private async recover(call: Call, state: State): Promise<Prepared> {
    state.committing = false;
    const access = await this.reread(call, state);
    if ('rejection' in access) {
      return access;
    }
    return this.build(call, state, access.stored);
  }

  private async prepare(call: Call, state: State): Promise<Prepared> {
    state.committing = false;
    try {
      if (!idSchema.safeParse(call.claimId).success) {
        throw new NotFoundError();
      }
      state.request = attachReceiptRequestSchema.parse(call.input);
    } catch (error) {
      return businessRejection(error, call.actor, call.context, call.expiresAt);
    }
    const access = await this.reread(call, state);
    if ('rejection' in access) {
      return access;
    }
    return this.build(call, state, access.stored);
  }

  /** The claim, strongly reread with its metadata, and the access rules. */
  private async reread(
    call: Call,
    state: State,
  ): Promise<
    { stored: StoredClaim; previous: Claim } | PreparedClaimRejection
  > {
    const stored = await this.deps.claimReader.getStored(call.claimId);
    const previous = stored?.claim;
    if (
      stored === undefined ||
      previous === undefined ||
      !canViewClaim(previous, call.actor)
    ) {
      return businessRejection(
        new NotFoundError('Claim not found.'),
        call.actor,
        call.context,
        call.expiresAt,
      );
    }
    try {
      assertVersion(previous, state.request!.expectedVersion);
    } catch (error) {
      return businessRejection(error, call.actor, call.context, call.expiresAt);
    }
    return { stored, previous };
  }

  /** The new receipt, if it is still pending, owned by the actor, and unexpired. */
  private async pendingReceipt(
    call: Call,
    state: State,
  ): Promise<PendingReceiptRecord | undefined> {
    const receipt = await this.deps.receipts.get(state.request!.receiptId);
    return receipt !== undefined &&
      receipt.state === 'PENDING' &&
      receipt.ownerId === call.actor.userId &&
      receipt.expiresAt >= call.request.nowEpoch
      ? receipt
      : undefined;
  }

  /** For a replacement, the old receipt's attached record, which must agree with the claim. */
  private async oldAttached(
    previous: Claim,
    state: State,
  ): Promise<AttachedReceiptRecord | undefined> {
    const old = previous.receipt;
    if (old === undefined || old.receiptId === state.request!.receiptId) {
      return undefined;
    }
    const record = await this.deps.receipts.get(old.receiptId);
    if (
      record === undefined ||
      record.state !== 'ATTACHED' ||
      record.attachedClaimId !== previous.claimId ||
      record.ownerId !== previous.employeeId
    ) {
      throw new ReceiptAttachmentIntegrityError();
    }
    return record;
  }

  private unavailable(call: Call): PreparedClaimRejection {
    return businessRejection(
      unavailable(),
      call.actor,
      call.context,
      call.expiresAt,
    );
  }

  /** Inspection, the domain decision, promotion, presentation, and the transaction. */
  private async build(
    call: Call,
    state: State,
    stored: StoredClaim,
  ): Promise<Prepared> {
    const { actor, context } = call;
    const previous = stored.claim;
    const request = state.request!;

    // The owner-and-draft rule comes before any receipt is read or inspected.
    try {
      assertEditable(previous, actor);
    } catch (error) {
      return businessRejection(error, actor, context, call.expiresAt);
    }
    const receipt = await this.pendingReceipt(call, state);
    if (receipt === undefined) {
      return this.unavailable(call);
    }
    const old = await this.oldAttached(previous, state);

    let upload: UploadedReceipt;
    try {
      upload = await this.deps.inspector.inspect(receipt);
    } catch (error) {
      if (error instanceof ReceiptUnavailableError) {
        return this.unavailable(call);
      }
      throw error;
    }

    let change: ClaimChange;
    try {
      change = attachReceipt(
        previous,
        upload,
        {
          contentType: request.contentType,
          sizeBytes: request.sizeBytes,
          checksumSha256: request.checksumSha256,
        },
        { actor, now: context.now },
      );
    } catch (error) {
      return businessRejection(error, actor, context, call.expiresAt);
    }

    try {
      await this.deps.objects.promote(receipt);
    } catch (error) {
      if (error instanceof ReceiptUnavailableError) {
        return this.unavailable(call);
      }
      throw error;
    }
    state.promoted = true;

    const names = await loadNames(
      this.deps.users,
      this.deps.categories,
      claimUserIds(change.claim),
    );
    const completed: CompletedRequest = {
      actorId: actor.userId,
      key: context.idempotencyKey,
      fingerprint: context.fingerprint,
      response: { status: 200, body: toClaimDto(change.claim, actor, names) },
      createdAt: context.now,
      expiresAt: call.expiresAt,
    };
    const attached: AttachedReceiptRecord = {
      receiptId: receipt.receiptId,
      ownerId: receipt.ownerId,
      state: 'ATTACHED',
      fileName: upload.fileName,
      contentType: upload.contentType,
      sizeBytes: upload.sizeBytes,
      checksumSha256: upload.checksumSha256,
      uploadedAt: upload.uploadedAt,
      attachedClaimId: previous.claimId,
    };
    const lastEventVersion = stored.metadata.lastEventVersion;

    let transaction;
    if (old === undefined) {
      transaction = this.deps.claims.prepareAttachReceipt(
        previous,
        change,
        receipt,
        attached,
        lastEventVersion,
        { events: [], idempotency: completed } satisfies CommitOptions,
      );
    } else {
      // One cleanup event ID per call, reused by every rebuild.
      state.eventId ??= this.deps.ids.newId();
      const event = buildReceiptDeletionEvent({
        eventId: state.eventId,
        correlationId: context.correlationId,
        causationId: context.requestId,
        actorId: actor.userId,
        occurredAt: context.now,
        claimVersion: change.claim.version,
        claimId: previous.claimId,
        receiptId: old.receiptId,
        objectKey: receiptObjectKey(old.receiptId),
      });
      transaction = this.deps.claims.prepareReplaceReceipt(
        {
          previousClaim: previous,
          change,
          newPendingReceipt: receipt,
          newAttachedReceipt: attached,
          oldAttachedReceipt: old,
          oldRetiredReceipt: {
            ...old,
            state: 'REPLACED',
            expiresAt: retiredReceiptExpiresAt(context.now),
          },
          storedLastEventVersion: lastEventVersion,
        },
        { events: [event], idempotency: completed },
      );
    }
    // The prepared transaction is about to be committed: it counts as an
    // attempt, and a cancellation of it is recoverable.
    state.commits += 1;
    state.committing = true;
    return { transaction, completed };
  }

  /**
   * After a confirmed success only: the winning record is a completed claim
   * snapshot that holds the receipt this call promoted. Best effort; the
   * lifecycle rule removes a leftover. The final object is never deleted here.
   */
  private async discardPending(
    state: State,
    record: IdempotencyRecord,
  ): Promise<void> {
    const receiptId = state.request?.receiptId;
    if (
      !state.promoted ||
      receiptId === undefined ||
      record.outcome !== 'COMPLETED' ||
      'resultRef' in record.response ||
      (record.response.body as { receipt?: { receiptId?: string } } | undefined)
        ?.receipt?.receiptId !== receiptId
    ) {
      return;
    }
    try {
      await this.deps.objects.deletePending(receiptId);
    } catch {
      this.deps.logger.warn('receipt.attach.pending_delete_failed', {
        operation,
      });
    }
  }
}

type Prepared = PreparedClaimMutation | PreparedClaimRejection;

/** One attach call: its trusted inputs, and what the coordinator needs. */
interface Call {
  readonly actor: Actor;
  readonly claimId: string;
  readonly input: unknown;
  readonly context: ClaimLifecycleContext;
  readonly request: ClaimMutationRequest;
  readonly expiresAt: number;
}

/** What the attempts so far decided, for recovery and cleanup. */
interface State {
  /** The parsed request, with the original expected version. */
  request?: AttachReceiptRequest;
  /** The cleanup event ID of a replacement, generated once. */
  eventId?: string;
  /** Whether this call promoted the object. */
  promoted: boolean;
  commits: number;
  committing: boolean;
}
