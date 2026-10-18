import { idSchema } from '@claimflow/contracts';
import {
  claimActions,
  claimTransitions,
  type ClaimAction,
  type ClaimChange,
  type ClaimHistoryAction,
} from '@claimflow/domain';

import {
  eventSource,
  type ClaimEventPayload,
  type EventPayloads,
  type OutboxEvent,
  type OutboxEventEnvelope,
} from './events.js';
import { isTraceId } from './tracing.js';

/**
 * Builds the outbox event of a claim lifecycle change
 * (docs/aws-architecture.md, section 15). Pure: IDs and times are inputs, and
 * the payload carries identifiers, the amount, and timestamps only, never
 * free text.
 */

/** The event each lifecycle action publishes. */
export const claimActionEventTypes = {
  SUBMIT: 'claim.submitted',
  START_REVIEW: 'claim.review-started',
  APPROVE: 'claim.approved',
  REJECT: 'claim.rejected',
  REOPEN: 'claim.reopened',
  MARK_PAID: 'claim.paid',
} as const satisfies Record<ClaimAction, keyof EventPayloads>;

/**
 * Lifecycle actions publish events; draft and receipt changes are recorded
 * in history only. This follows the domain's authoritative action list.
 */
export function isPublishableAction(action: ClaimHistoryAction): boolean {
  return (claimActions as readonly string[]).includes(action);
}

/** A lifecycle event that cannot be built; messages carry no values. */
export class ClaimEventError extends Error {
  public constructor(problem: string) {
    super(`Cannot build the claim event: ${problem}.`);
    this.name = 'ClaimEventError';
  }
}

/** The identifiers the caller generates for one event. */
export interface ClaimEventIds {
  readonly eventId: string;
  readonly correlationId: string;
  readonly causationId: string;
}

/**
 * The single event for a lifecycle change, or `undefined` for a draft or
 * receipt change, which publishes none. `storedLastEventVersion` is the
 * claim's `lastEventVersion` before this change: absent or zero for the
 * first event, otherwise below the new version.
 */
export function buildClaimLifecycleEvent(
  { claim, history }: ClaimChange,
  ids: ClaimEventIds,
  storedLastEventVersion: number | undefined,
): OutboxEvent | undefined {
  const action = history.action;
  if (!isPublishableAction(action)) {
    return undefined;
  }
  const lifecycle = action as ClaimAction;

  if (history.claimId !== claim.claimId) {
    throw new ClaimEventError('the history entry is for another claim');
  }
  if (history.version !== claim.version) {
    throw new ClaimEventError(
      'the history version must equal the claim version',
    );
  }
  const transition = claimTransitions[lifecycle];
  if (
    history.fromStatus !== transition.from ||
    history.toStatus !== transition.to ||
    claim.status !== transition.to
  ) {
    throw new ClaimEventError('the statuses do not match the action');
  }
  const generated: [string, boolean][] = [
    ['eventId', idSchema.safeParse(ids.eventId).success],
    ['correlationId', isTraceId(ids.correlationId)],
    ['causationId', isTraceId(ids.causationId)],
  ];
  for (const [name, valid] of generated) {
    if (!valid) {
      throw new ClaimEventError(`${name} is not valid`);
    }
  }
  if (!idSchema.safeParse(history.actorId).success) {
    throw new ClaimEventError('the actor ID is not valid');
  }
  const previousEventVersion = previousVersion(
    storedLastEventVersion,
    claim.version,
  );

  const { assignedManagerId, categoryId, amount } = claim;
  if (
    assignedManagerId === undefined ||
    categoryId === undefined ||
    amount === undefined
  ) {
    throw new ClaimEventError(
      'the claim needs an assigned manager, category, and amount',
    );
  }
  const common: ClaimEventPayload = {
    claimId: claim.claimId,
    employeeId: claim.employeeId,
    assignedManagerId,
    categoryId,
    amount: { amountMinor: amount.amountMinor, currency: amount.currency },
  };

  const envelope = <T extends (typeof claimActionEventTypes)[ClaimAction]>(
    eventType: T,
    payload: EventPayloads[T],
  ): OutboxEventEnvelope<T> =>
    ({
      eventId: ids.eventId,
      eventType,
      schemaVersion: 1,
      occurredAt: history.occurredAt,
      source: eventSource,
      aggregate: {
        type: 'claim',
        id: claim.claimId,
        version: claim.version,
        previousEventVersion,
      },
      correlationId: ids.correlationId,
      causationId: ids.causationId,
      actorId: history.actorId,
      payload,
    }) as OutboxEventEnvelope<T>;
  const required = (value: string | undefined, name: string): string => {
    if (value === undefined) {
      throw new ClaimEventError(`the claim needs ${name}`);
    }
    return value;
  };

  switch (lifecycle) {
    case 'SUBMIT':
      return envelope('claim.submitted', {
        ...common,
        submittedAt: required(claim.submittedAt, 'a submission time'),
      });
    case 'START_REVIEW':
      return envelope('claim.review-started', common);
    case 'APPROVE':
      return envelope('claim.approved', {
        ...common,
        reviewedAt: required(claim.reviewedAt, 'a review time'),
      });
    case 'REJECT':
      return envelope('claim.rejected', {
        ...common,
        reviewedAt: required(claim.reviewedAt, 'a review time'),
      });
    case 'REOPEN':
      return envelope('claim.reopened', common);
    case 'MARK_PAID':
      return envelope('claim.paid', {
        ...common,
        paidBy: history.actorId,
        paidAt: history.occurredAt,
      });
  }
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
    throw new ClaimEventError(
      'the previous event version must be a whole number below the new version',
    );
  }
  return stored;
}
