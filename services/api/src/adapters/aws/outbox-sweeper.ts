import type { Clock } from '../../application/ports.js';
import type { StoredOutboxEvent } from './dynamodb-outbox-items.js';
import { maxPendingBatch } from './dynamodb-pending-outbox.js';
import {
  oldestPendingAgeSeconds,
  type OldestPendingOutboxAgeRecorder,
} from './oldest-pending-outbox-metric.js';
import type {
  PublicationRecord,
  PublicationResult,
} from './outbox-publication.js';

/**
 * The scheduled outbox sweeper (docs/aws-architecture.md, section 15): it
 * republishes events still pending after the stream path failed or expired.
 * Events younger than a five-minute grace period are left to the stream path.
 * One invocation handles one batch of at most 10 events, with no loop and no
 * retry of its own; a scheduled retry is requested by throwing. Before it
 * publishes, it reports the age of the oldest selected event (0 for none) as
 * a metric; a failure to report never stops the publication.
 */

/** Events newer than this are left to the stream path. */
export const sweepGracePeriodMs = 5 * 60 * 1000;

/** The pending-outbox query the sweeper uses. */
export interface PendingOutboxReader {
  listPending(
    cutoff: string,
    limit: number,
  ): Promise<readonly StoredOutboxEvent[]>;
}

/** The publication workflow the sweeper uses. */
export interface SweepPublication {
  publish(records: readonly PublicationRecord[]): Promise<PublicationResult>;
}

export interface OutboxSweeperOptions {
  readonly pending: PendingOutboxReader;
  readonly publication: SweepPublication;
  readonly clock: Clock;
  readonly metrics: OldestPendingOutboxAgeRecorder;
}

export interface SweepResult {
  /** How many pending events the sweep selected and published. */
  readonly selected: number;
}

/** A sweep left events unpublished; the message names no event. */
export class OutboxSweepError extends Error {
  public constructor() {
    super('The outbox sweep did not publish every selected event.');
    this.name = 'OutboxSweepError';
  }
}

export type OutboxSweeper = () => Promise<SweepResult>;

export function createOutboxSweeper({
  pending,
  publication,
  clock,
  metrics,
}: OutboxSweeperOptions): OutboxSweeper {
  return async () => {
    // One reading, so the cutoff is exactly the grace period before it and
    // the reported age is measured from the same instant.
    const now = clock.now();
    const cutoff = new Date(now.getTime() - sweepGracePeriodMs).toISOString();

    const stored = await pending.listPending(cutoff, maxPendingBatch);
    try {
      metrics.record(oldestPendingAgeSeconds(stored, now), now);
    } catch {
      // Observability must not stop events from being published.
    }
    if (stored.length === 0) {
      return { selected: 0 };
    }

    // The event ID is unique and identifies the record to the workflow.
    const result = await publication.publish(
      stored.map(({ event }) => ({
        sequenceNumber: event.eventId,
        event,
      })),
    );
    if (result.firstFailedSequenceNumber !== undefined) {
      throw new OutboxSweepError();
    }
    return { selected: stored.length };
  };
}
