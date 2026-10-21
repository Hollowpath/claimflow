import {
  claimActionRequestSchema,
  deleteRequestSchema,
  idSchema,
} from '@claimflow/contracts';
import {
  assertMayDeleteClaim,
  canViewClaim,
  removeReceipt,
  type Actor,
  type Claim,
} from '@claimflow/domain';

import { assertVersion } from '../../application/claim-access.js';
import {
  buildHistoryPurgeEvent,
  buildReceiptDeletionEvent,
} from '../../application/cleanup-events.js';
import {
  expiresAfter,
  toEpochSeconds,
  type CompletedRequest,
} from '../../application/commit.js';
import { NotFoundError } from '../../application/errors.js';
import type { OutboxEvent } from '../../application/events.js';
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
import type {
  DeleteDraftInput,
  DynamoDbClaimWriter,
} from './dynamodb-claim-writer.js';
import type { IdempotencyRecord } from './dynamodb-idempotency-items.js';
import type { StoredClaim } from './dynamodb-items.js';
import type { DynamoDbReceiptMetadataReader } from './dynamodb-lookups.js';
import {
  receiptObjectKey,
  retiredReceiptExpiresAt,
  type AttachedReceiptRecord,
} from './dynamodb-receipt-items.js';

/**
 * The two removal flows of docs/aws-architecture.md, sections 8 to 12, as
 * isolated services that no route or composition uses yet: removing a draft's
 * receipt (the updated claim, `200`) and deleting a never-submitted draft
 * (`204`). Each runs through `ClaimMutationCoordinator`, so a replay returns
 * the stored result before anything is parsed or read. Inside the lazy
 * preparation each validates the claim ID, parses its strict request,
 * strongly reads the claim and applies the visibility and `expectedVersion`
 * rules and the existing domain rule (`removeReceipt`, `assertMayDeleteClaim`),
 * reads the receipt record the claim's receipt must agree with, and prepares
 * one atomic transaction: the claim change, the category counter decrement
 * (deletion), the receipt's `REMOVED` metadata, the cleanup events, and the
 * idempotency result. Neither flow deletes an object or purges history: the
 * cleanup worker does both from the events. Expected input, access, and
 * domain errors become explicit `REJECTED` records; dependency, codec, and
 * programming failures, and the integrity failures below, propagate
 * unchanged and store nothing.
 *
 * A cancelled commit is recovered within `maxCommitAttempts` prepared commits
 * as in the claim services: each attempt rechecks the idempotency record
 * first, then rereads the conditioned state (the claim: a missing or invisible
 * claim is `NOT_FOUND` and another version is `VERSION_CONFLICT`; the
 * receipt's record, which must still be attached to the claim; and for a
 * deletion the category counter, which must exist and be at least one), keeps
 * the event IDs and context, and rebuilds after a bounded, jittered backoff.
 * A record or counter that contradicts the claim is an integrity failure with
 * a fixed message. At exhaustion the same checks run and an unresolved
 * cancellation is rethrown unchanged.
 */

export interface AwsClaimRemovalDependencies {
  readonly mutations: Pick<ClaimMutationCoordinator, 'run'>;
  readonly claimReader: Pick<DynamoDbClaimReader, 'getStored'>;
  readonly receipts: Pick<DynamoDbReceiptMetadataReader, 'get'>;
  readonly categories: Pick<DynamoDbCategoryReader, 'getStored' | 'list'>;
  readonly users: UserDirectory;
  readonly ids: IdGenerator;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
  readonly logger: Logger;
}

export interface AwsReceiptRemovalServiceDependencies extends AwsClaimRemovalDependencies {
  readonly claims: Pick<DynamoDbClaimWriter, 'prepareRemoveReceipt'>;
}

export interface AwsDraftDeletionServiceDependencies extends AwsClaimRemovalDependencies {
  readonly claims: Pick<DynamoDbClaimWriter, 'prepareDeleteDraft'>;
}

/** The receipt record or the category counter contradicts the claim. */
export class ClaimRemovalIntegrityError extends Error {
  public constructor() {
    super('The receipt or category records of the claim are inconsistent.');
    this.name = 'ClaimRemovalIntegrityError';
  }
}

/** One removal call: its trusted inputs, and what the coordinator needs. */
interface Call {
  readonly actor: Actor;
  readonly claimId: string;
  readonly input: unknown;
  readonly context: ClaimLifecycleContext;
  readonly request: ClaimMutationRequest;
  readonly expiresAt: number;
  readonly operation: string;
}

interface State {
  expectedVersion?: number;
  /** Event IDs of this call, generated once and reused by every rebuild. */
  purgeEventId?: string;
  receiptEventId?: string;
  commits: number;
  committing: boolean;
}

type Prepared = PreparedClaimMutation | PreparedClaimRejection;

/** What differs between the two flows. */
interface Flow {
  readonly operation: string;
  /** Parse the strict request; throws a business error. */
  parse(input: unknown): { expectedVersion: number };
  /** The domain decision, the presentation, and the transaction. */
  decide(call: Call, state: State, stored: StoredClaim): Promise<Prepared>;
  /** Reread the conditioned state besides the claim; throws on contradiction. */
  recheck(previous: Claim): Promise<void>;
}

function begin(
  actor: Actor,
  claimId: string,
  input: unknown,
  context: ClaimLifecycleContext,
  operation: string,
): { call: Call; state: State } {
  checkContext(actor, context);
  if (
    typeof context.correlationId !== 'string' ||
    !isTraceId(context.correlationId)
  ) {
    throw new TypeError('The correlation ID is not valid.');
  }
  return {
    call: {
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
      operation,
    },
    state: { commits: 0, committing: false },
  };
}

function checkDependencies(deps: AwsClaimRemovalDependencies): void {
  if (typeof deps?.mutations?.run !== 'function') {
    throw new TypeError('The mutation coordinator is missing.');
  }
  if (typeof deps.claimReader?.getStored !== 'function') {
    throw new TypeError('The claim reader is missing.');
  }
  if (typeof deps.receipts?.get !== 'function') {
    throw new TypeError('The receipt metadata reader is missing.');
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

/** The claim, strongly reread with its metadata, and the access rules. */
async function reread(
  deps: AwsClaimRemovalDependencies,
  call: Call,
  state: State,
): Promise<{ stored: StoredClaim; previous: Claim } | PreparedClaimRejection> {
  const stored = await deps.claimReader.getStored(call.claimId);
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

/** The first attempt, then the bounded recovery of a cancelled commit. */
async function runFlow(
  deps: AwsClaimRemovalDependencies,
  flow: Flow,
  call: Call,
  state: State,
): Promise<IdempotencyRecord> {
  const first = async (): Promise<Prepared> => {
    state.committing = false;
    try {
      if (!idSchema.safeParse(call.claimId).success) {
        throw new NotFoundError();
      }
      state.expectedVersion = flow.parse(call.input).expectedVersion;
    } catch (error) {
      return businessRejection(error, call.actor, call.context, call.expiresAt);
    }
    const access = await reread(deps, call, state);
    if ('rejection' in access) {
      return access;
    }
    return flow.decide(call, state, access.stored);
  };
  const recover = async (): Promise<Prepared> => {
    state.committing = false;
    const access = await reread(deps, call, state);
    if ('rejection' in access) {
      return access;
    }
    await flow.recheck(access.previous);
    return flow.decide(call, state, access.stored);
  };
  const settle = (cancellation: unknown, retries: number) => {
    state.committing = false;
    return deps.mutations.run(call.request, async () => {
      const access = await reread(deps, call, state);
      if ('rejection' in access) {
        return access;
      }
      await flow.recheck(access.previous);
      deps.logger.warn(`${flow.operation}.retries_exhausted`, {
        operation: call.operation,
        retries,
      });
      throw cancellation;
    });
  };

  let prepare = first;
  let retries = 0;
  for (;;) {
    try {
      return await deps.mutations.run(call.request, prepare);
    } catch (error) {
      if (!isCancellation(error) || !state.committing) {
        throw error;
      }
      if (state.commits >= maxCommitAttempts) {
        return settle(error, retries);
      }
      retries += 1;
      deps.logger.info(`${flow.operation}.retry`, {
        operation: call.operation,
        retries,
      });
      await deps.sleep(backoffDelay(retries, deps.random));
      prepare = recover;
    }
  }
}

/** The claim's receipt record: attached to this claim and owned by its employee. */
async function attachedRecord(
  deps: AwsClaimRemovalDependencies,
  claim: Claim,
): Promise<AttachedReceiptRecord | undefined> {
  if (claim.receipt === undefined) {
    return undefined;
  }
  const record = await deps.receipts.get(claim.receipt.receiptId);
  if (
    record === undefined ||
    record.state !== 'ATTACHED' ||
    record.attachedClaimId !== claim.claimId ||
    record.ownerId !== claim.employeeId
  ) {
    throw new ClaimRemovalIntegrityError();
  }
  return record;
}

async function presented(
  deps: AwsClaimRemovalDependencies,
  claim: Claim,
  actor: Actor,
) {
  const names = await loadNames(
    deps.users,
    deps.categories,
    claimUserIds(claim),
  );
  return toClaimDto(claim, actor, names);
}

/** Removes a draft's receipt: the updated claim, as the local flow returns it. */
export class AwsReceiptRemovalService {
  public constructor(
    private readonly deps: AwsReceiptRemovalServiceDependencies,
  ) {
    checkDependencies(deps);
    if (typeof deps.claims?.prepareRemoveReceipt !== 'function') {
      throw new TypeError('The claim writer is missing.');
    }
  }

  /** The winning record: the `200` claim snapshot, or a stored rejection. */
  public remove(
    actor: Actor,
    claimId: string,
    input: unknown,
    context: ClaimLifecycleContext,
  ): Promise<IdempotencyRecord> {
    const { call, state } = begin(
      actor,
      claimId,
      input,
      context,
      'receipt.remove',
    );
    const deps = this.deps;
    const flow: Flow = {
      operation: 'receipt.remove',
      parse: (value) => claimActionRequestSchema.parse(value),
      recheck: async (previous) => {
        await attachedRecord(deps, previous);
      },
      decide: async (c, s, stored) => {
        const previous = stored.claim;
        let change;
        try {
          change = removeReceipt(previous, {
            actor: c.actor,
            now: c.context.now,
          });
        } catch (error) {
          return businessRejection(error, c.actor, c.context, c.expiresAt);
        }
        const attached = await attachedRecord(deps, previous);
        if (attached === undefined) {
          throw new ClaimRemovalIntegrityError();
        }
        const completed: CompletedRequest = {
          actorId: c.actor.userId,
          key: c.context.idempotencyKey,
          fingerprint: c.context.fingerprint,
          response: {
            status: 200,
            body: await presented(deps, change.claim, c.actor),
          },
          createdAt: c.context.now,
          expiresAt: c.expiresAt,
        };
        s.receiptEventId ??= deps.ids.newId();
        const event = buildReceiptDeletionEvent({
          eventId: s.receiptEventId,
          correlationId: c.context.correlationId,
          causationId: c.context.requestId,
          actorId: c.actor.userId,
          occurredAt: c.context.now,
          claimVersion: change.claim.version,
          claimId: previous.claimId,
          receiptId: attached.receiptId,
          objectKey: receiptObjectKey(attached.receiptId),
        });
        const transaction = deps.claims.prepareRemoveReceipt(
          {
            previousClaim: previous,
            change,
            attachedReceipt: attached,
            retiredReceipt: {
              ...attached,
              state: 'REMOVED',
              expiresAt: retiredReceiptExpiresAt(c.context.now),
            },
            storedLastEventVersion: stored.metadata.lastEventVersion,
          },
          { events: [event], idempotency: completed },
        );
        s.commits += 1;
        s.committing = true;
        return { transaction, completed };
      },
    };
    return runFlow(this.deps, flow, call, state);
  }
}

/** Deletes a never-submitted draft: `204`, as the local flow returns it. */
export class AwsDraftDeletionService {
  public constructor(
    private readonly deps: AwsDraftDeletionServiceDependencies,
  ) {
    checkDependencies(deps);
    if (typeof deps.claims?.prepareDeleteDraft !== 'function') {
      throw new TypeError('The claim writer is missing.');
    }
  }

  /** The winning record: the `204` result, or a stored rejection. */
  public delete(
    actor: Actor,
    claimId: string,
    input: unknown,
    context: ClaimLifecycleContext,
  ): Promise<IdempotencyRecord> {
    const { call, state } = begin(
      actor,
      claimId,
      input,
      context,
      'claim.delete',
    );
    const deps = this.deps;
    const flow: Flow = {
      operation: 'claim.delete',
      parse: (value) => deleteRequestSchema.parse(value),
      recheck: async (previous) => {
        await attachedRecord(deps, previous);
        await counterIsPositive(deps, previous);
      },
      decide: async (c, s, stored) => {
        const claim = stored.claim;
        try {
          assertMayDeleteClaim(claim, c.actor);
        } catch (error) {
          return businessRejection(error, c.actor, c.context, c.expiresAt);
        }
        const attached = await attachedRecord(deps, claim);
        const completed: CompletedRequest = {
          actorId: c.actor.userId,
          key: c.context.idempotencyKey,
          fingerprint: c.context.fingerprint,
          response: { status: 204, body: undefined },
          createdAt: c.context.now,
          expiresAt: c.expiresAt,
        };
        const shared = {
          correlationId: c.context.correlationId,
          causationId: c.context.requestId,
          actorId: c.actor.userId,
          occurredAt: c.context.now,
          claimVersion: claim.version + 1,
          claimId: claim.claimId,
        };
        s.purgeEventId ??= deps.ids.newId();
        const events: OutboxEvent[] = [
          buildHistoryPurgeEvent({ ...shared, eventId: s.purgeEventId }),
        ];
        if (attached !== undefined) {
          s.receiptEventId ??= deps.ids.newId();
          events.push(
            buildReceiptDeletionEvent({
              ...shared,
              eventId: s.receiptEventId,
              receiptId: attached.receiptId,
              objectKey: receiptObjectKey(attached.receiptId),
            }),
          );
        }
        const input: DeleteDraftInput = {
          claim,
          actorId: c.actor.userId,
          changedAt: c.context.now,
          ...(attached === undefined
            ? {}
            : {
                attachedReceipt: attached,
                retiredReceipt: {
                  ...attached,
                  state: 'REMOVED',
                  expiresAt: retiredReceiptExpiresAt(c.context.now),
                },
              }),
        };
        const transaction = deps.claims.prepareDeleteDraft(input, {
          events,
          idempotency: completed,
        });
        s.commits += 1;
        s.committing = true;
        return { transaction, completed };
      },
    };
    return runFlow(this.deps, flow, call, state);
  }
}

/** The counter the deletion decrements exists and is at least one. */
async function counterIsPositive(
  deps: AwsClaimRemovalDependencies,
  claim: Claim,
): Promise<void> {
  if (claim.categoryId === undefined) {
    return;
  }
  const category = await deps.categories.getStored(claim.categoryId);
  if (category === undefined || category.metadata.claimCount < 1) {
    throw new ClaimRemovalIntegrityError();
  }
}
