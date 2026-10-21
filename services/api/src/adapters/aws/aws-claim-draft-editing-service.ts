import {
  idSchema,
  updateClaimRequestSchema,
  type UpdateClaimRequest,
} from '@claimflow/contracts';
import {
  canViewClaim,
  updateDraftClaim,
  type Actor,
  type Claim,
  type ClaimChange,
} from '@claimflow/domain';

import { assertVersion } from '../../application/claim-access.js';
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
import type { Logger, UserDirectory } from '../../application/ports.js';
import {
  claimUserIds,
  loadNames,
  toClaimDto,
} from '../../application/presenters.js';
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
 * Draft editing on the AWS persistence, as an isolated service that no route
 * or composition uses yet (docs/aws-architecture.md, sections 8 to 10). Like
 * the creation service it runs through `ClaimMutationCoordinator`, so a
 * replay returns the stored result before the input is parsed, any claim,
 * category, or user is read, or any domain rule runs. Only inside the lazy
 * preparation does it validate the claim ID, parse the update, strongly read
 * the claim with its `lastEventVersion` (`getStored`), apply the existing
 * visibility, version, and `updateDraftClaim` rules, read the category
 * policy only when the edit enters a different defined category (an unchanged
 * category stays editable even if inactive), present the claim, and prepare
 * the transaction with `prepareUpdateDraft`, with no events and, when
 * entering a category, a `mustBeActive` guard at the version read. The
 * identity comes only from the trusted `Actor`, and no ID is generated.
 *
 * Only expected input, access, and domain business errors become explicit
 * `REJECTED` records (a missing or invisible claim is the same `NOT_FOUND`
 * as the current service gives), using the HTTP layer's safe mapping and the
 * request ID. Dependency, codec, presentation, and preparation failures
 * propagate unchanged and store nothing.
 *
 * After a cancelled commit (`TransactionCanceledException`, by SDK error name
 * only) it recovers within at most `maxCommitAttempts` prepared commits, as
 * the creation service does: each attempt rechecks the idempotency record,
 * rereads the claim (a missing or invisible claim, or a version other than
 * the expected one, is a business rejection; the edit is never applied to a
 * newer claim), rereads the source category whose counter is decremented
 * (a missing category or a count below one is an integrity failure) and the
 * guarded destination category, then re-decides a first destination change
 * once, or rebuilds unchanged state after a bounded, jittered backoff. Logs
 * carry only the operation and retry counts. Alarm and metric wiring is
 * deferred.
 */

export interface AwsClaimDraftEditingServiceDependencies {
  readonly mutations: Pick<ClaimMutationCoordinator, 'run'>;
  readonly claimReader: Pick<DynamoDbClaimReader, 'getStored'>;
  readonly categories: Pick<DynamoDbCategoryReader, 'getStored' | 'list'>;
  readonly users: UserDirectory;
  readonly claims: Pick<DynamoDbClaimWriter, 'prepareUpdateDraft'>;
  /** Waits `ms` milliseconds between recovery attempts. */
  readonly sleep: (ms: number) => Promise<void>;
  /** A number in [0, 1) used for the backoff jitter. */
  readonly random: () => number;
  readonly logger: Logger;
}

/** The category whose counter must drop is missing or already at zero. */
export class ClaimEditIntegrityError extends Error {
  public constructor() {
    super('The category counter of the claim is inconsistent.');
    this.name = 'ClaimEditIntegrityError';
  }
}

const operation = 'claim.update';

export class AwsClaimDraftEditingService {
  public constructor(
    private readonly deps: AwsClaimDraftEditingServiceDependencies,
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
    if (typeof deps.claims?.prepareUpdateDraft !== 'function') {
      throw new TypeError('The claim writer is missing.');
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
  public update(
    actor: Actor,
    claimId: string,
    input: unknown,
    context: ClaimCreationContext,
  ): Promise<IdempotencyRecord> {
    checkContext(actor, context);
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
    return this.run({ actor, claimId, input, context, request, expiresAt });
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
        this.deps.logger.info('claim.update.retry', { operation, retries });
        await this.deps.sleep(backoffDelay(retries, this.deps.random));
        prepare = () => this.recover(call, state);
      }
    }
  }

  /**
   * The cancellations are used up. Recheck the idempotency record and every
   * conditioned item a last time: a winner is returned; a claim that is gone,
   * invisible, or at another version is a business rejection; an inconsistent
   * source counter is an integrity failure; a destination category that
   * changed again is a persisted `VERSION_CONFLICT`; one changed for the first
   * time is decided once more (a rejection is persisted); and anything else,
   * including an edit that is still valid but has no commit left, is an
   * unresolved cancellation, rethrown unchanged and never labelled a conflict.
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
      await this.assertSourceCounter(state);
      const destination = await this.rereadDestination(state);
      if (destination.changed) {
        if (state.categoryChanged) {
          return this.conflict(call);
        }
        const decision = this.judge(
          call,
          access.previous,
          state.update!,
          destination.stored,
        );
        if ('rejection' in decision) {
          return decision;
        }
      }
      this.deps.logger.warn('claim.update.retries_exhausted', {
        operation,
        retries,
      });
      throw cancellation;
    });
  }

  /**
   * One recovery attempt, inside a coordinator run so that the idempotency
   * record has just been rechecked. The claim, the source counter, and the
   * destination guard are reread; a first destination change re-runs the
   * domain decision with the reread category, a second one is a persisted
   * `VERSION_CONFLICT`, and unchanged state rebuilds the same decision.
   */
  private async recover(call: Call, state: State): Promise<Prepared> {
    state.committing = false;
    const access = await this.reread(call, state);
    if ('rejection' in access) {
      return access;
    }
    await this.assertSourceCounter(state);
    const destination = await this.rereadDestination(state);
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
    let update: UpdateClaimRequest;
    try {
      if (!idSchema.safeParse(call.claimId).success) {
        throw new NotFoundError();
      }
      update = updateClaimRequestSchema.parse(call.input);
    } catch (error) {
      return businessRejection(error, call.actor, call.context, call.expiresAt);
    }
    state.update = update;

    const access = await this.reread(call, state);
    if ('rejection' in access) {
      return access;
    }
    const { previous } = access;
    const { expectedVersion: _expectedVersion, ...changes } = update;
    const entering =
      typeof changes.categoryId === 'string' &&
      changes.categoryId !== previous.categoryId
        ? await this.deps.categories.getStored(changes.categoryId)
        : undefined;
    return this.decide(call, state, access.stored, entering);
  }

  /**
   * The claim, strongly reread with its metadata, and the existing access
   * rules: a missing or invisible claim is `NOT_FOUND`, and a version other
   * than the expected one is `VERSION_CONFLICT`.
   */
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
      assertVersion(previous, state.update!.expectedVersion);
    } catch (error) {
      return businessRejection(error, call.actor, call.context, call.expiresAt);
    }
    return { stored, previous };
  }

  /** A category counter that must drop is present and at least one. */
  private async assertSourceCounter(state: State): Promise<void> {
    if (state.source === undefined) {
      return;
    }
    const source = await this.deps.categories.getStored(state.source);
    if (source === undefined || source.metadata.claimCount < 1) {
      throw new ClaimEditIntegrityError();
    }
  }

  /** The guarded destination category, strongly reread, and whether it changed. */
  private async rereadDestination(
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

  /** The domain decision alone: the new draft, or the business rejection. */
  private judge(
    call: Call,
    previous: Claim,
    update: UpdateClaimRequest,
    entering: StoredCategory | undefined,
  ): { change: ClaimChange } | PreparedClaimRejection {
    const { expectedVersion: _expectedVersion, ...changes } = update;
    try {
      return {
        change: updateDraftClaim(previous, changes, entering?.category, {
          actor: call.actor,
          now: call.context.now,
        }),
      };
    } catch (error) {
      return businessRejection(error, call.actor, call.context, call.expiresAt);
    }
  }

  /** The decision, the presentation, and the transaction of one attempt. */
  private async decide(
    call: Call,
    state: State,
    stored: StoredClaim,
    entering: StoredCategory | undefined,
  ): Promise<Prepared> {
    const previous = stored.claim;
    const decision = this.judge(call, previous, state.update!, entering);
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
    const options = optionsFor(previous, change, completed, entering);
    const transaction = this.deps.claims.prepareUpdateDraft(
      previous,
      change,
      stored.metadata.lastEventVersion,
      options,
    );
    // The prepared transaction is about to be committed: it counts as an
    // attempt, and a cancellation of it is recoverable.
    state.guard =
      options.categoryGuard === undefined
        ? undefined
        : {
            categoryId: options.categoryGuard.categoryId,
            readVersion: options.categoryGuard.readVersion,
          };
    state.source =
      previous.categoryId !== undefined &&
      change.claim.categoryId !== previous.categoryId
        ? previous.categoryId
        : undefined;
    state.commits += 1;
    state.committing = true;
    return { transaction, completed };
  }
}

type Prepared = PreparedClaimMutation | PreparedClaimRejection;

/** One update call: its trusted inputs, and what the coordinator needs. */
interface Call {
  readonly actor: Actor;
  readonly claimId: string;
  readonly input: unknown;
  readonly context: ClaimCreationContext;
  readonly request: ClaimMutationRequest;
  readonly expiresAt: number;
}

/** What the attempts so far decided, for recovery. */
interface State {
  /** The parsed update, with the original expected version. */
  update?: UpdateClaimRequest;
  /** The destination guard of the latest prepared transaction, if any. */
  guard?:
    { readonly categoryId: string; readonly readVersion: number } | undefined;
  /** The category whose counter the latest prepared transaction decrements. */
  source?: string | undefined;
  /** Prepared business transactions handed to the committer. */
  commits: number;
  /** Whether the latest preparation returned a transaction to commit. */
  committing: boolean;
  /** Whether the one allowed destination change has been used. */
  categoryChanged: boolean;
}

/** Empty events, and a guard only when entering a different defined category. */
function optionsFor(
  previous: Claim,
  change: ClaimChange,
  completed: CompletedRequest,
  entering: StoredCategory | undefined,
): CommitOptions {
  const categoryId = change.claim.categoryId;
  if (
    categoryId === undefined ||
    categoryId === previous.categoryId ||
    entering === undefined
  ) {
    return { events: [], idempotency: completed };
  }
  return {
    events: [],
    idempotency: completed,
    categoryGuard: {
      categoryId,
      readVersion: entering.category.version,
      mustBeActive: true,
    },
  };
}
