import type { StoredOutboxEvent } from './dynamodb-outbox-items.js';

/**
 * The oldest-pending-outbox-age metric (docs/aws-architecture.md, section
 * 22), written as one CloudWatch Embedded Metric Format line on standard
 * output. Lambda ships the line to CloudWatch Logs, which extracts the metric
 * without a `PutMetricData` call or an IAM permission.
 */

export const oldestPendingOutboxAgeNamespace = 'ClaimFlow';
export const oldestPendingOutboxAgeMetricName = 'OldestPendingOutboxAge';

/** Where the sweeper reports the age; injected so tests need no stdout. */
export interface OldestPendingOutboxAgeRecorder {
  record(ageSeconds: number, at: Date): void;
}

/**
 * The age in whole seconds of the oldest event, or 0 for none. Ordering is
 * not assumed, and an unreadable timestamp is an error rather than a zero.
 */
export function oldestPendingAgeSeconds(
  events: readonly StoredOutboxEvent[],
  now: Date,
): number {
  let oldestMs = Number.POSITIVE_INFINITY;
  for (const { event } of events) {
    const occurred = Date.parse(event.occurredAt);
    if (Number.isNaN(occurred)) {
      throw new RangeError('An outbox event has an unreadable timestamp.');
    }
    oldestMs = Math.min(oldestMs, occurred);
  }
  return events.length === 0
    ? 0
    : Math.max(0, Math.floor((now.getTime() - oldestMs) / 1000));
}

/** One EMF line: a dimensionless, standard-resolution metric in seconds. */
export function oldestPendingOutboxAgeEmf(
  ageSeconds: number,
  at: Date,
): string {
  return JSON.stringify({
    _aws: {
      Timestamp: at.getTime(),
      CloudWatchMetrics: [
        {
          Namespace: oldestPendingOutboxAgeNamespace,
          Dimensions: [[]],
          Metrics: [
            {
              Name: oldestPendingOutboxAgeMetricName,
              Unit: 'Seconds',
              StorageResolution: 60,
            },
          ],
        },
      ],
    },
    [oldestPendingOutboxAgeMetricName]: ageSeconds,
  });
}

export function createEmfOldestPendingOutboxAgeRecorder(
  write: (line: string) => void = (line) => {
    process.stdout.write(`${line}\n`);
  },
): OldestPendingOutboxAgeRecorder {
  return {
    record: (ageSeconds, at) => {
      write(oldestPendingOutboxAgeEmf(ageSeconds, at));
    },
  };
}
