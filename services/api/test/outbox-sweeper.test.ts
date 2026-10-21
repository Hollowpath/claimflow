import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { StoredOutboxEvent } from '../src/adapters/aws/dynamodb-outbox-items.js';
import {
  createOutboxSweeper,
  OutboxSweepError,
  sweepGracePeriodMs,
  type PendingOutboxReader,
  type SweepPublication,
} from '../src/adapters/aws/outbox-sweeper.js';
import type {
  PublicationRecord,
  PublicationResult,
} from '../src/adapters/aws/outbox-publication.js';
import { eventSource, type OutboxEvent } from '../src/application/events.js';

const claimId = '4ce0c74b-9c64-46d6-87ba-07fb71b0628c';
const now = new Date('2026-10-14T10:50:00.123Z');

function eventNumber(n: number): OutboxEvent {
  return {
    eventId: `event-${String(n).padStart(4, '0')}`,
    eventType: 'claim.review-started',
    schemaVersion: 1,
    occurredAt: '2026-10-14T10:30:00.000Z',
    source: eventSource,
    aggregate: {
      type: 'claim',
      id: claimId,
      version: 5,
      previousEventVersion: 4,
    },
    correlationId: 'c0ffee00-1111-2222-3333-444455556666',
    causationId: 'request-7d3e',
    actorId: 'sub-ben',
    payload: {
      claimId,
      employeeId: 'sub-aisha',
      assignedManagerId: 'sub-ben',
      categoryId: 'travel',
      amount: { amountMinor: 45_000, currency: 'MYR' },
    },
  };
}

const storedEvent = (n: number): StoredOutboxEvent => ({
  event: eventNumber(n),
  state: { state: 'PENDING' },
});

class FakeReader implements PendingOutboxReader {
  public readonly queries: { cutoff: string; limit: number }[] = [];
  public items: readonly StoredOutboxEvent[] = [];
  public failure: Error | undefined;

  public listPending(
    cutoff: string,
    limit: number,
  ): Promise<readonly StoredOutboxEvent[]> {
    this.queries.push({ cutoff, limit });
    return this.failure === undefined
      ? Promise.resolve(this.items)
      : Promise.reject(this.failure);
  }
}

class FakePublication implements SweepPublication {
  public readonly calls: (readonly PublicationRecord[])[] = [];
  public result: PublicationResult = { firstFailedSequenceNumber: undefined };
  public failure: Error | undefined;

  public publish(
    records: readonly PublicationRecord[],
  ): Promise<PublicationResult> {
    this.calls.push(records);
    return this.failure === undefined
      ? Promise.resolve(this.result)
      : Promise.reject(this.failure);
  }
}

let reader: FakeReader;
let publication: FakePublication;
let clockReads: number;
const metrics = { record: vi.fn<(age: number, at: Date) => void>() };

const sweeper = (clockNow: () => Date = () => now) =>
  createOutboxSweeper({
    pending: reader,
    publication,
    clock: {
      now: () => {
        clockReads += 1;
        return clockNow();
      },
    },
    metrics,
  });

beforeEach(() => {
  reader = new FakeReader();
  publication = new FakePublication();
  clockReads = 0;
  metrics.record.mockReset();
});

describe('selection', () => {
  it('reads the clock once and queries exactly five minutes earlier, for up to 10 events', async () => {
    await sweeper()();

    expect(clockReads).toBe(1);
    expect(sweepGracePeriodMs).toBe(300_000);
    expect(reader.queries).toEqual([
      { cutoff: '2026-10-14T10:45:00.123Z', limit: 10 },
    ]);
  });

  it('queries once only, without looping', async () => {
    reader.items = Array.from({ length: 10 }, (_, i) => storedEvent(i + 1));

    await sweeper()();

    expect(reader.queries).toHaveLength(1);
  });

  it('returns successfully without publishing when nothing is pending', async () => {
    expect(await sweeper()()).toEqual({ selected: 0 });
    expect(publication.calls).toEqual([]);
  });
});

describe('publication', () => {
  it('passes the events in query order, with the event ID as the sequence number', async () => {
    reader.items = [3, 1, 2].map(storedEvent);

    await sweeper()();

    expect(publication.calls).toEqual([
      [3, 1, 2].map((n) => ({
        sequenceNumber: eventNumber(n).eventId,
        event: eventNumber(n),
      })),
    ]);
  });

  it('has unique sequence numbers for distinct events', async () => {
    reader.items = [1, 2, 3].map(storedEvent);

    await sweeper()();

    const sequences = publication.calls[0]!.map((r) => r.sequenceNumber);
    expect(new Set(sequences).size).toBe(3);
  });

  it.each([1, 10])(
    'returns the number selected for a batch of %s',
    async (size) => {
      reader.items = Array.from({ length: size }, (_, i) => storedEvent(i + 1));

      expect(await sweeper()()).toEqual({ selected: size });
      expect(publication.calls[0]).toHaveLength(size);
    },
  );

  it('is deterministic', async () => {
    reader.items = [1, 2].map(storedEvent);

    const run = sweeper();
    expect(await run()).toEqual(await run());
  });
});

describe('failures', () => {
  it('throws one fixed safe error when publication reports a failure', async () => {
    reader.items = [1, 2].map(storedEvent);
    publication.result = { firstFailedSequenceNumber: eventNumber(2).eventId };

    const error = await sweeper()().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OutboxSweepError);
    expect((error as Error).message).toBe(
      'The outbox sweep did not publish every selected event.',
    );
    expect((error as Error).message).not.toContain('event-0002');
    expect(publication.calls).toHaveLength(1);
  });

  it('propagates query errors unchanged, without publishing', async () => {
    reader.failure = Object.assign(new Error('Rate exceeded'), {
      name: 'ThrottlingException',
    });

    await expect(sweeper()()).rejects.toBe(reader.failure);
    expect(publication.calls).toEqual([]);
  });

  it('propagates a throwing clock unchanged, without querying', async () => {
    const failure = new Error('clock unavailable');

    await expect(
      sweeper(() => {
        throw failure;
      })(),
    ).rejects.toBe(failure);
    expect(reader.queries).toEqual([]);
    expect(clockReads).toBe(1);
  });

  it('propagates an invalid clock date, without querying', async () => {
    await expect(sweeper(() => new Date('not a date'))()).rejects.toThrow(
      RangeError,
    );
    expect(reader.queries).toEqual([]);
  });

  it('propagates a publication invariant error unchanged', async () => {
    reader.items = [storedEvent(1)];
    publication.failure = new TypeError('Sequence numbers must be unique.');

    await expect(sweeper()()).rejects.toBe(publication.failure);
  });

  it('does not retry on its own', async () => {
    reader.items = [storedEvent(1)];
    publication.result = { firstFailedSequenceNumber: eventNumber(1).eventId };
    const spy = vi.spyOn(publication, 'publish');

    await expect(sweeper()()).rejects.toBeInstanceOf(OutboxSweepError);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(reader.queries).toHaveLength(1);
  });
});

describe('oldest pending age metric', () => {
  const at = (iso: string) => ({
    ...storedEvent(1),
    event: { ...eventNumber(1), occurredAt: iso },
  });

  it('reports 0 when no event is older than the grace period', async () => {
    await sweeper()();

    expect(metrics.record).toHaveBeenCalledExactlyOnceWith(0, now);
  });

  it('reports the age of the oldest selected event, ignoring order', async () => {
    reader.items = [
      at('2026-10-14T10:40:00.000Z'),
      at('2026-10-14T10:20:30.000Z'),
      at('2026-10-14T10:30:00.000Z'),
    ];

    await sweeper()();

    // 10:50:00.123 - 10:20:30.000 = 1770.123 s, floored.
    expect(metrics.record).toHaveBeenCalledExactlyOnceWith(1770, now);
  });

  it('uses the single clock reading for the cutoff, the age, and the timestamp', async () => {
    reader.items = [at('2026-10-14T10:49:00.000Z')];

    await sweeper()();

    expect(clockReads).toBe(1);
    expect(metrics.record).toHaveBeenCalledWith(60, now);
  });

  it('reports before publishing', async () => {
    const order: string[] = [];
    metrics.record.mockImplementation(() => void order.push('metric'));
    publication.publish = (records) => {
      order.push('publish');
      void records;
      return Promise.resolve({ firstFailedSequenceNumber: undefined });
    };
    reader.items = [storedEvent(1)];

    await sweeper()();

    expect(order).toEqual(['metric', 'publish']);
  });

  it('still reports when publication then fails', async () => {
    reader.items = [storedEvent(1)];
    publication.result = { firstFailedSequenceNumber: eventNumber(1).eventId };

    await expect(sweeper()()).rejects.toBeInstanceOf(OutboxSweepError);

    expect(metrics.record).toHaveBeenCalledTimes(1);
  });

  it('does not report when the query fails', async () => {
    reader.failure = new Error('Rate exceeded');

    await expect(sweeper()()).rejects.toBe(reader.failure);

    expect(metrics.record).not.toHaveBeenCalled();
  });

  it('publishes even if the recorder throws', async () => {
    metrics.record.mockImplementation(() => {
      throw new Error('stdout closed');
    });
    reader.items = [storedEvent(1), storedEvent(2)];

    expect(await sweeper()()).toEqual({ selected: 2 });
    expect(publication.calls).toHaveLength(1);
  });

  it('publishes even if an event timestamp is unreadable, and reports nothing', async () => {
    reader.items = [at('not a time')];

    expect(await sweeper()()).toEqual({ selected: 1 });
    expect(metrics.record).not.toHaveBeenCalled();
    expect(publication.calls).toHaveLength(1);
  });
});
