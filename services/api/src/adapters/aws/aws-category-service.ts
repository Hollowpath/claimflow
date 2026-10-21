import {
  createCategoryRequestSchema,
  deleteRequestSchema,
  idSchema,
  updateCategoryRequestSchema,
} from '@claimflow/contracts';
import {
  assertMayDeleteCategory,
  createCategory,
  updateCategory,
  type Actor,
  type Category,
} from '@claimflow/domain';

import { assertVersion } from '../../application/claim-access.js';
import {
  buildCategoryCreatedEvent,
  buildCategoryDeletedEvent,
  buildCategoryUpdateEvents,
} from '../../application/category-events.js';
import { definedOnly } from '../../application/category-service.js';
import {
  expiresAfter,
  toEpochSeconds,
  type CompletedRequest,
} from '../../application/commit.js';
import { ApplicationError, NotFoundError } from '../../application/errors.js';
import { idempotencyRetentionMs } from '../../application/idempotency.js';
import type { IdGenerator, Logger } from '../../application/ports.js';
import { toCategoryDto } from '../../application/presenters.js';
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
import type { DynamoDbCategoryWriter } from './dynamodb-category-writer.js';
import type { IdempotencyRecord } from './dynamodb-idempotency-items.js';

/**
 * Category administration on AWS (docs/aws-architecture.md, sections 8 to 10
 * and 15), as an isolated service for the opt-in request pipeline: create
 * (`201`), update (`200`), and delete (`204`), each through
 * `ClaimMutationCoordinator`, so a replay returns the stored result before
 * anything is parsed or read. The rules are the local `CategoryService`'s, in
 * its order: the strict request, the administrator check, the category (a
 * missing one is `NOT_FOUND`), `expectedVersion`, and for deletion the
 * `CATEGORY_IN_USE` protection, here read from the category's `claimCount`.
 * Expected input, access, and domain errors become explicit `REJECTED`
 * records; dependency, codec, and programming failures propagate unchanged
 * and store nothing.
 *
 * Events are the category events of section 15: `category.created`; for an
 * update the policy change and the activation or deactivation (a name-only
 * update publishes nothing and keeps `lastEventVersion`); and
 * `category.deleted`. Each is chained from the stored `lastEventVersion`.
 * Event IDs are generated once per call and survive every rebuild.
 *
 * A cancelled commit is recovered within `maxCommitAttempts` prepared commits,
 * as in the claim services. Each attempt rechecks the idempotency record
 * first, then strongly rereads the category: a missing category is
 * `NOT_FOUND`, another version is `VERSION_CONFLICT`, and a deletion of a
 * category a claim now uses is `CATEGORY_IN_USE`, all stored as rejections; an
 * unchanged category is rebuilt after a bounded, jittered backoff. A creation
 * whose category already exists, and any cancellation still unresolved at the
 * cap, is rethrown unchanged.
 */

export interface AwsCategoryServiceDependencies {
  readonly mutations: Pick<ClaimMutationCoordinator, 'run'>;
  readonly categories: Pick<DynamoDbCategoryReader, 'getStored'>;
  readonly writer: Pick<
    DynamoDbCategoryWriter,
    'prepareCreate' | 'prepareUpdate' | 'prepareDelete'
  >;
  readonly ids: IdGenerator;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
  readonly logger: Logger;
}

interface Call {
  readonly actor: Actor;
  readonly categoryId: string | undefined;
  readonly input: unknown;
  readonly context: ClaimLifecycleContext;
  readonly request: ClaimMutationRequest;
  readonly expiresAt: number;
  readonly operation: string;
}

interface State {
  categoryId?: string;
  expectedVersion?: number;
  /** Event IDs of this call, generated once and reused by every rebuild. */
  eventId?: string;
  policyEventId?: string;
  activationEventId?: string;
  cancellation?: unknown;
  commits: number;
  committing: boolean;
}

type Prepared = PreparedClaimMutation | PreparedClaimRejection;

/** What differs between the three operations. */
interface Flow {
  readonly operation: string;
  /** The first attempt: parse, decide, and prepare. */
  first(call: Call, state: State): Promise<Prepared>;
  /** A rebuild after a cancellation; throws the cancellation if unresolved. */
  recover(call: Call, state: State): Promise<Prepared>;
}

const categoryNotFound = () => new NotFoundError('Category not found.');

function begin(
  actor: Actor,
  categoryId: string | undefined,
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
      categoryId,
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

function completedOf(
  call: Call,
  response: CompletedRequest['response'],
): CompletedRequest {
  return {
    actorId: call.actor.userId,
    key: call.context.idempotencyKey,
    fingerprint: call.context.fingerprint,
    response,
    createdAt: call.context.now,
    expiresAt: call.expiresAt,
  };
}

function eventContext(call: Call, stored: number | undefined) {
  return {
    correlationId: call.context.correlationId,
    causationId: call.context.requestId,
    actorId: call.actor.userId,
    occurredAt: call.context.now,
    storedLastEventVersion: stored,
  };
}

function rejected(call: Call, error: unknown): PreparedClaimRejection {
  return businessRejection(error, call.actor, call.context, call.expiresAt);
}

/** The first attempt, then the bounded recovery of a cancelled commit. */
async function runFlow(
  deps: AwsCategoryServiceDependencies,
  flow: Flow,
  call: Call,
  state: State,
): Promise<IdempotencyRecord> {
  const first = (): Promise<Prepared> => {
    state.committing = false;
    return flow.first(call, state);
  };
  const recover = (): Promise<Prepared> => {
    state.committing = false;
    return flow.recover(call, state);
  };
  // At the cap: the final checks, which may still find a winner's change.
  const settle = (retries: number) => {
    state.committing = false;
    return deps.mutations.run(call.request, async () => {
      const prepared = await flow.recover(call, state);
      if ('rejection' in prepared) {
        return prepared;
      }
      deps.logger.warn(`${flow.operation}.retries_exhausted`, {
        operation: call.operation,
        retries,
      });
      throw state.cancellation;
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
      state.cancellation = error;
      if (state.commits >= maxCommitAttempts) {
        return settle(retries);
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

function checkDependencies(deps: AwsCategoryServiceDependencies): void {
  if (typeof deps?.mutations?.run !== 'function') {
    throw new TypeError('The mutation coordinator is missing.');
  }
  if (typeof deps.categories?.getStored !== 'function') {
    throw new TypeError('The category reader is missing.');
  }
  if (
    typeof deps.writer?.prepareCreate !== 'function' ||
    typeof deps.writer.prepareUpdate !== 'function' ||
    typeof deps.writer.prepareDelete !== 'function'
  ) {
    throw new TypeError('The category writer is missing.');
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

function validId(value: string | undefined): string {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) {
    throw new NotFoundError();
  }
  return parsed.data;
}

export class AwsCategoryService {
  public constructor(private readonly deps: AwsCategoryServiceDependencies) {
    checkDependencies(deps);
  }

  /** The winning record: the `201` category, or a stored rejection. */
  public create(
    actor: Actor,
    input: unknown,
    context: ClaimLifecycleContext,
  ): Promise<IdempotencyRecord> {
    const { call, state } = begin(
      actor,
      undefined,
      input,
      context,
      'category.create',
    );
    const deps = this.deps;
    const build = (c: Call, s: State): Prepared => {
      let request: ReturnType<typeof createCategoryRequestSchema.parse>;
      try {
        request = createCategoryRequestSchema.parse(c.input);
      } catch (error) {
        return rejected(c, error);
      }
      // Dependencies run outside the catches that persist business rejections.
      s.categoryId ??= deps.ids.newId();
      let category: Category;
      try {
        category = createCategory(
          s.categoryId,
          { ...request, active: request.active ?? true },
          { actor: c.actor, now: c.context.now },
        );
      } catch (error) {
        return rejected(c, error);
      }
      s.eventId ??= deps.ids.newId();
      const event = buildCategoryCreatedEvent(category, {
        ...eventContext(c, undefined),
        eventId: s.eventId,
      });
      const completed = completedOf(c, {
        status: 201,
        body: toCategoryDto(category),
      });
      const transaction = deps.writer.prepareCreate(category, {
        events: [event],
        idempotency: completed,
      });
      s.commits += 1;
      s.committing = true;
      return { transaction, completed };
    };
    const flow: Flow = {
      operation: 'category.create',
      first: (c, s) => Promise.resolve(build(c, s)),
      recover: async (c, s) => {
        // The new ID is taken: another commit won, so this one cannot.
        if ((await deps.categories.getStored(s.categoryId!)) !== undefined) {
          throw s.cancellation;
        }
        return build(c, s);
      },
    };
    return runFlow(deps, flow, call, state);
  }

  /** The winning record: the `200` category, or a stored rejection. */
  public update(
    actor: Actor,
    categoryId: string,
    input: unknown,
    context: ClaimLifecycleContext,
  ): Promise<IdempotencyRecord> {
    const { call, state } = begin(
      actor,
      categoryId,
      input,
      context,
      'category.update',
    );
    const deps = this.deps;
    const build = async (c: Call, s: State): Promise<Prepared> => {
      let request: ReturnType<typeof updateCategoryRequestSchema.parse>;
      try {
        request = updateCategoryRequestSchema.parse(c.input);
      } catch (error) {
        return rejected(c, error);
      }
      const { expectedVersion, ...changes } = request;
      s.expectedVersion = expectedVersion;
      const stored = await deps.categories.getStored(s.categoryId!);
      let updated: Category;
      try {
        if (stored === undefined) {
          throw categoryNotFound();
        }
        assertVersion(stored.category, expectedVersion);
        updated = updateCategory(stored.category, definedOnly(changes), {
          actor: c.actor,
          now: c.context.now,
        });
      } catch (error) {
        return rejected(c, error);
      }
      s.policyEventId ??= deps.ids.newId();
      s.activationEventId ??= deps.ids.newId();
      const events = buildCategoryUpdateEvents(stored.category, updated, {
        ...eventContext(c, stored.metadata.lastEventVersion),
        policyEventId: s.policyEventId,
        activationEventId: s.activationEventId,
      });
      const completed = completedOf(c, {
        status: 200,
        body: toCategoryDto(updated),
      });
      const transaction = deps.writer.prepareUpdate(
        updated,
        stored.category.version,
        { events, idempotency: completed },
      );
      s.commits += 1;
      s.committing = true;
      return { transaction, completed };
    };
    const flow: Flow = {
      operation: 'category.update',
      first: async (c, s) => {
        try {
          s.categoryId = validId(c.categoryId);
        } catch (error) {
          return rejected(c, error);
        }
        return build(c, s);
      },
      recover: build,
    };
    return runFlow(deps, flow, call, state);
  }

  /** The winning record: the `204` result, or a stored rejection. */
  public delete(
    actor: Actor,
    categoryId: string,
    input: unknown,
    context: ClaimLifecycleContext,
  ): Promise<IdempotencyRecord> {
    const { call, state } = begin(
      actor,
      categoryId,
      input,
      context,
      'category.delete',
    );
    const deps = this.deps;
    const build = async (c: Call, s: State): Promise<Prepared> => {
      try {
        s.expectedVersion = deleteRequestSchema.parse(c.input).expectedVersion;
        s.categoryId = validId(c.categoryId);
        assertMayDeleteCategory(c.actor);
      } catch (error) {
        return rejected(c, error);
      }
      const stored = await deps.categories.getStored(s.categoryId);
      try {
        if (stored === undefined) {
          throw categoryNotFound();
        }
        assertVersion(stored.category, s.expectedVersion);
        if (stored.metadata.claimCount > 0) {
          throw new ApplicationError(
            'CATEGORY_IN_USE',
            'This category is used by existing claims. Deactivate it instead.',
          );
        }
      } catch (error) {
        return rejected(c, error);
      }
      s.eventId ??= deps.ids.newId();
      const event = buildCategoryDeletedEvent(stored.category, {
        ...eventContext(c, stored.metadata.lastEventVersion),
        eventId: s.eventId,
      });
      const completed = completedOf(c, { status: 204, body: undefined });
      const transaction = deps.writer.prepareDelete(
        stored.category.categoryId,
        stored.category.version,
        { events: [event], idempotency: completed },
      );
      s.commits += 1;
      s.committing = true;
      return { transaction, completed };
    };
    const flow: Flow = {
      operation: 'category.delete',
      first: build,
      recover: build,
    };
    return runFlow(deps, flow, call, state);
  }
}
