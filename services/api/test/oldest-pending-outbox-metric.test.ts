import { describe, expect, it, vi } from 'vitest';

import type { StoredOutboxEvent } from '../src/adapters/aws/dynamodb-outbox-items.js';
import {
  createEmfOldestPendingOutboxAgeRecorder,
  oldestPendingAgeSeconds,
  oldestPendingOutboxAgeEmf,
} from '../src/adapters/aws/oldest-pending-outbox-metric.js';
import { eventSource } from '../src/application/events.js';

const now = new Date('2026-10-14T10:50:00.500Z');

const stored = (occurredAt: string): StoredOutboxEvent => ({
  event: {
    eventId: `event-${occurredAt}`,
    eventType: 'claim.review-started',
    schemaVersion: 1,
    occurredAt,
    source: eventSource,
    aggregate: { type: 'claim', id: 'c', version: 2, previousEventVersion: 1 },
    correlationId: 'corr',
    causationId: 'cause',
    actorId: 'sub-ben',
    payload: {
      claimId: 'c',
      employeeId: 'e',
      assignedManagerId: 'm',
      categoryId: 'travel',
      amount: { amountMinor: 1, currency: 'MYR' },
    },
  },
  state: { state: 'PENDING' },
});

describe('oldestPendingAgeSeconds', () => {
  it('is 0 for no events', () => {
    expect(oldestPendingAgeSeconds([], now)).toBe(0);
  });

  it('is the whole seconds since the oldest event, in any order', () => {
    expect(
      oldestPendingAgeSeconds(
        [
          stored('2026-10-14T10:45:00.000Z'),
          stored('2026-10-14T10:30:00.000Z'),
        ],
        now,
      ),
    ).toBe(1200);
    expect(
      oldestPendingAgeSeconds([stored('2026-10-14T10:49:59.900Z')], now),
    ).toBe(0);
  });

  it('never goes negative for an event from the future', () => {
    expect(
      oldestPendingAgeSeconds([stored('2026-10-14T11:00:00.000Z')], now),
    ).toBe(0);
  });

  it('rejects an unreadable timestamp instead of reporting 0', () => {
    expect(() => oldestPendingAgeSeconds([stored('nope')], now)).toThrow(
      RangeError,
    );
  });
});

describe('Embedded Metric Format output', () => {
  it('is one dimensionless standard-resolution metric in seconds', () => {
    expect(JSON.parse(oldestPendingOutboxAgeEmf(1769, now))).toEqual({
      _aws: {
        Timestamp: now.getTime(),
        CloudWatchMetrics: [
          {
            Namespace: 'ClaimFlow',
            Dimensions: [[]],
            Metrics: [
              {
                Name: 'OldestPendingOutboxAge',
                Unit: 'Seconds',
                StorageResolution: 60,
              },
            ],
          },
        ],
      },
      OldestPendingOutboxAge: 1769,
    });
  });

  it('writes a single line with no event data', () => {
    const write = vi.fn<(line: string) => void>();
    createEmfOldestPendingOutboxAgeRecorder(write).record(0, now);

    expect(write).toHaveBeenCalledTimes(1);
    const line = write.mock.calls[0]![0];
    expect(line).not.toContain('\n');
    expect(JSON.parse(line).OldestPendingOutboxAge).toBe(0);
    expect(Object.keys(JSON.parse(line)).sort()).toEqual([
      'OldestPendingOutboxAge',
      '_aws',
    ]);
  });
});
