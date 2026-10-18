import type {
  SQSBatchItemFailure,
  SQSBatchResponse,
  SQSEvent,
  SQSRecord,
} from 'aws-lambda';

import { eventSource } from '../../application/events.js';
import type { DynamoDbHistoryPurger } from './dynamodb-history-purger.js';
import { parseOutboxEnvelope } from './dynamodb-outbox-items.js';
import type { S3ReceiptObjects } from './s3-receipt-objects.js';

/**
 * The cleanup worker's SQS handler (docs/aws-architecture.md, sections 12
 * and 15): it reads the internal cleanup events that EventBridge routes to
 * the cleanup queue and performs them. Both operations are idempotent, so a
 * duplicate delivery is harmless and no deduplication record is kept. It
 * builds no clients and is not a Lambda entry point itself.
 */

/** The operations the worker performs. */
export interface CleanupWorkerDependencies {
  /** `S3ReceiptObjects` provides the final-object deletion. */
  readonly objects: Pick<S3ReceiptObjects, 'deleteFinal'>;
  /** `DynamoDbHistoryPurger` provides the history purge. */
  readonly history: Pick<DynamoDbHistoryPurger, 'purge'>;
}

export type CleanupWorkerHandler = (
  event: SQSEvent,
) => Promise<SQSBatchResponse>;

/** The standard fields of an EventBridge event delivered to an SQS target. */
const wrapperFields = [
  'version',
  'id',
  'detail-type',
  'source',
  'account',
  'time',
  'region',
  'resources',
  'detail',
] as const;

/**
 * A handler that processes every record on its own. A record that is not a
 * valid internal cleanup event, or whose operation fails, is reported by its
 * message ID, in batch order; successful records are omitted. A record
 * without a message ID makes the batch impossible to report, so the handler
 * throws before doing any cleanup.
 */
export function createCleanupWorkerHandler(
  dependencies: CleanupWorkerDependencies,
): CleanupWorkerHandler {
  return async (event) => {
    const records = event.Records ?? [];
    for (const record of records) {
      if (
        typeof record?.messageId !== 'string' ||
        record.messageId.length === 0
      ) {
        throw new TypeError('An SQS record has no message ID.');
      }
    }

    const outcomes = await Promise.all(
      records.map(async (record) => ({
        messageId: record.messageId,
        ok: await handleRecord(record, dependencies),
      })),
    );
    const batchItemFailures: SQSBatchItemFailure[] = outcomes
      .filter((outcome) => !outcome.ok)
      .map((outcome) => ({ itemIdentifier: outcome.messageId }));
    return { batchItemFailures };
  };
}

/** Whether the record's cleanup was performed; never throws. */
async function handleRecord(
  record: SQSRecord,
  { objects, history }: CleanupWorkerDependencies,
): Promise<boolean> {
  try {
    const cleanup = parseCleanupEvent(record.body);
    if (cleanup.eventType === 'internal.receipt-object-deletion-requested') {
      await objects.deleteFinal(cleanup.receiptId);
    } else {
      await history.purge(cleanup.claimId);
    }
    return true;
  } catch {
    return false;
  }
}

type CleanupEvent =
  | {
      readonly eventType: 'internal.receipt-object-deletion-requested';
      readonly receiptId: string;
    }
  | {
      readonly eventType: 'internal.claim-history-purge-requested';
      readonly claimId: string;
    };

/** The cleanup an SQS body asks for, or an error without any value in it. */
function parseCleanupEvent(body: unknown): CleanupEvent {
  const wrapper: unknown = JSON.parse(typeof body === 'string' ? body : '');
  if (
    typeof wrapper !== 'object' ||
    wrapper === null ||
    Array.isArray(wrapper)
  ) {
    throw new TypeError('The message is not an EventBridge event.');
  }
  const fields = wrapper as Record<string, unknown>;
  const names = Object.keys(fields);
  const allowed = new Set<string>([...wrapperFields, 'replay-name']);
  if (
    !wrapperFields.every((name) => names.includes(name)) ||
    !names.every((name) => allowed.has(name)) ||
    fields.version !== '0' ||
    !isNonEmptyString(fields.id) ||
    fields.source !== eventSource ||
    typeof fields['detail-type'] !== 'string' ||
    typeof fields.account !== 'string' ||
    !/^\d{12}$/.test(fields.account) ||
    !isRfc3339(fields.time) ||
    !isNonEmptyString(fields.region) ||
    !Array.isArray(fields.resources) ||
    !fields.resources.every((resource) => typeof resource === 'string') ||
    ('replay-name' in fields && !isNonEmptyString(fields['replay-name']))
  ) {
    throw new TypeError('The EventBridge wrapper is not valid.');
  }

  const event = parseOutboxEnvelope(fields.detail);
  if (event.eventType !== fields['detail-type']) {
    throw new TypeError('The detail type does not match the event.');
  }
  switch (event.eventType) {
    case 'internal.receipt-object-deletion-requested':
      return { eventType: event.eventType, receiptId: event.payload.receiptId };
    case 'internal.claim-history-purge-requested':
      return { eventType: event.eventType, claimId: event.payload.claimId };
    default:
      // Publishable events are never the cleanup worker's.
      throw new TypeError('The event is not a cleanup event.');
  }
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

const rfc3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/;

/**
 * An RFC 3339 date-time with a real calendar date and clock time and a `Z`
 * or numeric offset. Fractional seconds are optional: EventBridge emits
 * whole seconds, such as `2026-10-14T11:05:00Z`.
 */
function isRfc3339(value: unknown): boolean {
  const match = typeof value === 'string' ? rfc3339.exec(value) : null;
  if (match === null) {
    return false;
  }
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map(Number) as [number, number, number, number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    (match[8] === undefined ||
      (Number(match[8]) <= 23 && Number(match[9]) <= 59))
  );
}
