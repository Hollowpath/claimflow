/* eslint-disable @typescript-eslint/prefer-promise-reject-errors -- the fake rejects with scripted values, which may not be Errors */
import {
  QueryCommand,
  type DynamoDBDocumentClient,
  type QueryCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import { beforeEach, describe, expect, expectTypeOf, it } from 'vitest';

import {
  ItemIntegrityError,
  type DynamoItem,
} from '../src/adapters/aws/dynamodb-items.js';
import {
  encodeOutboxItem,
  publishedState,
} from '../src/adapters/aws/dynamodb-outbox-items.js';
import {
  DynamoDbPendingOutbox,
  maxPendingBatch,
  pendingOutboxCondition,
  type QueryDocumentClient,
} from '../src/adapters/aws/dynamodb-pending-outbox.js';
import { eventSource, type OutboxEvent } from '../src/application/events.js';

const tableName = 'ClaimFlow';
const claimId = '4ce0c74b-9c64-46d6-87ba-07fb71b0628c';
const cutoff = '2026-10-14T10:36:00.000Z';

function eventAt(minute: number, suffix = ''): OutboxEvent {
  const occurredAt = new Date(
    Date.parse('2026-10-14T10:30:00.000Z') + minute * 60_000,
  ).toISOString();
  return {
    eventId: `event-${String(minute).padStart(3, '0')}${suffix}`,
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

/**
 * A fake GSI4: it answers the query as DynamoDB would, ordering by the index
 * sort key, applying the key condition and `Limit`, and refusing anything the
 * adapter should not send.
 */
class FakeIndex implements QueryDocumentClient {
  public readonly commands: unknown[] = [];
  public readonly items: DynamoItem[] = [];
  public failure: unknown;

  public send(command: QueryCommand): Promise<QueryCommandOutput> {
    this.commands.push(command);
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
    const input = command.input;
    const values = input.ExpressionAttributeValues!;
    const forward = input.ScanIndexForward !== false;
    const matches = this.items
      .filter(
        (item) =>
          item.GSI4PK === values[':pk'] &&
          String(item.GSI4SK) < String(values[':cutoff']),
      )
      .sort((a, b) => String(a.GSI4SK).localeCompare(String(b.GSI4SK)));
    if (!forward) {
      matches.reverse();
    }
    return Promise.resolve({
      $metadata: {},
      Items: matches.slice(0, input.Limit),
    });
  }
}

let index: FakeIndex;
let pending: DynamoDbPendingOutbox;

beforeEach(() => {
  index = new FakeIndex();
  pending = new DynamoDbPendingOutbox({ client: index, tableName });
});

async function errorOf(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  return undefined;
}

const store = (...events: OutboxEvent[]) =>
  index.items.push(...events.map((event) => encodeOutboxItem(event)));

it('accepts the real DynamoDB document client', () => {
  expectTypeOf<DynamoDBDocumentClient>().toExtend<QueryDocumentClient>();
});

describe('listPending', () => {
  it('sends one exact eventually consistent GSI4 query, oldest first', async () => {
    await pending.listPending(cutoff, 10);

    expect(index.commands).toHaveLength(1);
    expect(index.commands[0]).toBeInstanceOf(QueryCommand);
    expect((index.commands[0] as QueryCommand).input).toEqual({
      TableName: 'ClaimFlow',
      IndexName: 'GSI4',
      KeyConditionExpression: '#pk = :pk AND #sk < :cutoff',
      ExpressionAttributeNames: { '#pk': 'GSI4PK', '#sk': 'GSI4SK' },
      ExpressionAttributeValues: { ':pk': 'OUTBOX#PENDING', ':cutoff': cutoff },
      ScanIndexForward: true,
      ConsistentRead: false,
      Limit: 10,
    });
    expect(pendingOutboxCondition).toBe('#pk = :pk AND #sk < :cutoff');
  });

  it('uses no filter, scan, or paging cursor', async () => {
    await pending.listPending(cutoff, 3);

    const input = (index.commands[0] as QueryCommand).input;
    expect(input).not.toHaveProperty('FilterExpression');
    expect(input).not.toHaveProperty('ExclusiveStartKey');
    expect(index.commands.every((c) => c instanceof QueryCommand)).toBe(true);
  });

  it('returns older events oldest first, decoded with their pending state', async () => {
    const [a, b, c] = [eventAt(3), eventAt(1), eventAt(2)];
    store(a, b, c, eventAt(9));

    const found = await pending.listPending(cutoff, 10);

    expect(found.map((stored) => stored.event.eventId)).toEqual([
      'event-001',
      'event-002',
      'event-003',
    ]);
    expect(found[0]).toEqual({ event: b, state: { state: 'PENDING' } });
  });

  it('excludes an event exactly at the cutoff and includes the one before', async () => {
    store(eventAt(6), eventAt(5));

    const found = await pending.listPending(cutoff, 10);

    expect(found.map((s) => s.event.occurredAt)).toEqual([
      '2026-10-14T10:35:00.000Z',
    ]);
  });

  it('returns nothing when no event is old enough', async () => {
    store(eventAt(8), eventAt(9));

    expect(await pending.listPending(cutoff, 10)).toEqual([]);
    expect(
      await new DynamoDbPendingOutbox({
        client: new FakeIndex(),
        tableName,
      }).listPending(cutoff, 1),
    ).toEqual([]);
  });

  it('passes the limit and returns no more than it', async () => {
    store(...[1, 2, 3, 4, 5].map((m) => eventAt(m)));

    const found = await pending.listPending(cutoff, 2);

    expect((index.commands[0] as QueryCommand).input.Limit).toBe(2);
    expect(found.map((s) => s.event.eventId)).toEqual([
      'event-001',
      'event-002',
    ]);
  });

  it.each([1, maxPendingBatch])('accepts a limit of %s', async (limit) => {
    await expect(pending.listPending(cutoff, limit)).resolves.toEqual([]);
  });

  it('keeps events with the same time in event-ID order', async () => {
    store(eventAt(1, 'b'), eventAt(1, 'a'));

    expect(
      (await pending.listPending(cutoff, 10)).map((s) => s.event.eventId),
    ).toEqual(['event-001a', 'event-001b']);
  });
});

describe('strict decoding', () => {
  it('rejects a published event found in the pending index', async () => {
    index.items.push({
      ...encodeOutboxItem(
        eventAt(1),
        publishedState('2026-10-14T10:32:00.000Z'),
      ),
      GSI4PK: 'OUTBOX#PENDING',
      GSI4SK: `${eventAt(1).occurredAt}#${eventAt(1).eventId}`,
    });

    expect(await errorOf(() => pending.listPending(cutoff, 10))).toBeInstanceOf(
      ItemIntegrityError,
    );
  });

  it('rejects a published item that lost its index attributes but is returned anyway', async () => {
    const item = encodeOutboxItem(
      eventAt(1),
      publishedState('2026-10-14T10:32:00.000Z'),
    );
    const odd = new (class extends FakeIndex {
      public override send(command: QueryCommand): Promise<QueryCommandOutput> {
        this.commands.push(command);
        return Promise.resolve({ $metadata: {}, Items: [item] });
      }
    })();

    const error = await errorOf(() =>
      new DynamoDbPendingOutbox({ client: odd, tableName }).listPending(
        cutoff,
        10,
      ),
    );

    expect(error).toBeInstanceOf(ItemIntegrityError);
    expect(String(error)).toContain(
      'a published event is in the pending index',
    );
  });

  it.each<[string, (item: DynamoItem) => DynamoItem]>([
    ['an unknown state', (item) => ({ ...item, state: 'FAILED' })],
    ['a wrong sort key', (item) => ({ ...item, GSI4SK: 'wrong' })],
    [
      'free text in the payload',
      (item) => ({
        ...item,
        payload: { ...(item.payload as DynamoItem), merchant: 'Cafe' },
      }),
    ],
    ['an unexpected attribute', (item) => ({ ...item, extra: 1 })],
  ])('rejects an item with %s', async (_name, change) => {
    const item = encodeOutboxItem(eventAt(1));
    const odd = new (class extends FakeIndex {
      public override send(command: QueryCommand): Promise<QueryCommandOutput> {
        this.commands.push(command);
        return Promise.resolve({ $metadata: {}, Items: [change(item)] });
      }
    })();

    expect(
      await errorOf(() =>
        new DynamoDbPendingOutbox({ client: odd, tableName }).listPending(
          cutoff,
          10,
        ),
      ),
    ).toBeInstanceOf(ItemIntegrityError);
  });
});

describe('validation before sending', () => {
  it.each(['', undefined, null, 42] as unknown[])(
    'rejects table name %j',
    (name) => {
      expect(
        () =>
          new DynamoDbPendingOutbox({
            client: index,
            tableName: name as string,
          }),
      ).toThrow('The table name is missing.');
      expect(index.commands).toEqual([]);
    },
  );

  it.each([
    ['a non-canonical time', '2026-10-14T10:36:00Z'],
    ['a date only', '2026-10-14'],
    ['an impossible time', '2026-02-30T00:00:00.000Z'],
    ['text', 'now'],
    ['an empty string', ''],
    ['a time with an event ID', `${cutoff}#event`],
  ])('rejects %s as the cutoff', async (_name, bad) => {
    expect(await errorOf(() => pending.listPending(bad, 5))).toBeInstanceOf(
      TypeError,
    );
    expect(index.commands).toEqual([]);
  });

  it.each([0, -1, 1.5, Number.NaN, 11, 100, Number.MAX_SAFE_INTEGER + 1])(
    'rejects a limit of %s',
    async (limit) => {
      expect(
        await errorOf(() => pending.listPending(cutoff, limit)),
      ).toBeInstanceOf(RangeError);
      expect(index.commands).toEqual([]);
    },
  );
});

describe('SDK errors', () => {
  it.each([
    Object.assign(new Error('Rate exceeded'), {
      name: 'ProvisionedThroughputExceededException',
    }),
    Object.assign(new Error('Timed out'), { name: 'TimeoutError' }),
    'boom',
  ])('propagates %j unchanged', async (failure) => {
    index.failure = failure;

    expect(await errorOf(() => pending.listPending(cutoff, 5))).toBe(failure);
    expect(index.commands).toHaveLength(1);
  });
});
