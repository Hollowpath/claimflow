/* eslint-disable @typescript-eslint/prefer-promise-reject-errors -- the fakes reject with scripted values, which may not be Errors */
import type { PutEventsCommandOutput } from '@aws-sdk/client-eventbridge';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  publishedState,
  type StoredOutboxEvent,
} from '../src/adapters/aws/dynamodb-outbox-items.js';
import {
  OutboxPublication,
  type OutboxEventPublisher,
  type OutboxStateStore,
  type PublicationRecord,
} from '../src/adapters/aws/outbox-publication.js';
import { eventSource, type OutboxEvent } from '../src/application/events.js';

const claimId = '4ce0c74b-9c64-46d6-87ba-07fb71b0628c';
const occurredAt = '2026-10-14T10:41:00.000Z';
const now = new Date('2026-10-14T10:50:00.000Z');

function eventNumber(n: number): OutboxEvent {
  return {
    eventId: `event-${String(n).padStart(4, '0')}`,
    eventType: 'claim.review-started',
    schemaVersion: 1,
    occurredAt,
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

const record = (n: number): PublicationRecord => ({
  sequenceNumber: `seq-${n}`,
  event: eventNumber(n),
});

const conditional = Object.assign(new Error('The conditional request failed'), {
  name: 'ConditionalCheckFailedException',
});
const throttled = Object.assign(new Error('Rate exceeded'), {
  name: 'ThrottlingException',
});

/** A scripted outbox: items by event ID, with optional read and mark failures. */
class FakeState implements OutboxStateStore {
  public readonly reads: string[] = [];
  public readonly marks: { eventId: string; publishedAt: string }[] = [];
  public readonly stored = new Map<string, StoredOutboxEvent | 'missing'>();
  public readFailures = new Map<string, unknown>();
  public markFailures = new Map<string, unknown>();

  public pending(n: number): void {
    this.stored.set(eventNumber(n).eventId, {
      event: eventNumber(n),
      state: { state: 'PENDING' },
    });
  }

  public get(event: OutboxEvent): Promise<StoredOutboxEvent | undefined> {
    this.reads.push(event.eventId);
    if (this.readFailures.has(event.eventId)) {
      return Promise.reject(this.readFailures.get(event.eventId));
    }
    const item = this.stored.get(event.eventId);
    return Promise.resolve(item === 'missing' ? undefined : item);
  }

  public markPublished(event: OutboxEvent, publishedAt: string): Promise<void> {
    this.marks.push({ eventId: event.eventId, publishedAt });
    return this.markFailures.has(event.eventId)
      ? Promise.reject(this.markFailures.get(event.eventId))
      : Promise.resolve();
  }
}

/** A scripted EventBridge: records batches, answers per entry or fails. */
class FakePublisher implements OutboxEventPublisher {
  public readonly batches: OutboxEvent[][] = [];
  public failure: unknown;
  public answer:
    ((events: readonly OutboxEvent[]) => PutEventsCommandOutput) | undefined;

  public publish(
    events: readonly OutboxEvent[],
  ): Promise<PutEventsCommandOutput> {
    this.batches.push([...events]);
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
    return Promise.resolve(
      this.answer ? this.answer(events) : accepted(events.length),
    );
  }
}

const accepted = (count: number): PutEventsCommandOutput => ({
  $metadata: {},
  FailedEntryCount: 0,
  Entries: Array.from({ length: count }, (_, i) => ({ EventId: `bus-${i}` })),
});

const answerWith =
  (
    results: ('ok' | 'error')[],
  ): ((events: readonly OutboxEvent[]) => PutEventsCommandOutput) =>
  () => ({
    $metadata: {},
    FailedEntryCount: results.filter((r) => r === 'error').length,
    Entries: results.map((r, i) =>
      r === 'ok'
        ? { EventId: `bus-${i}` }
        : { ErrorCode: 'InternalFailure', ErrorMessage: 'x' },
    ),
  });

let state: FakeState;
let publisher: FakePublisher;
let workflow: OutboxPublication;
let clockReads: number;

beforeEach(() => {
  state = new FakeState();
  publisher = new FakePublisher();
  clockReads = 0;
  workflow = new OutboxPublication({
    state,
    publisher,
    clock: {
      now: () => {
        clockReads += 1;
        return now;
      },
    },
  });
});

describe('skipping', () => {
  it('skips missing and already published items and publishes the rest in order', async () => {
    state.pending(1);
    state.stored.set(eventNumber(2).eventId, 'missing');
    state.stored.set(eventNumber(3).eventId, {
      event: eventNumber(3),
      state: publishedState('2026-10-14T10:45:00.000Z'),
    });
    state.pending(4);

    const result = await workflow.publish([1, 2, 3, 4].map(record));

    expect(result).toEqual({ firstFailedSequenceNumber: undefined });
    expect(publisher.batches.map((b) => b.map((e) => e.eventId))).toEqual([
      ['event-0001', 'event-0004'],
    ]);
    expect(state.marks.map((m) => m.eventId)).toEqual([
      'event-0001',
      'event-0004',
    ]);
  });

  it('does not call EventBridge when every record is missing or published', async () => {
    state.stored.set(eventNumber(1).eventId, 'missing');
    state.stored.set(eventNumber(2).eventId, {
      event: eventNumber(2),
      state: publishedState('2026-10-14T10:45:00.000Z'),
    });

    expect(await workflow.publish([record(1), record(2)])).toEqual({
      firstFailedSequenceNumber: undefined,
    });
    expect(publisher.batches).toEqual([]);
    expect(state.marks).toEqual([]);
    expect(clockReads).toBe(0);
  });

  it('treats duplicate delivery as a no-op once published', async () => {
    state.pending(1);
    await workflow.publish([record(1)]);
    state.stored.set(eventNumber(1).eventId, {
      event: eventNumber(1),
      state: publishedState('2026-10-14T10:50:00.000Z'),
    });

    expect(await workflow.publish([record(1)])).toEqual({
      firstFailedSequenceNumber: undefined,
    });
    expect(publisher.batches).toHaveLength(1);
  });

  it('publishes the decoded stored event, not the delivered one', async () => {
    const stored = { ...eventNumber(1), causationId: 'stored-request' };
    state.stored.set(eventNumber(1).eventId, {
      event: stored,
      state: { state: 'PENDING' },
    });

    await workflow.publish([record(1)]);

    expect(publisher.batches[0]![0]).toBe(stored);
    expect(state.marks).toHaveLength(1);
  });

  it('rereads every event once', async () => {
    [1, 2, 3].forEach((n) => state.pending(n));

    await workflow.publish([1, 2, 3].map(record));

    expect(state.reads.sort()).toEqual([
      'event-0001',
      'event-0002',
      'event-0003',
    ]);
  });
});

describe('publishing and marking', () => {
  it('marks every successful entry with one clock time', async () => {
    [1, 2, 3].forEach((n) => state.pending(n));

    await workflow.publish([1, 2, 3].map(record));

    expect(clockReads).toBe(1);
    expect(state.marks).toEqual(
      [1, 2, 3].map((n) => ({
        eventId: eventNumber(n).eventId,
        publishedAt: now.toISOString(),
      })),
    );
  });

  it('marks only the entries that succeeded, matching results by index', async () => {
    [1, 2, 3, 4].forEach((n) => state.pending(n));
    publisher.answer = answerWith(['ok', 'error', 'ok', 'error']);

    const result = await workflow.publish([1, 2, 3, 4].map(record));

    expect(result).toEqual({ firstFailedSequenceNumber: 'seq-2' });
    expect(state.marks.map((m) => m.eventId)).toEqual([
      'event-0001',
      'event-0003',
    ]);
  });

  it('pairs results with the pending events after skipping some', async () => {
    state.pending(1);
    state.stored.set(eventNumber(2).eventId, 'missing');
    state.pending(3);
    publisher.answer = answerWith(['ok', 'error']);

    const result = await workflow.publish([1, 2, 3].map(record));

    expect(result).toEqual({ firstFailedSequenceNumber: 'seq-3' });
    expect(state.marks.map((m) => m.eventId)).toEqual(['event-0001']);
  });

  it('reports the first failure in batch order, not completion order', async () => {
    [1, 2, 3].forEach((n) => state.pending(n));
    publisher.answer = answerWith(['ok', 'error']);
    state.readFailures.set(eventNumber(3).eventId, throttled);

    expect(await workflow.publish([1, 2, 3].map(record))).toEqual({
      firstFailedSequenceNumber: 'seq-2',
    });
  });

  it('fails every pending record when the whole call fails, marking none', async () => {
    [1, 2, 3].forEach((n) => state.pending(n));
    publisher.failure = throttled;

    const result = await workflow.publish([1, 2, 3].map(record));

    expect(result).toEqual({ firstFailedSequenceNumber: 'seq-1' });
    expect(state.marks).toEqual([]);
    expect(publisher.batches).toHaveLength(1);
  });

  it('does not fail records that were skipped when the call fails', async () => {
    state.stored.set(eventNumber(1).eventId, 'missing');
    state.pending(2);
    publisher.failure = throttled;

    expect(await workflow.publish([record(1), record(2)])).toEqual({
      firstFailedSequenceNumber: 'seq-2',
    });
  });
});

describe('conservative handling of unreliable results', () => {
  const cases: [string, PutEventsCommandOutput][] = [
    ['no entries', { $metadata: {}, FailedEntryCount: 0 }],
    [
      'too few entries',
      { $metadata: {}, FailedEntryCount: 0, Entries: [{ EventId: 'a' }] },
    ],
    [
      'too many entries',
      {
        $metadata: {},
        FailedEntryCount: 0,
        Entries: [{ EventId: 'a' }, { EventId: 'b' }, { EventId: 'c' }],
      },
    ],
    [
      'no failure count',
      { $metadata: {}, Entries: [{ EventId: 'a' }, { EventId: 'b' }] },
    ],
    [
      'a failure count that hides an error',
      {
        $metadata: {},
        FailedEntryCount: 0,
        Entries: [{ EventId: 'a' }, { ErrorCode: 'x' }],
      },
    ],
    [
      'a failure count that invents an error',
      {
        $metadata: {},
        FailedEntryCount: 1,
        Entries: [{ EventId: 'a' }, { EventId: 'b' }],
      },
    ],
  ];

  it.each(cases)('fails every record for %s', async (_name, output) => {
    [1, 2].forEach((n) => state.pending(n));
    publisher.answer = () => output;

    expect(await workflow.publish([record(1), record(2)])).toEqual({
      firstFailedSequenceNumber: 'seq-1',
    });
    expect(state.marks).toEqual([]);
  });

  it.each([
    ['an entry with neither ID nor error', {}],
    ['an entry with an empty event ID', { EventId: '' }],
  ])(
    'fails only the record whose entry has %s, when the counts agree',
    async (_name, entry) => {
      [1, 2].forEach((n) => state.pending(n));
      publisher.answer = () => ({
        $metadata: {},
        FailedEntryCount: 1,
        Entries: [{ EventId: 'a' }, entry],
      });

      expect(await workflow.publish([record(1), record(2)])).toEqual({
        firstFailedSequenceNumber: 'seq-2',
      });
      expect(state.marks.map((m) => m.eventId)).toEqual(['event-0001']);
    },
  );

  it('fails every record when the result is missing altogether', async () => {
    state.pending(1);
    publisher.answer = () => undefined as unknown as PutEventsCommandOutput;

    expect(await workflow.publish([record(1)])).toEqual({
      firstFailedSequenceNumber: 'seq-1',
    });
    expect(state.marks).toEqual([]);
  });
});

describe('clock failures', () => {
  const withClock = (now: () => Date) =>
    new OutboxPublication({ state, publisher, clock: { now } });

  it.each<[string, () => Date]>([
    [
      'throws',
      () => {
        throw new Error('clock unavailable');
      },
    ],
    ['returns an invalid date', () => new Date('not a date')],
    ['returns a non-date', () => undefined as unknown as Date],
  ])(
    'fails every published record, marking none, when the clock %s',
    async (_name, now) => {
      [1, 2, 3].forEach((n) => state.pending(n));

      const result = await withClock(now).publish([1, 2, 3].map(record));

      expect(result).toEqual({ firstFailedSequenceNumber: 'seq-1' });
      expect(publisher.batches).toHaveLength(1);
      expect(state.marks).toEqual([]);
    },
  );

  it('still reports the first failure in batch order', async () => {
    [1, 2].forEach((n) => state.pending(n));
    publisher.answer = answerWith(['error', 'ok']);

    const result = await withClock(() => new Date('x')).publish([
      record(1),
      record(2),
    ]);

    expect(result).toEqual({ firstFailedSequenceNumber: 'seq-1' });
    expect(state.marks).toEqual([]);
  });

  it('does not throw, and does not affect skipped records', async () => {
    state.stored.set(eventNumber(1).eventId, 'missing');
    state.pending(2);

    await expect(
      withClock(() => {
        throw new Error('clock unavailable');
      }).publish([record(1), record(2)]),
    ).resolves.toEqual({ firstFailedSequenceNumber: 'seq-2' });
  });
});

describe('error messages in EventBridge entries', () => {
  it('fails an entry that has an error message without an error code', async () => {
    [1, 2].forEach((n) => state.pending(n));
    publisher.answer = () => ({
      $metadata: {},
      FailedEntryCount: 1,
      Entries: [{ EventId: 'a' }, { EventId: 'b', ErrorMessage: 'rejected' }],
    });

    expect(await workflow.publish([record(1), record(2)])).toEqual({
      firstFailedSequenceNumber: 'seq-2',
    });
    expect(state.marks.map((m) => m.eventId)).toEqual(['event-0001']);
  });

  it('fails an entry with only an error message and no event ID', async () => {
    state.pending(1);
    publisher.answer = () => ({
      $metadata: {},
      FailedEntryCount: 1,
      Entries: [{ ErrorMessage: 'rejected' }],
    });

    expect(await workflow.publish([record(1)])).toEqual({
      firstFailedSequenceNumber: 'seq-1',
    });
    expect(state.marks).toEqual([]);
  });

  it('fails every record if the failure count does not match such entries', async () => {
    [1, 2].forEach((n) => state.pending(n));
    publisher.answer = () => ({
      $metadata: {},
      FailedEntryCount: 0,
      Entries: [{ EventId: 'a' }, { EventId: 'b', ErrorMessage: 'rejected' }],
    });

    expect(await workflow.publish([record(1), record(2)])).toEqual({
      firstFailedSequenceNumber: 'seq-1',
    });
    expect(state.marks).toEqual([]);
  });
});

describe('read and mark errors', () => {
  it('fails a record whose read fails, without stopping the others', async () => {
    [1, 2, 3].forEach((n) => state.pending(n));
    state.readFailures.set(eventNumber(2).eventId, throttled);

    const result = await workflow.publish([1, 2, 3].map(record));

    expect(result).toEqual({ firstFailedSequenceNumber: 'seq-2' });
    expect(publisher.batches[0]!.map((e) => e.eventId)).toEqual([
      'event-0001',
      'event-0003',
    ]);
    expect(state.marks.map((m) => m.eventId)).toEqual([
      'event-0001',
      'event-0003',
    ]);
  });

  it('ignores a conditional-check failure while marking', async () => {
    [1, 2].forEach((n) => state.pending(n));
    state.markFailures.set(eventNumber(1).eventId, conditional);

    expect(await workflow.publish([record(1), record(2)])).toEqual({
      firstFailedSequenceNumber: undefined,
    });
    expect(state.marks).toHaveLength(2);
  });

  it('fails a record whose mark fails for another reason, and still marks the rest', async () => {
    [1, 2, 3].forEach((n) => state.pending(n));
    state.markFailures.set(eventNumber(2).eventId, throttled);
    state.markFailures.set(eventNumber(3).eventId, conditional);

    expect(await workflow.publish([1, 2, 3].map(record))).toEqual({
      firstFailedSequenceNumber: 'seq-2',
    });
    expect(state.marks.map((m) => m.eventId)).toEqual([
      'event-0001',
      'event-0002',
      'event-0003',
    ]);
  });

  it('never throws operational failures', async () => {
    state.pending(1);
    publisher.failure = new Error('boom');
    state.readFailures.set(eventNumber(9).eventId, 'oops');

    await expect(workflow.publish([record(1), record(9)])).resolves.toEqual({
      firstFailedSequenceNumber: 'seq-1',
    });
  });

  it('does not treat a non-conditional error that only names the exception in its message as a race', async () => {
    state.pending(1);
    state.markFailures.set(
      eventNumber(1).eventId,
      new Error('ConditionalCheckFailedException'),
    );

    expect(await workflow.publish([record(1)])).toEqual({
      firstFailedSequenceNumber: 'seq-1',
    });
  });
});

describe('batch validation', () => {
  it.each([
    ['an empty batch', []],
    ['an oversized batch', Array.from({ length: 11 }, (_, i) => record(i + 1))],
    ['an empty sequence number', [{ ...record(1), sequenceNumber: '' }]],
    [
      'a missing sequence number',
      [{ event: eventNumber(1) } as unknown as PublicationRecord],
    ],
    [
      'duplicate sequence numbers',
      [record(1), { ...record(2), sequenceNumber: 'seq-1' }],
    ],
  ])('rejects %s before reading anything', async (_name, batch) => {
    await expect(workflow.publish(batch)).rejects.toThrow();
    expect(state.reads).toEqual([]);
    expect(publisher.batches).toEqual([]);
  });

  it('accepts batches of 1 and 10', async () => {
    for (let n = 1; n <= 10; n += 1) {
      state.pending(n);
    }

    await expect(workflow.publish([record(1)])).resolves.toBeDefined();
    await expect(
      workflow.publish(Array.from({ length: 10 }, (_, i) => record(i + 1))),
    ).resolves.toEqual({ firstFailedSequenceNumber: undefined });
  });
});
