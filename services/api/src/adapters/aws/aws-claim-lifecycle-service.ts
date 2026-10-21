import {
  claimActionPaths,
  claimActionRequestSchema,
  claimDecisionRequestSchema,
  idSchema,
} from '@claimflow/contracts';
import {
  approveClaim,
  canViewClaim,
  claimActions,
  markClaimPaid,
  rejectClaim,
  reopenClaim,
  startReview,
  submitClaim,
  type Actor,
  type Category,
  type Claim,
  type ClaimAction,
  type ClaimChange,
} from '@claimflow/domain';

import { assertVersion } from '../../application/claim-access.js';
import { buildClaimLifecycleEvent } from '../../application/claim-events.js';
import {
  expiresAfter,
  toEpochSeconds,
  type CommitOptions,
  type CompletedRequest,
} from '../../application/commit.js';
import {
  NotFoundError,
  VersionConflictError,
} from '../../application/errors.js';
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
import { isTraceId } from '../../application/tracing.js';
import {
  backoffDelay,
  businessRejection,
  categoryChanged,
  checkContext,
  isCancellation,
  maxCommitAttempts,
  type ClaimCreationContext,
} from './aws-claim-creation-service.js';
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
import type { StoredCategory, StoredClaim } from './dynamodb-items.js';

/**
 * The six claim lifecycle actions (SUBMIT, START_REVIEW, APPROVE, REJECT,
 * REOPEN, MARK_PAID) on the AWS persistence, as an isolated service that no
 * route or composition uses yet (docs/aws-architecture.md, sections 8 to 10
 * and 15). It runs through `ClaimMutationCoordinator`, so a replay returns
 * the stored result before anything is parsed, read, generated, or decided.
 * Only inside the lazy preparation does it validate the claim ID, parse the
 * action or decision request, strongly read the claim with its
 * `lastEventVersion`, apply the existing visibility and version rules and the
 * existing domain function of the action (ownership, assigned-manager,
 * self-review, payment, policy, and resubmission rules), present the claim,
 * generate the one event ID of the call, build the lifecycle event with the
 * supplied correlation ID and the request ID as causation ID, and prepare the
 * transaction: `prepareSubmit` with a `mustBeActive` category guard for
 * SUBMIT, `prepareUpdateLifecycle` without a guard for the others.
 *
 * Only expected input, access, and domain business errors become explicit
 * `REJECTED` records. Dependency, codec, presentation, event-building, and
 * preparation failures propagate unchanged and store nothing.
 *
 * After a cancelled commit (`TransactionCanceledException`, by SDK error name
 * only) it recovers within at most `maxCommitAttempts` prepared commits, as
 * the creation and edit services do: each attempt rechecks the idempotency
 * record, rereads the claim (missing or invisible is `NOT_FOUND`, another
 * version is `VERSION_CONFLICT`), and for SUBMIT rereads the guarded category
 * (a first change is decided once more, a second is `VERSION_CONFLICT`), then
 * rebuilds the decision with the same event ID after a bounded, jittered
 * backoff. At exhaustion the same checks run; a still valid action with no
 * commit left rethrows the unresolved cancellation. Logs carry only the
 * operation and retry counts.
 */

export interface AwsClaimLifecycleServiceDependencies {
  readonly mutations: Pick<ClaimMutationCoordinator, 'run'>;
  readonly claimReader: Pick<DynamoDbClaimReader, 'getStored'>;
  readonly categories: Pick<DynamoDbCategoryReader, 'getStored' | 'list'>;
  readonly users: UserDirectory;
  readonly claims: Pick<
    DynamoDbClaimWriter,
    'prepareSubmit' | 'prepareUpdateLifecycle'
  >;
  readonly ids: IdGenerator;
  /** Waits `ms` milliseconds between recovery attempts. */
  readonly sleep: (ms: number) => Promise<void>;
  /** A number in [0, 1) used for the backoff jitter. */
  readonly random: () => number;
  readonly logger: Logger;
}

/** The creation request context, plus the correlation ID of the event. */
export interface ClaimLifecycleContext extends ClaimCreationContext {
  readonly correlationId: string;
}

export class AwsClaimLifecycleService {
  public constructor(
    private readonly deps: AwsClaimLifecycleServiceDependencies,
  ) {
    if (typeof deps?.mutations?.run !== 'function') {
      throw new TypeError('The mutation coordinator is missing.');
    }
    if (typeof deps.claimReader?.getStored !== 'function') {
      throw new TypeError('The claim reader is missing.');
    }
    if (
      typeof deps.categories?.getStored !== 'function' ||
      typeof deps.categories.list !== 'function'
    ) {
      throw new TypeError('The category reader is missing.');
    }
    if (typeof deps.users?.getMany !== 'function') {
      throw new TypeError('The user directory is missing.');
    }
    if (
      typeof deps.claims?.prepareSubmit !== 'function' ||
      typeof deps.claims.prepareUpdateLifecycle !== 'function'
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
   * The winning idempotency record: this request's `200` result, a stored or
   * concurrent result, or an explicit business rejection. Whether this request
   * committed or replayed is not reported.
   */
  public perform(
    actor: Actor,
    claimId: string,
    action: ClaimAction,
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
    if (!(claimActions as readonly string[]).includes(action)) {
      throw new TypeError('The claim action is not valid.');
    }
    const request: ClaimMutationRequest = {
      actorId: actor.userId,
      key: context.idempotencyKey,
      fingerprint: context.fingerprint,
      nowEpoch: toEpochSeconds(new Date(context.now)),
    };
    const expiresAt = expiresAfter(
      new Date(context.now),
      idempotencyRetentionMs,
    );
    return this.run({
      actor,
      claimId,
      action,
      input,
      context,
      request,
      expiresAt,
      operation: `claim.${claimActionPaths[action]}`,
    });
  }

  /** The first attempt, then the bounded recovery of a cancelled commit. */
  private async run(call: Call): Promise<IdempotencyRecord> {
    const state: State = {
      commits: 0,
      committing: false,
      categoryChanged: false,
    };
    let prepare = (): Promise<Prepared> => this.prepare(call, state);
    let retries = 0;
    const { operation } = call;

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
        this.deps.logger.info('claim.lifecycle.retry', { operation, retries });
        await this.deps.sleep(backoffDelay(retries, this.deps.random));
        prepare = () => this.recover(call, state);
      }
    }
  }

  /**
   * The cancellations are used up. Recheck the idempotency record and every
   * conditioned item a last time: a winner is returned; a claim that is gone,
   * invisible, or at another version is a business rejection; for SUBMIT, a
   * category that changed again is a persisted `VERSION_CONFLICT` and one
   * changed for the first time is decided once more (a rejection is
   * persisted); anything else, including an action that is still valid but has
   * no commit left, is an unresolved cancellation, rethrown unchanged and
   * never labelled as a conflict.
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
      const destination = await this.rereadCategory(state);
      if (destination.changed) {
        if (state.categoryChanged) {
          return this.conflict(call);
        }
        const decision = this.judge(
          call,
          access.previous,
          state,
          destination.stored?.category,
        );
        if ('rejection' in decision) {
          return decision;
        }
      }
      this.deps.logger.warn('claim.lifecycle.retries_exhausted', {
        operation: call.operation,
        retries,
      });
      throw cancellation;
    });
  }

  /**
   * One recovery attempt, inside a coordinator run so that the idempotency
   * record has just been rechecked: reread the claim and, for SUBMIT, the
   * guarded category, then rebuild the decision (a first category change is
   * re-decided with the reread category, a second one is a persisted
   * `VERSION_CONFLICT`).
   */
  private async recover(call: Call, state: State): Promise<Prepared> {
    state.committing = false;
    const access = await this.reread(call, state);
    if ('rejection' in access) {
      return access;
    }
    const destination = await this.rereadCategory(state);
    if (destination.changed) {
      if (state.categoryChanged) {
        return this.conflict(call);
      }
      state.categoryChanged = true;
    }
    return this.decide(call, state, access.stored, destination.stored);
  }

  private async prepare(call: Call, state: State): Promise<Prepared> {
    state.committing = false;
    try {
      if (!idSchema.safeParse(call.claimId).success) {
        throw new NotFoundError();
      }
      const schema =
        call.action === 'APPROVE' || call.action === 'REJECT'
          ? claimDecisionRequestSchema
          : claimActionRequestSchema;
      const parsed = schema.parse(call.input) as {
        expectedVersion: number;
        comment?: string;
      };
      state.expectedVersion = parsed.expectedVersion;
      state.comment = parsed.comment ?? '';
    } catch (error) {
      return businessRejection(error, call.actor, call.context, call.expiresAt);
    }

    const access = await this.reread(call, state);
    if ('rejection' in access) {
      return access;
    }
    const category =
      call.action === 'SUBMIT' && access.previous.categoryId !== undefined
        ? await this.deps.categories.getStored(access.previous.categoryId)
        : undefined;
    return this.decide(call, state, access.stored, category);
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
      assertVersion(previous, state.expectedVersion!);
    } catch (error) {
      return businessRejection(error, call.actor, call.context, call.expiresAt);
    }
    return { stored, previous };
  }

  /** The guarded category of SUBMIT, strongly reread, and whether it changed. */
  private async rereadCategory(
    state: State,
  ): Promise<{ stored: StoredCategory | undefined; changed: boolean }> {
    if (state.guard === undefined) {
      return { stored: undefined, changed: false };
    }
    const stored = await this.deps.categories.getStored(state.guard.categoryId);
    return {
      stored,
      changed: categoryChanged(stored, state.guard.readVersion),
    };
  }

  private conflict(call: Call): PreparedClaimRejection {
    return businessRejection(
      new VersionConflictError(),
      call.actor,
      call.context,
      call.expiresAt,
    );
  }

  /** The existing domain function of the action, or the business rejection. */
  private judge(
    call: Call,
    claim: Claim,
    state: State,
    category: Category | undefined,
  ): { change: ClaimChange } | PreparedClaimRejection {
    const context = { actor: call.actor, now: call.context.now };
    try {
      switch (call.action) {
        case 'SUBMIT':
          return { change: submitClaim(claim, category, context) };
        case 'START_REVIEW':
          return { change: startReview(claim, context) };
        case 'APPROVE':
          return { change: approveClaim(claim, state.comment ?? '', context) };
        case 'REJECT':
          return { change: rejectClaim(claim, state.comment ?? '', context) };
        case 'REOPEN':
          return { change: reopenClaim(claim, context) };
        case 'MARK_PAID':
          return { change: markClaimPaid(claim, context) };
      }
    } catch (error) {
      return businessRejection(error, call.actor, call.context, call.expiresAt);
    }
  }

  /** The decision, the presentation, the event, and the transaction. */
  private async decide(
    call: Call,
    state: State,
    stored: StoredClaim,
    category: StoredCategory | undefined,
  ): Promise<Prepared> {
    const previous = stored.claim;
    const decision = this.judge(call, previous, state, category?.category);
    if ('rejection' in decision) {
      return decision;
    }
    const { change } = decision;

    const names = await loadNames(
      this.deps.users,
      this.deps.categories,
      claimUserIds(change.claim),
    );
    const completed: CompletedRequest = {
      actorId: call.actor.userId,
      key: call.context.idempotencyKey,
      fingerprint: call.context.fingerprint,
      response: {
        status: 200,
        body: toClaimDto(change.claim, call.actor, names),
      },
      createdAt: call.context.now,
      expiresAt: call.expiresAt,
    };
    // One event ID per call, generated lazily and reused by every rebuild.
    state.eventId ??= this.deps.ids.newId();
    const event = buildClaimLifecycleEvent(
      change,
      {
        eventId: state.eventId,
        correlationId: call.context.correlationId,
        causationId: call.context.requestId,
      },
      stored.metadata.lastEventVersion,
    );
    if (event === undefined) {
      throw new TypeError('A lifecycle action must publish an event.');
    }

    let transaction;
    let guard: State['guard'];
    if (call.action === 'SUBMIT') {
      const options = submitOptions(previous, category, event, completed);
      guard = options.guard;
      transaction = this.deps.claims.prepareSubmit(
        previous,
        change,
        stored.metadata.lastEventVersion,
        options.commit,
      );
    } else {
      transaction = this.deps.claims.prepareUpdateLifecycle(
        previous,
        change,
        stored.metadata.lastEventVersion,
        { events: [event], idempotency: completed },
      );
    }
    // The prepared transaction is about to be committed: it counts as an
    // attempt, and a cancellation of it is recoverable.
    state.guard = guard;
    state.commits += 1;
    state.committing = true;
    return { transaction, completed };
  }
}

type Prepared = PreparedClaimMutation | PreparedClaimRejection;

/** One perform call: its trusted inputs, and what the coordinator needs. */
interface Call {
  readonly actor: Actor;
  readonly claimId: string;
  readonly action: ClaimAction;
  readonly input: unknown;
  readonly context: ClaimLifecycleContext;
  readonly request: ClaimMutationRequest;
  readonly expiresAt: number;
  /** The route operation name, used in logs. */
  readonly operation: string;
}

/** What the attempts so far decided, for recovery. */
interface State {
  expectedVersion?: number;
  comment?: string;
  /** The event ID of this call, generated once. */
  eventId?: string;
  /** The category guard of the latest prepared SUBMIT, if any. */
  guard?:
    { readonly categoryId: string; readonly readVersion: number } | undefined;
  /** Prepared business transactions handed to the committer. */
  commits: number;
  /** Whether the latest preparation returned a transaction to commit. */
  committing: boolean;
  /** Whether the one allowed category change has been used. */
  categoryChanged: boolean;
}

/** SUBMIT's one event and the guard at the category version read. */
function submitOptions(
  previous: Claim,
  category: StoredCategory | undefined,
  event: NonNullable<ReturnType<typeof buildClaimLifecycleEvent>>,
  completed: CompletedRequest,
): { commit: CommitOptions; guard: State['guard'] } {
  if (previous.categoryId === undefined || category === undefined) {
    // Unreachable once `submitClaim` accepted the claim; the writer refuses it.
    return {
      commit: { events: [event], idempotency: completed },
      guard: undefined,
    };
  }
  const guard = {
    categoryId: previous.categoryId,
    readVersion: category.category.version,
  };
  return {
    commit: {
      events: [event],
      idempotency: completed,
      categoryGuard: { ...guard, mustBeActive: true },
    },
    guard,
  };
}
