import { idSchema } from '@claimflow/contracts';

import { eventSource, type OutboxEventEnvelope } from './events.js';
import { isTraceId } from './tracing.js';

/**
 * Builds the internal cleanup events that a claim mutation writes with its
 * transaction (docs/aws-architecture.md, section 15). Pure: IDs and times are
 * inputs. Cleanup events belong to the claim, are not part of the published
 * sequence (`previousEventVersion` is always `null`), and carry identifiers
 * only.
 */

/** A cleanup event that cannot be built; messages carry no values. */
export class CleanupEventError extends Error {
  public constructor(problem: string) {
    super(`Cannot build the cleanup event: ${problem}.`);
    this.name = 'CleanupEventError';
  }
}

/** What every cleanup event needs from the caller. */
export interface CleanupEventContext {
  readonly eventId: string;
  readonly correlationId: string;
  readonly causationId: string;
  /** The user whose change requested the cleanup. */
  readonly actorId: string;
  /** ISO 8601, assigned just before the transaction. */
  readonly occurredAt: string;
  /** The claim aggregate version supplied by the calling mutation. */
  readonly claimVersion: number;
}

export interface ReceiptDeletionRequest extends CleanupEventContext {
  readonly claimId: string;
  readonly receiptId: string;
  /** Must be `receipts/<receiptId>`. */
  readonly objectKey: string;
}

export interface HistoryPurgeRequest extends CleanupEventContext {
  readonly claimId: string;
}

const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Asks the cleanup worker to delete a replaced or removed receipt object. */
export function buildReceiptDeletionEvent(
  request: ReceiptDeletionRequest,
): OutboxEventEnvelope<'internal.receipt-object-deletion-requested'> {
  checkContext(request);
  checkId(request.claimId, 'the claim ID');
  checkId(request.receiptId, 'the receipt ID');
  if (request.objectKey !== `receipts/${request.receiptId}`) {
    throw new CleanupEventError('the object key must be the receipt object');
  }
  return envelope('internal.receipt-object-deletion-requested', request, {
    claimId: request.claimId,
    receiptId: request.receiptId,
    objectKey: request.objectKey,
  });
}

/** Asks the cleanup worker to purge the history of a deleted draft. */
export function buildHistoryPurgeEvent(
  request: HistoryPurgeRequest,
): OutboxEventEnvelope<'internal.claim-history-purge-requested'> {
  checkContext(request);
  checkId(request.claimId, 'the claim ID');
  return envelope('internal.claim-history-purge-requested', request, {
    claimId: request.claimId,
  });
}

function envelope<
  T extends
    | 'internal.receipt-object-deletion-requested'
    | 'internal.claim-history-purge-requested',
>(
  eventType: T,
  context: CleanupEventContext & { readonly claimId: string },
  payload: OutboxEventEnvelope<T>['payload'],
): OutboxEventEnvelope<T> {
  return {
    eventId: context.eventId,
    eventType,
    schemaVersion: 1,
    occurredAt: context.occurredAt,
    source: eventSource,
    aggregate: {
      type: 'claim',
      id: context.claimId,
      version: context.claimVersion,
      previousEventVersion: null,
    },
    correlationId: context.correlationId,
    causationId: context.causationId,
    actorId: context.actorId,
    payload,
  };
}

function checkContext(context: CleanupEventContext): void {
  checkId(context.eventId, 'the event ID');
  checkId(context.actorId, 'the actor ID');
  if (
    typeof context.correlationId !== 'string' ||
    !isTraceId(context.correlationId)
  ) {
    throw new CleanupEventError('the correlation ID is not valid');
  }
  if (
    typeof context.causationId !== 'string' ||
    !isTraceId(context.causationId)
  ) {
    throw new CleanupEventError('the causation ID is not valid');
  }
  if (!isCanonicalTimestamp(context.occurredAt)) {
    throw new CleanupEventError('the occurrence time is not valid');
  }
  if (!Number.isSafeInteger(context.claimVersion) || context.claimVersion < 1) {
    throw new CleanupEventError(
      'the claim version must be a positive whole number',
    );
  }
}

function checkId(value: string, name: string): void {
  if (!idSchema.safeParse(value).success) {
    throw new CleanupEventError(`${name} is not valid`);
  }
}

function isCanonicalTimestamp(value: unknown): boolean {
  if (typeof value !== 'string' || !isoTimestamp.test(value)) {
    return false;
  }
  const time = Date.parse(value);
  return !Number.isNaN(time) && new Date(time).toISOString() === value;
}
