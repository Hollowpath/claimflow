import type { PutEventsCommandOutput } from '@aws-sdk/client-eventbridge';

import type { OutboxEvent } from '../../application/events.js';
import type { Clock } from '../../application/ports.js';
import type { StoredOutboxEvent } from './dynamodb-outbox-items.js';
import { maxPublishBatch } from './eventbridge-publisher.js';

/**
 * Publishes a batch of outbox records (docs/aws-architecture.md, section
 * 15). It rereads each event, skips those already handled, publishes the
 * pending ones in one ordered `PutEvents` call, and marks the successful
 * entries published. It reports only the first record that must be retried,
 * which a stream handler turns into its own failure response; operational
 * failures are never thrown, so it knows nothing of Lambda event types.
 */

/** One delivery: its sequence number and the event it announces. */
export interface PublicationRecord {
  /** Non-empty and unique within the batch. */
  readonly sequenceNumber: string;
  readonly event: OutboxEvent;
}

/** The outbox operations the workflow uses. */
export interface OutboxStateStore {
  get(event: OutboxEvent): Promise<StoredOutboxEvent | undefined>;
  markPublished(event: OutboxEvent, publishedAt: string): Promise<void>;
}

/** The publishing operation the workflow uses. */
export interface OutboxEventPublisher {
  publish(events: readonly OutboxEvent[]): Promise<PutEventsCommandOutput>;
}

export interface OutboxPublicationOptions {
  readonly state: OutboxStateStore;
  readonly publisher: OutboxEventPublisher;
  readonly clock: Clock;
}

export interface PublicationResult {
  /** The first record, in batch order, that must be retried; none if all done. */
  readonly firstFailedSequenceNumber: string | undefined;
}

export class OutboxPublication {
  private readonly state: OutboxStateStore;
  private readonly publisher: OutboxEventPublisher;
  private readonly clock: Clock;

  public constructor({ state, publisher, clock }: OutboxPublicationOptions) {
    this.state = state;
    this.publisher = publisher;
    this.clock = clock;
  }

  /**
   * Handles 1 to 10 records. Records whose item is missing or already
   * published are skipped. A read, publish, or mark failure, or any
   * unreliable EventBridge answer, counts as a failure of the record
   * concerned and never stops the others. A mark that fails its condition is
   * ignored, because another path already published the event.
   */
  public async publish(
    records: readonly PublicationRecord[],
  ): Promise<PublicationResult> {
    checkBatch(records);
    const failed = new Set<number>();

    const pending = await this.readPending(records, failed);
    if (pending.length > 0) {
      await this.publishAndMark(pending, failed);
    }

    for (let index = 0; index < records.length; index += 1) {
      if (failed.has(index)) {
        return { firstFailedSequenceNumber: records[index]!.sequenceNumber };
      }
    }
    return { firstFailedSequenceNumber: undefined };
  }

  /** The stored events still pending, in batch order; read failures recorded. */
  private async readPending(
    records: readonly PublicationRecord[],
    failed: Set<number>,
  ): Promise<{ index: number; event: OutboxEvent }[]> {
    const reads = await Promise.all(
      records.map((record) =>
        this.state.get(record.event).then(
          (stored) => ({ stored }) as const,
          () => ({ failure: true }) as const,
        ),
      ),
    );
    const pending: { index: number; event: OutboxEvent }[] = [];
    reads.forEach((read, index) => {
      if ('failure' in read) {
        failed.add(index);
      } else if (read.stored?.state.state === 'PENDING') {
        pending.push({ index, event: read.stored.event });
      }
    });
    return pending;
  }

  private async publishAndMark(
    pending: readonly { index: number; event: OutboxEvent }[],
    failed: Set<number>,
  ): Promise<void> {
    let output: PutEventsCommandOutput;
    try {
      output = await this.publisher.publish(pending.map((p) => p.event));
    } catch {
      pending.forEach((p) => failed.add(p.index));
      return;
    }

    const succeeded = succeededEntries(output, pending.length);
    // One time for every mark. If it cannot be read or is not a valid date,
    // nothing is marked, and the published entries are retried.
    let publishedAt: string;
    try {
      publishedAt = this.clock.now().toISOString();
    } catch {
      pending.forEach((p) => failed.add(p.index));
      return;
    }
    for (const [position, { index, event }] of pending.entries()) {
      if (!succeeded[position]) {
        failed.add(index);
        continue;
      }
      try {
        await this.state.markPublished(event, publishedAt);
      } catch (error) {
        if (!isConditionalCheckFailure(error)) {
          failed.add(index);
        }
      }
    }
  }
}

/**
 * Which of `count` entries EventBridge accepted, matched by index. Anything
 * unreliable fails every entry: a missing or differently sized result, a
 * failure count that disagrees with the entries. An entry is accepted only
 * with a non-empty event ID and neither an error code nor an error message.
 */
function succeededEntries(
  output: PutEventsCommandOutput,
  count: number,
): boolean[] {
  const none = new Array<boolean>(count).fill(false);
  const entries: unknown = output?.Entries;
  const failedCount: unknown = output?.FailedEntryCount;
  if (
    !Array.isArray(entries) ||
    entries.length !== count ||
    typeof failedCount !== 'number'
  ) {
    return none;
  }
  const accepted = (
    entries as {
      EventId?: unknown;
      ErrorCode?: unknown;
      ErrorMessage?: unknown;
    }[]
  ).map(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      entry.ErrorCode === undefined &&
      entry.ErrorMessage === undefined &&
      typeof entry.EventId === 'string' &&
      entry.EventId.length > 0,
  );
  const rejected = accepted.filter((ok) => !ok).length;
  return rejected === failedCount ? accepted : none;
}

function isConditionalCheckFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'ConditionalCheckFailedException'
  );
}

function checkBatch(records: readonly PublicationRecord[]): void {
  if (
    !Array.isArray(records) ||
    records.length < 1 ||
    records.length > maxPublishBatch
  ) {
    throw new RangeError(`A batch must hold 1 to ${maxPublishBatch} records.`);
  }
  const seen = new Set<string>();
  for (const record of records as readonly PublicationRecord[]) {
    const sequenceNumber: unknown = record?.sequenceNumber;
    if (typeof sequenceNumber !== 'string' || sequenceNumber.length === 0) {
      throw new TypeError('Every record needs a non-empty sequence number.');
    }
    if (seen.has(sequenceNumber)) {
      throw new TypeError('Sequence numbers must be unique.');
    }
    seen.add(sequenceNumber);
  }
}
