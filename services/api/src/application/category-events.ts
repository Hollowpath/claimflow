import { idSchema } from '@claimflow/contracts';
import type { Category } from '@claimflow/domain';

import {
  eventSource,
  type CategoryPolicyFields,
  type EventPayloads,
  type OutboxEvent,
  type OutboxEventEnvelope,
} from './events.js';
import { isTraceId } from './tracing.js';

/**
 * Builds the outbox events of category changes (docs/aws-architecture.md,
 * section 15). Pure: IDs and times are inputs. Payloads carry identifiers,
 * versions, and policy fields only; the category name is free text and never
 * appears.
 */

/** A category event that cannot be built; messages carry no values. */
export class CategoryEventError extends Error {
  public constructor(problem: string) {
    super(`Cannot build the category event: ${problem}.`);
    this.name = 'CategoryEventError';
  }
}

/** What every category event needs from the caller. */
export interface CategoryEventContext {
  readonly correlationId: string;
  readonly causationId: string;
  /** The administrator who made the change. */
  readonly actorId: string;
  /** ISO 8601, assigned just before the transaction. */
  readonly occurredAt: string;
  /**
   * The category's `lastEventVersion` before this change: absent or zero if
   * it never published, otherwise below the new version.
   */
  readonly storedLastEventVersion: number | undefined;
}

export interface CategoryCreatedRequest extends CategoryEventContext {
  readonly eventId: string;
}

export interface CategoryUpdateRequest extends CategoryEventContext {
  /** For the policy change, when there is one. */
  readonly policyEventId: string;
  /** For the activation or deactivation, when there is one. */
  readonly activationEventId: string;
}

export interface CategoryDeletedRequest extends CategoryEventContext {
  readonly eventId: string;
}

const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const policyFields = [
  'currency',
  'maxAmountMinor',
  'receiptRequiredAboveMinor',
] as const satisfies readonly (keyof CategoryPolicyFields)[];

/** `category.created` for a new category at version 1. */
export function buildCategoryCreatedEvent(
  category: Category,
  request: CategoryCreatedRequest,
): OutboxEventEnvelope<'category.created'> {
  checkContext(request);
  checkId(request.eventId, 'the event ID');
  checkId(category.categoryId, 'the category ID');
  if (category.version !== 1) {
    throw new CategoryEventError('a new category must be at version 1');
  }
  if (typeof category.active !== 'boolean') {
    throw new CategoryEventError('the active state is not valid');
  }
  return envelope(
    'category.created',
    request.eventId,
    request,
    category.categoryId,
    category.version,
    {
      categoryId: category.categoryId,
      version: category.version,
      active: category.active,
      ...policy(category),
    },
  );
}

/**
 * The events of an administrator change, in a fixed order: the policy change
 * first, then the activation or deactivation. Both describe the same new
 * version. A change to the name alone publishes nothing.
 */
export function buildCategoryUpdateEvents(
  before: Category,
  after: Category,
  request: CategoryUpdateRequest,
): OutboxEvent[] {
  checkContext(request);
  checkId(request.policyEventId, 'the policy event ID');
  checkId(request.activationEventId, 'the activation event ID');
  if (request.policyEventId === request.activationEventId) {
    throw new CategoryEventError('the event IDs must be distinct');
  }
  checkId(before.categoryId, 'the category ID');
  if (after.categoryId !== before.categoryId) {
    throw new CategoryEventError('the categories are different');
  }
  if (
    !Number.isSafeInteger(before.version) ||
    before.version < 1 ||
    !Number.isSafeInteger(after.version) ||
    after.version !== before.version + 1
  ) {
    throw new CategoryEventError('the version must increase by exactly one');
  }
  if (after.createdAt !== before.createdAt) {
    throw new CategoryEventError('the creation time cannot change');
  }

  const events: OutboxEvent[] = [];
  const changed: Partial<CategoryPolicyFields> = {};
  for (const field of policyFields) {
    if (before[field] !== after[field]) {
      Object.assign(changed, { [field]: after[field] });
    }
  }
  if (Object.keys(changed).length > 0) {
    events.push(
      envelope(
        'category.policy-changed',
        request.policyEventId,
        request,
        after.categoryId,
        after.version,
        { categoryId: after.categoryId, version: after.version, ...changed },
      ),
    );
  }
  if (before.active !== after.active) {
    const payload = { categoryId: after.categoryId, version: after.version };
    events.push(
      after.active
        ? envelope(
            'category.activated',
            request.activationEventId,
            request,
            after.categoryId,
            after.version,
            payload,
          )
        : envelope(
            'category.deactivated',
            request.activationEventId,
            request,
            after.categoryId,
            after.version,
            payload,
          ),
    );
  }
  return events;
}

/** `category.deleted`, one version after the stored category. */
export function buildCategoryDeletedEvent(
  stored: Category,
  request: CategoryDeletedRequest,
): OutboxEventEnvelope<'category.deleted'> {
  checkContext(request);
  checkId(request.eventId, 'the event ID');
  checkId(stored.categoryId, 'the category ID');
  const version = stored.version + 1;
  if (
    !Number.isSafeInteger(stored.version) ||
    stored.version < 1 ||
    !Number.isSafeInteger(version)
  ) {
    throw new CategoryEventError('the version is not valid');
  }
  return envelope(
    'category.deleted',
    request.eventId,
    request,
    stored.categoryId,
    version,
    { categoryId: stored.categoryId, version },
  );
}

function policy(category: Category): CategoryPolicyFields {
  return {
    currency: category.currency,
    maxAmountMinor: category.maxAmountMinor,
    receiptRequiredAboveMinor: category.receiptRequiredAboveMinor,
  };
}

function envelope<
  T extends
    | 'category.created'
    | 'category.policy-changed'
    | 'category.activated'
    | 'category.deactivated'
    | 'category.deleted',
>(
  eventType: T,
  eventId: string,
  context: CategoryEventContext,
  categoryId: string,
  version: number,
  payload: EventPayloads[T],
): OutboxEventEnvelope<T> {
  return {
    eventId,
    eventType,
    schemaVersion: 1,
    occurredAt: context.occurredAt,
    source: eventSource,
    aggregate: {
      type: 'category',
      id: categoryId,
      version,
      previousEventVersion: previousVersion(
        context.storedLastEventVersion,
        version,
      ),
    },
    correlationId: context.correlationId,
    causationId: context.causationId,
    actorId: context.actorId,
    payload,
  } as OutboxEventEnvelope<T>;
}

/** `null` for the first event; otherwise a version below the new one. */
function previousVersion(
  stored: number | undefined,
  version: number,
): number | null {
  if (stored === undefined || stored === 0) {
    return null;
  }
  if (!Number.isSafeInteger(stored) || stored < 0 || stored >= version) {
    throw new CategoryEventError(
      'the previous event version must be a whole number below the new version',
    );
  }
  return stored;
}

function checkContext(context: CategoryEventContext): void {
  checkId(context.actorId, 'the actor ID');
  if (
    typeof context.correlationId !== 'string' ||
    !isTraceId(context.correlationId)
  ) {
    throw new CategoryEventError('the correlation ID is not valid');
  }
  if (
    typeof context.causationId !== 'string' ||
    !isTraceId(context.causationId)
  ) {
    throw new CategoryEventError('the causation ID is not valid');
  }
  if (!isCanonicalTimestamp(context.occurredAt)) {
    throw new CategoryEventError('the occurrence time is not valid');
  }
}

function checkId(value: string, name: string): void {
  if (!idSchema.safeParse(value).success) {
    throw new CategoryEventError(`${name} is not valid`);
  }
}

function isCanonicalTimestamp(value: unknown): boolean {
  if (typeof value !== 'string' || !isoTimestamp.test(value)) {
    return false;
  }
  const time = Date.parse(value);
  return !Number.isNaN(time) && new Date(time).toISOString() === value;
}
