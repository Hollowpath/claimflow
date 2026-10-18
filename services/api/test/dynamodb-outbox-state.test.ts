/* eslint-disable @typescript-eslint/prefer-promise-reject-errors -- the fake rejects with scripted values, which may not be Errors */
import {
  GetCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
  type GetCommandOutput,
  type UpdateCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import { beforeEach, describe, expect, expectTypeOf, it } from 'vitest';

import {
  ItemEncodingError,
  ItemIntegrityError,
  type DynamoItem,
} from '../src/adapters/aws/dynamodb-items.js';
import {
  encodeOutboxItem,
  publishedState,
} from '../src/adapters/aws/dynamodb-outbox-items.js';
import {
  DynamoDbOutboxState,
  outboxPublishCondition,
  type OutboxDocumentClient,
} from '../src/adapters/aws/dynamodb-outbox-state.js';
import { toEpochSeconds } from '../src/application/commit.js';
import { eventSource, type OutboxEvent } from '../src/application/events.js';

const tableName = 'ClaimFlow';
const claimId = '4ce0c74b-9c64-46d6-87ba-07fb71b0628c';
const at = '2026-10-14T10:41:00.000Z';
const publishedAt = '2026-10-14T10:45:00.000Z';
const key = {
  PK: `CLAIM#${claimId}`,
  SK: 'OUTBOX#2026-10-14T10:41:00.000Z#8f3d2c1e-5a7b-4c1d-9e2f-0a1b2c3d4e5f',
};

const event: OutboxEvent = {
  eventId: '8f3d2c1e-5a7b-4c1d-9e2f-0a1b2c3d4e5f',
  eventType: 'claim.submitted',
  schemaVersion: 1,
  occurredAt: at,
  source: eventSource,
  aggregate: {
    type: 'claim',
    id: claimId,
    version: 4,
    previousEventVersion: null,
  },
  correlationId: 'c0ffee00-1111-2222-3333-444455556666',
  causationId: 'request-7d3e',
  actorId: 'sub-aisha',
  payload: {
    claimId,
    employeeId: 'sub-aisha',
    assignedManagerId: 'sub-ben',
    categoryId: 'travel',
    amount: { amountMinor: 45_000, currency: 'MYR' },
    submittedAt: at,
  },
};

/** Records commands; answers GetItem from stored items, or fails as set. */
class FakeClient implements OutboxDocumentClient {
  public readonly commands: (GetCommand | UpdateCommand)[] = [];
  public readonly items = new Map<string, DynamoItem>();
  public failure: unknown;

  public put(item: DynamoItem): void {
    this.items.set(`${String(item.PK)}|${String(item.SK)}`, item);
  }

  public send(command: GetCommand): Promise<GetCommandOutput>;
  public send(command: UpdateCommand): Promise<UpdateCommandOutput>;
  public send(
    command: GetCommand | UpdateCommand,
  ): Promise<GetCommandOutput | UpdateCommandOutput> {
    this.commands.push(command);
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
    if (command instanceof GetCommand) {
      const item = this.items.get(
        `${String((command.input.Key as DynamoItem).PK)}|${String((command.input.Key as DynamoItem).SK)}`,
      );
      return Promise.resolve({
        $metadata: {},
        ...(item === undefined ? {} : { Item: item }),
      });
    }
    return Promise.resolve({ $metadata: {} });
  }
}

/** Applies the update's SET and REMOVE clauses to a stored item. */
function applyUpdate(stored: DynamoItem, command: UpdateCommand): DynamoItem {
  const names = command.input.ExpressionAttributeNames ?? {};
  const values = command.input.ExpressionAttributeValues ?? {};
  const [, setPart = '', removePart = ''] =
    /^SET (.*?) REMOVE (.*)$/.exec(command.input.UpdateExpression!) ?? [];
  const result = { ...stored };
  for (const assignment of setPart.split(', ')) {
    const [name, value] = assignment.split(' = ') as [string, string];
    result[names[name]!] = values[value];
  }
  for (const name of removePart.split(', ')) {
    delete result[names[name]!];
  }
  return result;
}

let client: FakeClient;
let state: DynamoDbOutboxState;

beforeEach(() => {
  client = new FakeClient();
  state = new DynamoDbOutboxState({ client, tableName });
});

async function errorOf(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  return undefined;
}

it('accepts the real DynamoDB document client', () => {
  expectTypeOf<DynamoDBDocumentClient>().toExtend<OutboxDocumentClient>();
});

describe('table name', () => {
  it.each<[string, unknown]>([
    ['an empty string', ''],
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['an object', { name: 'ClaimFlow' }],
  ])(
    'is rejected at construction when it is %s, before any command',
    (_name, tableName) => {
      const error = (() => {
        try {
          new DynamoDbOutboxState({ client, tableName: tableName as string });
        } catch (e) {
          return e;
        }
      })();

      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe('The table name is missing.');
      expect(client.commands).toEqual([]);
    },
  );

  it('is never echoed in the error message', () => {
    const error = (() => {
      try {
        new DynamoDbOutboxState({ client, tableName: 42 as unknown as string });
      } catch (e) {
        return e;
      }
    })();

    expect(String(error)).not.toContain('42');
  });

  it('accepts a non-empty name and then sends commands to it', async () => {
    await new DynamoDbOutboxState({ client, tableName: 'Other' }).get(event);

    expect((client.commands[0]!.input as { TableName: string }).TableName).toBe(
      'Other',
    );
  });
});

describe('get', () => {
  it('reads the derived key strongly consistently', async () => {
    await state.get(event);

    expect(client.commands).toHaveLength(1);
    expect(client.commands[0]).toBeInstanceOf(GetCommand);
    expect(client.commands[0]!.input).toEqual({
      TableName: 'ClaimFlow',
      Key: key,
      ConsistentRead: true,
    });
  });

  it('returns the decoded pending event', async () => {
    client.put(encodeOutboxItem(event));

    expect(await state.get(event)).toEqual({
      event,
      state: { state: 'PENDING' },
    });
  });

  it('returns the decoded published event and state', async () => {
    const published = publishedState(publishedAt);
    client.put(encodeOutboxItem(event, published));

    expect(await state.get(event)).toEqual({ event, state: published });
  });

  it('returns undefined for a missing item', async () => {
    expect(await state.get(event)).toBeUndefined();
  });

  it('uses the category partition for category events', async () => {
    const categoryEvent: OutboxEvent = {
      ...event,
      eventType: 'category.deactivated',
      aggregate: {
        type: 'category',
        id: 'travel',
        version: 3,
        previousEventVersion: 2,
      },
      payload: { categoryId: 'travel', version: 3 },
    };

    await state.get(categoryEvent);

    expect((client.commands[0]!.input as { Key: DynamoItem }).Key.PK).toBe(
      'CATEGORIES',
    );
  });

  it('decodes strictly and rejects a malformed stored item', async () => {
    client.put({ ...encodeOutboxItem(event), state: 'FAILED' });

    expect(await errorOf(() => state.get(event))).toBeInstanceOf(
      ItemIntegrityError,
    );
  });

  it('rejects a stored item with free text in its payload', async () => {
    const item = encodeOutboxItem(event);
    client.put({
      ...item,
      payload: { ...(item.payload as DynamoItem), merchant: 'Cafe' },
    });

    expect(await errorOf(() => state.get(event))).toBeInstanceOf(
      ItemIntegrityError,
    );
  });

  it('validates the event before sending anything', async () => {
    const invalid = { ...event, source: 'elsewhere' } as unknown as OutboxEvent;

    expect(await errorOf(() => state.get(invalid))).toBeInstanceOf(
      ItemEncodingError,
    );
    expect(client.commands).toEqual([]);
  });
});

describe('markPublished', () => {
  const expectedExpiry =
    toEpochSeconds(new Date(publishedAt)) + 7 * 24 * 60 * 60;

  it('sends one conditional UpdateItem with the exact expressions', async () => {
    await state.markPublished(event, publishedAt);

    expect(client.commands).toHaveLength(1);
    expect(client.commands[0]).toBeInstanceOf(UpdateCommand);
    expect(client.commands[0]!.input).toEqual({
      TableName: 'ClaimFlow',
      Key: key,
      UpdateExpression:
        'SET #state = :published, #publishedAt = :publishedAt, #expiresAt = :expiresAt REMOVE #GSI4PK, #GSI4SK',
      ConditionExpression: '#state = :pending',
      ExpressionAttributeNames: {
        '#state': 'state',
        '#publishedAt': 'publishedAt',
        '#expiresAt': 'expiresAt',
        '#GSI4PK': 'GSI4PK',
        '#GSI4SK': 'GSI4SK',
      },
      ExpressionAttributeValues: {
        ':published': 'PUBLISHED',
        ':pending': 'PENDING',
        ':publishedAt': publishedAt,
        ':expiresAt': expectedExpiry,
      },
    });
    expect(outboxPublishCondition).toBe('#state = :pending');
  });

  it('sets a TTL exactly seven days after publication', async () => {
    await state.markPublished(event, publishedAt);

    const values = (
      client.commands[0]!.input as { ExpressionAttributeValues: DynamoItem }
    ).ExpressionAttributeValues;
    expect(values[':expiresAt']).toBe(
      toEpochSeconds(new Date(publishedAt)) + 604_800,
    );
    expect(Number.isInteger(values[':expiresAt'])).toBe(true);
  });

  it('turns the stored pending item into exactly the encoded published item', async () => {
    await state.markPublished(event, publishedAt);

    const result = applyUpdate(
      encodeOutboxItem(event),
      client.commands[0] as UpdateCommand,
    );

    expect(result).toEqual(
      encodeOutboxItem(event, publishedState(publishedAt)),
    );
    expect(result).not.toHaveProperty('GSI4PK');
    expect(result).not.toHaveProperty('GSI4SK');
    expect(result.state).toBe('PUBLISHED');
  });

  it('accepts publication at the moment of occurrence', async () => {
    await expect(state.markPublished(event, at)).resolves.toBeUndefined();
  });

  it.each([
    ['a non-canonical time', '2026-10-14T10:45:00Z'],
    ['a date only', '2026-10-14'],
    ['an impossible time', '2026-02-30T00:00:00.000Z'],
    ['a time before the event', '2026-10-14T10:40:59.999Z'],
    ['text', 'now'],
    ['an empty string', ''],
  ])('rejects %s before sending anything', async (_name, time) => {
    const error = await errorOf(() => state.markPublished(event, time));

    expect(error).toBeInstanceOf(Error);
    expect(client.commands).toEqual([]);
  });

  it('rejects an invalid event before sending anything', async () => {
    const invalid = {
      ...event,
      eventType: 'claim.archived',
    } as unknown as OutboxEvent;

    expect(
      await errorOf(() => state.markPublished(invalid, publishedAt)),
    ).toBeInstanceOf(ItemEncodingError);
    expect(client.commands).toEqual([]);
  });
});

describe('SDK errors', () => {
  const conditional = Object.assign(
    new Error('The conditional request failed'),
    {
      name: 'ConditionalCheckFailedException',
    },
  );
  const throttled = Object.assign(new Error('Rate exceeded'), {
    name: 'ProvisionedThroughputExceededException',
  });

  it.each([conditional, throttled])(
    'propagates $name unchanged from markPublished',
    async (error) => {
      client.failure = error;

      expect(await errorOf(() => state.markPublished(event, publishedAt))).toBe(
        error,
      );
      expect(client.commands).toHaveLength(1);
    },
  );

  it('propagates read failures unchanged', async () => {
    client.failure = throttled;

    expect(await errorOf(() => state.get(event))).toBe(throttled);
    expect(client.commands).toHaveLength(1);
  });

  it('sends only GetItem and UpdateItem commands', async () => {
    client.put(encodeOutboxItem(event));
    await state.get(event);
    await state.markPublished(event, publishedAt);

    expect(client.commands.map((c) => c.constructor.name)).toEqual([
      'GetCommand',
      'UpdateCommand',
    ]);
  });
});
