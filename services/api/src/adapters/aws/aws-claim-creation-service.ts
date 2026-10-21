import {
  createClaimRequestSchema,
  idempotencyKeySchema,
  idSchema,
  type CreateClaimRequest,
} from '@claimflow/contracts';
import { createDraftClaim, DomainError, type Actor } from '@claimflow/domain';
import { ZodError } from 'zod';

import {
  expiresAfter,
  toEpochSeconds,
  type CommitOptions,
  type CompletedRequest,
} from '../../application/commit.js';
import {
  ApplicationError,
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
import { toErrorReply } from '../../http/http-errors.js';
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
import { isIsoTimestamp, type StoredCategory } from './dynamodb-items.js';

/**
 * Claim creation on the AWS persistence, as an isolated service that no route
 * or composition uses yet (docs/aws-architecture.md, sections 8 to 10). It
 * runs through `ClaimMutationCoordinator`, so a replay returns the stored
 * result before any input is parsed, any category or user is read, any ID is
 * generated, or any domain rule runs. Only inside the lazy preparation does
 * it parse the raw input, read the category (keeping its version for the
 * category guard), apply the existing domain rule `createDraftClaim`, present
 * the claim with the existing presenter, and prepare the creation
 * transaction. The identity comes only from the trusted `Actor`.
 *
 * Only the expected business errors of parsing and of the domain decision
 * (schema, domain, and application errors that map to a client status) become
 * an explicit `REJECTED` record, using the same safe mapping and request ID as
 * the HTTP layer. Dependency, codec, preparation, and programming failures are
 * outside that catch and propagate unchanged, storing nothing. It adds no
 * event ID. After a cancelled commit (`TransactionCanceledException`, by SDK
 * error name only) it recovers within at most `maxCommitAttempts` prepared
 * commits: each recovery attempt first rechecks the idempotency record, then
 * rereads the generated claim ID and the guarded category, and either decides
 * the category change once, or rebuilds the unchanged decision after a
 * bounded, jittered backoff. A claim already at the generated ID is an
 * integrity failure. Logs carry only the operation and retry counts. Alarm and
 * metric wiring is deferred.
 */

export interface AwsClaimCreationServiceDependencies {
  readonly mutations: Pick<ClaimMutationCoordinator, 'run'>;
  readonly categories: Pick<DynamoDbCategoryReader, 'getStored' | 'list'>;
  readonly users: UserDirectory;
  readonly claims: Pick<DynamoDbClaimWriter, 'prepareCreate'>;
  /** The strongly consistent claim read used to check the generated ID. */
  readonly claimReader: Pick<DynamoDbClaimReader, 'get'>;
  readonly ids: IdGenerator;
  /** Waits `ms` milliseconds between recovery attempts. */
  readonly sleep: (ms: number) => Promise<void>;
  /** A number in [0, 1) used for the backoff jitter. */
  readonly random: () => number;
  readonly logger: Logger;
}

/** The generated claim ID is already in use without a stored result. */
export class ClaimCreationIntegrityError extends Error {
  public constructor() {
    super('The generated claim ID is already in use.');
    this.name = 'ClaimCreationIntegrityError';
  }
}

/** At most this many prepared business transactions are committed per create. */
export const maxCommitAttempts = 3;
/** The backoff before recovery attempt `n` is jittered below this ceiling. */
export const retryBaseDelayMs = 50;
export const retryMaxDelayMs = 500;

/** What the transport supplies for one create request. */
export interface ClaimCreationContext {
  readonly idempotencyKey: string;
  /** SHA-256 hex of the request, as stored with the key. */
  readonly fingerprint: string;
  /** The canonical time of the request (`toISOString`). */
  readonly now: string;
  readonly requestId: string;
}

const fingerprintPattern = /^[a-f0-9]{64}$/;
const operation = 'claim.create';

export class AwsClaimCreationService {
  public constructor(
    private readonly deps: AwsClaimCreationServiceDependencies,
  ) {
    if (typeof deps?.mutations?.run !== 'function') {
      throw new TypeError('The mutation coordinator is missing.');
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
    if (typeof deps.claims?.prepareCreate !== 'function') {
      throw new TypeError('The claim writer is missing.');
    }
    if (typeof deps.claimReader?.get !== 'function') {
      throw new TypeError('The claim reader is missing.');
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
   * The winning idempotency record: this request's `201` result, a stored or
   * concurrent result, or an explicit business rejection. Whether this request
   * committed or replayed is not reported.
   */
  public create(
    actor: Actor,
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
    return this.run({ actor, input, context, request, expiresAt });
  }

  /**
   * The first attempt, then the bounded recovery of a cancelled commit
   * (docs/aws-architecture.md, sections 9 and 10). Only a
   * `TransactionCanceledException` of a prepared business transaction is
   * recovered; every other failure propagates unchanged.
   */
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
        this.deps.logger.info('claim.create.retry', { operation, retries });
        await this.deps.sleep(this.delay(retries));
        prepare = () => this.recover(call, state);
      }
    }
  }

  /**
   * The cancellations are used up. Recheck the idempotency record and the
   * conditioned state a last time: a winner is returned, a claim in the
   * generated ID's place is an integrity failure, a category that changed
   * again is a persisted `VERSION_CONFLICT`, a category changed for the first
   * time is decided once more (a rejection is persisted), and anything else,
   * including a creation that is still valid but has no commit left, is an
   * unresolved cancellation, rethrown unchanged and never labelled as a
   * conflict.
   */
  private async settle(
    call: Call,
    state: State,
    cancellation: unknown,
    retries: number,
  ): Promise<IdempotencyRecord> {
    state.committing = false;
    return this.deps.mutations.run(call.request, async () => {
      await this.assertClaimAbsent(state);
      const reread = await this.rereadCategory(state);
      if (reread.changed) {
        if (state.categoryChanged) {
          return businessRejection(
            new VersionConflictError(),
            call.actor,
            call.context,
            call.expiresAt,
          );
        }
        // The first change: only the category and domain decision is re-run.
        // A rejection is persisted; a still valid creation has no commit left.
        const decision = this.judge(
          call,
          state.parsed!,
          reread.stored,
          state.claimId!,
        );
        if ('rejection' in decision) {
          return decision;
        }
      }
      this.deps.logger.warn('claim.create.retries_exhausted', {
        operation,
        retries,
      });
      throw cancellation;
    });
  }

  /**
   * One recovery attempt, inside a coordinator run so that the idempotency
   * record has just been rechecked. Every conditioned item is reread: the
   * generated claim ID must still be free, and a guarded category is compared
   * with the version the last attempt used. A category that is missing,
   * inactive, or newer re-runs the category and domain decision once with the
   * reread category; a second change is a persisted `VERSION_CONFLICT`.
   * Unchanged state rebuilds the same decision (rereading the presentation
   * data) for another commit. The claim ID and context never change.
   */
  private async recover(call: Call, state: State): Promise<Prepared> {
    state.committing = false;
    await this.assertClaimAbsent(state);
    const reread = await this.rereadCategory(state);
    if (reread.changed) {
      if (state.categoryChanged) {
        return businessRejection(
          new VersionConflictError(),
          call.actor,
          call.context,
          call.expiresAt,
        );
      }
      state.categoryChanged = true;
    }
    return this.decide(
      call,
      state.parsed!,
      reread.stored,
      state.claimId!,
      state,
    );
  }

  private async assertClaimAbsent(state: State): Promise<void> {
    if ((await this.deps.claimReader.get(state.claimId!)) !== undefined) {
      throw new ClaimCreationIntegrityError();
    }
  }

  /** The guarded category, strongly reread, and whether it changed. */
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

  private delay(retries: number): number {
    return backoffDelay(retries, this.deps.random);
  }

  private async prepare(call: Call, state: State): Promise<Prepared> {
    state.committing = false;
    let parsed: CreateClaimRequest;
    try {
      parsed = createClaimRequestSchema.parse(call.input);
    } catch (error) {
      return businessRejection(error, call.actor, call.context, call.expiresAt);
    }

    const stored =
      parsed.categoryId === undefined
        ? undefined
        : await this.deps.categories.getStored(parsed.categoryId);
    const claimId = this.deps.ids.newId();
    state.parsed = parsed;
    state.claimId = claimId;
    return this.decide(call, parsed, stored, claimId, state);
  }

  /**
   * The category and domain decision alone: the new draft, or the explicit
   * business rejection. Dependency failures are not caught here.
   */
  private judge(
    call: Call,
    parsed: CreateClaimRequest,
    stored: StoredCategory | undefined,
    claimId: string,
  ): { change: ReturnType<typeof createDraftClaim> } | PreparedClaimRejection {
    try {
      return {
        change: createDraftClaim(claimId, parsed, stored?.category, {
          actor: call.actor,
          now: call.context.now,
        }),
      };
    } catch (error) {
      return businessRejection(error, call.actor, call.context, call.expiresAt);
    }
  }

  /** The category and domain decision, the presentation, and the transaction. */
  private async decide(
    call: Call,
    parsed: CreateClaimRequest,
    stored: StoredCategory | undefined,
    claimId: string,
    state: State,
  ): Promise<Prepared> {
    const { actor, context, expiresAt } = call;

    const decision = this.judge(call, parsed, stored, claimId);
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
      actorId: actor.userId,
      key: context.idempotencyKey,
      fingerprint: context.fingerprint,
      response: { status: 201, body: toClaimDto(change.claim, actor, names) },
      createdAt: context.now,
      expiresAt,
    };
    const categoryId = change.claim.categoryId;
    let options: CommitOptions = { events: [], idempotency: completed };
    let guard: State['guard'];
    if (categoryId !== undefined && stored !== undefined) {
      guard = { categoryId, readVersion: stored.category.version };
      options = {
        ...options,
        categoryGuard: { ...guard, mustBeActive: true },
      };
    }
    const transaction = this.deps.claims.prepareCreate(change, options);
    // The prepared transaction is about to be committed: it counts as an
    // attempt, and a cancellation of it is recoverable.
    state.guard = guard;
    state.commits += 1;
    state.committing = true;
    return { transaction, completed };
  }
}

type Prepared = PreparedClaimMutation | PreparedClaimRejection;

/** One create call: its trusted inputs, and what the coordinator needs. */
interface Call {
  readonly actor: Actor;
  readonly input: unknown;
  readonly context: ClaimCreationContext;
  readonly request: ClaimMutationRequest;
  readonly expiresAt: number;
}

/** What the attempts so far decided, for recovery. */
interface State {
  parsed?: CreateClaimRequest;
  claimId?: string;
  /** The category version the latest prepared transaction was guarded by. */
  guard?:
    { readonly categoryId: string; readonly readVersion: number } | undefined;
  /** Prepared business transactions handed to the committer. */
  commits: number;
  /** Whether the latest preparation returned a transaction to commit. */
  committing: boolean;
  /** Whether the one allowed category change has been used. */
  categoryChanged: boolean;
}

/** Exponential backoff with equal jitter, bounded by `retryMaxDelayMs`. */
export function backoffDelay(retries: number, random: () => number): number {
  const ceiling = Math.min(
    retryMaxDelayMs,
    retryBaseDelayMs * 2 ** (retries - 1),
  );
  const sample = random();
  const jitter = Number.isFinite(sample) ? Math.min(Math.max(sample, 0), 1) : 0;
  return Math.min(ceiling, Math.floor(ceiling / 2 + (jitter * ceiling) / 2));
}

/** Missing, inactive, or at another version than the one the attempt read. */
export function categoryChanged(
  reread: StoredCategory | undefined,
  readVersion: number,
): boolean {
  return (
    reread === undefined ||
    !reread.category.active ||
    reread.category.version !== readVersion
  );
}

/** The SDK error type of a cancelled transaction, never its message. */
export function isCancellation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'TransactionCanceledException'
  );
}

/**
 * An expected business error as an explicit rejection record, using the HTTP
 * layer's safe error mapping. Any other error, and any mapped server error, is
 * rethrown unchanged.
 */
export function businessRejection(
  error: unknown,
  actor: Actor,
  context: ClaimCreationContext,
  expiresAt: number,
): PreparedClaimRejection {
  if (!(
    error instanceof ApplicationError ||
    error instanceof DomainError ||
    error instanceof ZodError
  )) {
    throw error;
  }
  const reply = toErrorReply(error, context.requestId);
  if (reply.status >= 500) {
    throw error;
  }
  return {
    rejection: {
      actorId: actor.userId,
      key: context.idempotencyKey,
      fingerprint: context.fingerprint,
      outcome: 'REJECTED',
      response: { status: reply.status, body: reply.body },
      createdAt: context.now,
      expiresAt,
    },
  };
}

export function checkContext(
  actor: Actor,
  context: ClaimCreationContext,
): void {
  if (
    typeof actor !== 'object' ||
    actor === null ||
    !idSchema.safeParse(actor.userId).success
  ) {
    throw new TypeError('The actor is not valid.');
  }
  if (typeof context !== 'object' || context === null) {
    throw new TypeError('The request context is missing.');
  }
  if (!idempotencyKeySchema.safeParse(context.idempotencyKey).success) {
    throw new TypeError('The idempotency key is not valid.');
  }
  if (
    typeof context.fingerprint !== 'string' ||
    !fingerprintPattern.test(context.fingerprint)
  ) {
    throw new TypeError('The request fingerprint is not valid.');
  }
  if (typeof context.now !== 'string' || !isIsoTimestamp(context.now)) {
    throw new TypeError('The request time is not valid.');
  }
  if (typeof context.requestId !== 'string' || !isTraceId(context.requestId)) {
    throw new TypeError('The request ID is not valid.');
  }
}
