/* eslint-disable @typescript-eslint/prefer-promise-reject-errors -- the fake rejects with scripted values, which may not be Errors */
import {
  PutEventsCommand,
  type EventBridgeClient,
  type PutEventsCommandOutput,
} from '@aws-sdk/client-eventbridge';
import { beforeEach, describe, expect, expectTypeOf, it } from 'vitest';

import { ItemEncodingError } from '../src/adapters/aws/dynamodb-items.js';
import {
  EventBridgePublisher,
  maxPublishBatch,
  type EventBusClient,
} from '../src/adapters/aws/eventbridge-publisher.js';
import {
  eventSource,
  outboxEventTypes,
  type OutboxEvent,
} from '../src/application/events.js';

const claimId = '4ce0c74b-9c64-46d6-87ba-07fb71b0628c';
const at = '2026-10-14T10:41:00.000Z';
const busName = 'claimflow';

const claim = {
  claimId,
  employeeId: 'sub-aisha',
  assignedManagerId: 'sub-ben',
  categoryId: 'travel',
  amount: { amountMinor: 45_000, currency: 'MYR' },
};
const onClaim = (version: number, previous: number | null) => ({
  type: 'claim' as const,
  id: claimId,
  version,
  previousEventVersion: previous,
});
const onCategory = (version: number, previous: number | null) => ({
  type: 'category' as const,
  id: 'travel',
  version,
  previousEventVersion: previous,
});
const header = (n: number) => ({
  eventId: `event-${String(n).padStart(4, '0')}`,
  schemaVersion: 1 as const,
  occurredAt: at,
  source: eventSource as typeof eventSource,
  correlationId: 'c0ffee00-1111-2222-3333-444455556666',
  causationId: 'request-7d3e',
  actorId: 'sub-aisha',
});

/** One event of every approved type. */
const events: readonly OutboxEvent[] = [
  {
    ...header(1),
    eventType: 'claim.submitted',
    aggregate: onClaim(4, null),
    payload: { ...claim, submittedAt: at },
  },
  {
    ...header(2),
    eventType: 'claim.review-started',
    aggregate: onClaim(5, 4),
    payload: claim,
  },
  {
    ...header(3),
    eventType: 'claim.approved',
    aggregate: onClaim(6, 5),
    payload: { ...claim, reviewedAt: at },
  },
  {
    ...header(4),
    eventType: 'claim.rejected',
    aggregate: onClaim(6, 5),
    payload: { ...claim, reviewedAt: at },
  },
  {
    ...header(5),
    eventType: 'claim.reopened',
    aggregate: onClaim(7, 6),
    payload: claim,
  },
  {
    ...header(6),
    eventType: 'claim.paid',
    aggregate: onClaim(7, 6),
    payload: { ...claim, paidBy: 'sub-dan', paidAt: at },
  },
  {
    ...header(7),
    eventType: 'category.created',
    aggregate: onCategory(1, null),
    payload: {
      categoryId: 'travel',
      version: 1,
      active: true,
      currency: 'MYR',
      maxAmountMinor: 200_000,
      receiptRequiredAboveMinor: 0,
    },
  },
  {
    ...header(8),
    eventType: 'category.policy-changed',
    aggregate: onCategory(2, 1),
    payload: { categoryId: 'travel', version: 2, maxAmountMinor: 1 },
  },
  {
    ...header(9),
    eventType: 'category.deactivated',
    aggregate: onCategory(3, 2),
    payload: { categoryId: 'travel', version: 3 },
  },
  {
    ...header(10),
    eventType: 'category.activated',
    aggregate: onCategory(4, 3),
    payload: { categoryId: 'travel', version: 4 },
  },
  {
    ...header(11),
    eventType: 'category.deleted',
    aggregate: onCategory(5, 4),
    payload: { categoryId: 'travel', version: 5 },
  },
  {
    ...header(12),
    eventType: 'internal.receipt-object-deletion-requested',
    aggregate: {
      type: 'claim',
      id: claimId,
      version: 6,
      previousEventVersion: null,
    },
    payload: { claimId, receiptId: 'r-7731', objectKey: 'receipts/r-7731' },
  },
  {
    ...header(13),
    eventType: 'internal.claim-history-purge-requested',
    aggregate: {
      type: 'claim',
      id: claimId,
      version: 2,
      previousEventVersion: null,
    },
    payload: { claimId },
  },
];

/** Records commands and answers as scripted. */
class FakeBus implements EventBusClient {
  public readonly commands: unknown[] = [];
  public output: PutEventsCommandOutput = {
    $metadata: {},
    FailedEntryCount: 0,
    Entries: [],
  };
  public failure: unknown;

  public send(command: PutEventsCommand): Promise<PutEventsCommandOutput> {
    this.commands.push(command);
    return this.failure === undefined
      ? Promise.resolve(this.output)
      : Promise.reject(this.failure);
  }
}

let bus: FakeBus;
let publisher: EventBridgePublisher;

beforeEach(() => {
  bus = new FakeBus();
  publisher = new EventBridgePublisher({ client: bus, eventBusName: busName });
});

async function errorOf(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  return undefined;
}

it('accepts the real EventBridge client', () => {
  expectTypeOf<EventBridgeClient>().toExtend<EventBusClient>();
});

describe('publish', () => {
  it('sends one PutEvents command with an exact entry per event, in order', async () => {
    const batch = events.slice(0, 3);

    await publisher.publish(batch);

    expect(bus.commands).toHaveLength(1);
    expect(bus.commands[0]).toBeInstanceOf(PutEventsCommand);
    expect((bus.commands[0] as PutEventsCommand).input).toEqual({
      Entries: batch.map((event) => ({
        EventBusName: 'claimflow',
        Source: 'claimflow.api',
        DetailType: event.eventType,
        Detail: JSON.stringify(event),
      })),
    });
  });

  it('puts the complete envelope in the detail, not a stored item', async () => {
    await publisher.publish([events[0]!]);

    const detail = JSON.parse(
      (bus.commands[0] as PutEventsCommand).input.Entries![0]!.Detail!,
    ) as Record<string, unknown>;
    expect(detail).toEqual(events[0]);
    for (const stored of ['PK', 'SK', 'state', 'entityType', 'GSI4PK']) {
      expect(detail).not.toHaveProperty(stored);
    }
  });

  it('covers every event family, with the event type as the detail type', async () => {
    expect(events.map((e) => e.eventType).sort()).toEqual(
      [...outboxEventTypes].sort(),
    );

    for (const event of events) {
      await publisher.publish([event]);
    }

    const entries = bus.commands.map(
      (c) => (c as PutEventsCommand).input.Entries![0]!,
    );
    expect(entries.map((e) => e.DetailType)).toEqual(
      events.map((e) => e.eventType),
    );
    expect(
      entries.every(
        (e) => e.Source === 'claimflow.api' && e.EventBusName === busName,
      ),
    ).toBe(true);
  });

  it.each([1, maxPublishBatch])(
    'accepts a batch of %s events',
    async (size) => {
      const batch = events.slice(0, size);

      await publisher.publish(batch);

      expect((bus.commands[0] as PutEventsCommand).input.Entries).toHaveLength(
        size,
      );
    },
  );

  it('preserves input order, including a reversed batch', async () => {
    const batch = [...events.slice(0, 5)].reverse();

    await publisher.publish(batch);

    expect(
      (bus.commands[0] as PutEventsCommand).input.Entries!.map(
        (e) => (JSON.parse(e.Detail!) as OutboxEvent).eventId,
      ),
    ).toEqual(batch.map((e) => e.eventId));
  });

  it('returns the SDK result unchanged, including failures', async () => {
    bus.output = {
      $metadata: { requestId: 'req-1' },
      FailedEntryCount: 1,
      Entries: [
        { EventId: 'a' },
        { ErrorCode: 'InternalFailure', ErrorMessage: 'x' },
      ],
    };

    expect(await publisher.publish(events.slice(0, 2))).toBe(bus.output);
    expect(bus.commands).toHaveLength(1);
  });
});

describe('validation before sending', () => {
  it.each(['', undefined, null, 42] as unknown[])(
    'rejects bus name %j at construction',
    (name) => {
      expect(
        () =>
          new EventBridgePublisher({
            client: bus,
            eventBusName: name as string,
          }),
      ).toThrow('The event bus name is missing.');
      expect(bus.commands).toEqual([]);
    },
  );

  it.each([
    ['an empty batch', []],
    [
      'an oversized batch',
      Array.from({ length: 11 }, (_, i) => ({
        ...events[0]!,
        eventId: `event-x${i}`,
      })),
    ],
    ['a non-list', 'events' as unknown as OutboxEvent[]],
  ])('rejects %s', async (_name, batch) => {
    expect(await errorOf(() => publisher.publish(batch))).toBeInstanceOf(
      RangeError,
    );
    expect(bus.commands).toEqual([]);
  });

  it.each<[string, (event: OutboxEvent) => unknown]>([
    ['another source', (e) => ({ ...e, source: 'elsewhere' })],
    ['an unknown type', (e) => ({ ...e, eventType: 'claim.archived' })],
    [
      'free text in the payload',
      (e) => ({ ...e, payload: { ...e.payload, merchant: 'Cafe' } }),
    ],
    ['a bad timestamp', (e) => ({ ...e, occurredAt: '2026-10-14' })],
    ['a bad trace ID', (e) => ({ ...e, correlationId: 'not valid!' })],
  ])(
    'rejects a batch containing an event with %s, sending nothing',
    async (_name, change) => {
      const batch = [events[0]!, change(events[1]!) as OutboxEvent, events[2]!];

      expect(await errorOf(() => publisher.publish(batch))).toBeInstanceOf(
        ItemEncodingError,
      );
      expect(bus.commands).toEqual([]);
    },
  );
});

describe('SDK errors', () => {
  it.each([
    Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' }),
    Object.assign(new Error('Internal'), { name: 'InternalException' }),
    'boom',
  ])('propagates %j unchanged, without a retry', async (failure) => {
    bus.failure = failure;

    expect(await errorOf(() => publisher.publish(events.slice(0, 2)))).toBe(
      failure,
    );
    expect(bus.commands).toHaveLength(1);
  });
});
