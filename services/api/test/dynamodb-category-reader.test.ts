import {
  GetCommand,
  QueryCommand,
  type GetCommandOutput,
  type QueryCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import type { Category } from '@claimflow/domain';
import { describe, expect, it } from 'vitest';

import { DynamoDbCategoryReader } from '../src/adapters/aws/dynamodb-category-reader.js';
import {
  encodeCategoryItem,
  encodeClaimItem,
  ItemIntegrityError,
  type DynamoItem,
} from '../src/adapters/aws/dynamodb-items.js';
import type { ReadDocumentClient } from '../src/adapters/aws/dynamodb-readers.js';

const tableName = 'ClaimFlow';
const time = '2026-01-01T00:00:00.000Z';

function category(id: string, overrides: Partial<Category> = {}): Category {
  return {
    categoryId: id,
    name: `Category ${id}`,
    active: true,
    currency: 'MYR',
    maxAmountMinor: 100_000,
    receiptRequiredAboveMinor: 10_000,
    version: 1,
    createdAt: time,
    updatedAt: time,
    updatedBy: 'sub-dan',
    ...overrides,
  };
}

const stored = (id: string): DynamoItem =>
  encodeCategoryItem(category(id), { claimCount: 0 });

/** Answers each command with the next scripted response and records it. */
class ScriptedClient implements ReadDocumentClient {
  public readonly commands: unknown[] = [];
  public constructor(
    private readonly responses: (
      Partial<GetCommandOutput> | Partial<QueryCommandOutput> | Error
    )[] = [],
  ) {}

  public send(command: GetCommand): Promise<GetCommandOutput>;
  public send(command: QueryCommand): Promise<QueryCommandOutput>;
  public send(
    command: GetCommand | QueryCommand,
  ): Promise<GetCommandOutput | QueryCommandOutput> {
    this.commands.push(command);
    const response = this.responses.shift() ?? {};
    return response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve({ $metadata: {}, ...response });
  }
}

const readerOver = (client: ReadDocumentClient) =>
  new DynamoDbCategoryReader({ client, tableName });

describe('construction', () => {
  it.each(['', undefined, 42, null])(
    'rejects the table name %j before any command',
    (name) => {
      const client = new ScriptedClient();
      expect(
        () =>
          new DynamoDbCategoryReader({
            client,
            tableName: name as unknown as string,
          }),
      ).toThrow(new TypeError('The table name is missing.'));
      expect(client.commands).toEqual([]);
    },
  );
});

describe('get', () => {
  it('sends one strongly consistent GetItem for the category key', async () => {
    const client = new ScriptedClient([{ Item: stored('travel') }]);

    expect(await readerOver(client).get('travel')).toEqual(category('travel'));

    expect(client.commands).toHaveLength(1);
    const command = client.commands[0] as GetCommand;
    expect(command).toBeInstanceOf(GetCommand);
    expect(command.input).toEqual({
      TableName: 'ClaimFlow',
      Key: { PK: 'CATEGORIES', SK: 'CATEGORY#travel' },
      ConsistentRead: true,
    });
  });

  it('returns undefined for a missing category', async () => {
    const client = new ScriptedClient([{}]);
    expect(await readerOver(client).get('missing')).toBeUndefined();
    expect(client.commands).toHaveLength(1);
  });

  it('returns the domain category without persistence metadata', async () => {
    const client = new ScriptedClient([
      {
        Item: encodeCategoryItem(category('travel'), {
          claimCount: 4,
          lastEventVersion: 1,
        }),
      },
    ]);
    const result = await readerOver(client).get('travel');
    expect(result).toEqual(category('travel'));
    expect(Object.keys(result!).sort()).toEqual(
      Object.keys(category('travel')).sort(),
    );
  });

  it.each([
    '',
    ' ',
    'a b',
    '../x',
    'CATEGORY#x',
    'x'.repeat(200),
    7,
    undefined,
  ])(
    'rejects the category ID %j before any command, naming no value',
    async (id) => {
      const client = new ScriptedClient();
      await expect(
        readerOver(client).get(id as unknown as string),
      ).rejects.toThrow(new TypeError('The category ID is not valid.'));
      expect(client.commands).toEqual([]);
    },
  );

  it('rejects a malformed stored item with the codec error', async () => {
    const client = new ScriptedClient([
      { Item: { ...stored('travel'), claimCount: -1 } },
    ]);
    await expect(readerOver(client).get('travel')).rejects.toBeInstanceOf(
      ItemIntegrityError,
    );
  });

  it('rejects an item stored under another key', async () => {
    const client = new ScriptedClient([{ Item: stored('meals') }]);
    await expect(readerOver(client).get('travel')).rejects.toBeInstanceOf(
      ItemIntegrityError,
    );
  });

  it('propagates SDK errors unchanged', async () => {
    const failure = new Error('ThrottlingException');
    const client = new ScriptedClient([failure]);
    await expect(readerOver(client).get('travel')).rejects.toBe(failure);
  });
});

describe('getStored', () => {
  const getInput = {
    TableName: 'ClaimFlow',
    Key: { PK: 'CATEGORIES', SK: 'CATEGORY#travel' },
    ConsistentRead: true,
  };

  it('returns the category with its claimCount and lastEventVersion from one strongly consistent read', async () => {
    const client = new ScriptedClient([
      {
        Item: encodeCategoryItem(category('travel'), {
          claimCount: 4,
          lastEventVersion: 1,
        }),
      },
    ]);

    expect(await readerOver(client).getStored('travel')).toEqual({
      category: category('travel'),
      metadata: { claimCount: 4, lastEventVersion: 1 },
    });

    expect(client.commands).toHaveLength(1);
    const command = client.commands[0] as GetCommand;
    expect(command).toBeInstanceOf(GetCommand);
    expect(command.input).toEqual(getInput);
  });

  it('keeps a lastEventVersion of zero distinct from an absent one', async () => {
    const zero = new ScriptedClient([
      {
        Item: encodeCategoryItem(category('travel'), {
          claimCount: 0,
          lastEventVersion: 0,
        }),
      },
    ]);
    const absent = new ScriptedClient([{ Item: stored('travel') }]);

    const withZero = await readerOver(zero).getStored('travel');
    const without = await readerOver(absent).getStored('travel');

    expect(withZero?.metadata).toEqual({ claimCount: 0, lastEventVersion: 0 });
    expect(without?.metadata).toEqual({ claimCount: 0 });
    expect(without?.metadata).not.toHaveProperty('lastEventVersion');
  });

  it('returns undefined for a missing category after one request', async () => {
    const client = new ScriptedClient([{}]);
    expect(await readerOver(client).getStored('missing')).toBeUndefined();
    expect(client.commands).toHaveLength(1);
  });

  it('is what get unwraps, with the same single request', async () => {
    const client = new ScriptedClient([
      {
        Item: encodeCategoryItem(category('travel'), {
          claimCount: 4,
          lastEventVersion: 1,
        }),
      },
    ]);

    const result = await readerOver(client).get('travel');

    expect(result).toEqual(category('travel'));
    expect(client.commands).toHaveLength(1);
    expect((client.commands[0] as GetCommand).input).toEqual(getInput);
  });

  it.each([
    ['a negative claimCount', { claimCount: -1 }],
    ['a fractional claimCount', { claimCount: 1.5 }],
    ['a negative lastEventVersion', { lastEventVersion: -1 }],
    ['a non-numeric lastEventVersion', { lastEventVersion: '1' }],
    ['an unexpected attribute', { extra: true }],
  ])('rejects %s with the codec error', async (_name, patch) => {
    const client = new ScriptedClient([
      { Item: { ...stored('travel'), ...patch } },
    ]);
    await expect(readerOver(client).getStored('travel')).rejects.toBeInstanceOf(
      ItemIntegrityError,
    );
  });

  it('rejects an item stored under another key, naming no other value', async () => {
    const client = new ScriptedClient([{ Item: stored('meals') }]);
    const failure = await readerOver(client)
      .getStored('travel')
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ItemIntegrityError);
    expect(String(failure)).not.toContain('meals');
  });

  it.each([
    '',
    ' ',
    'a b',
    '../x',
    'CATEGORY#x',
    'x'.repeat(200),
    7,
    undefined,
  ])('rejects the category ID %j before any command', async (id) => {
    const client = new ScriptedClient();
    await expect(
      readerOver(client).getStored(id as unknown as string),
    ).rejects.toThrow(new TypeError('The category ID is not valid.'));
    expect(client.commands).toEqual([]);
  });

  it('propagates SDK errors unchanged', async () => {
    const failure = new Error('ThrottlingException');
    const client = new ScriptedClient([failure]);
    await expect(readerOver(client).getStored('travel')).rejects.toBe(failure);
    expect(client.commands).toHaveLength(1);
  });
});

describe('list', () => {
  const baseQuery = {
    TableName: 'ClaimFlow',
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :category)',
    ExpressionAttributeValues: {
      ':pk': 'CATEGORIES',
      ':category': 'CATEGORY#',
    },
    ScanIndexForward: true,
    ConsistentRead: true,
  };

  it('queries the base table partition once when there is one page', async () => {
    const client = new ScriptedClient([
      { Items: [stored('meals'), stored('travel')] },
    ]);

    const list = await readerOver(client).list();

    expect(list).toEqual([category('meals'), category('travel')]);
    expect(client.commands).toHaveLength(1);
    const command = client.commands[0] as QueryCommand;
    expect(command).toBeInstanceOf(QueryCommand);
    expect(command.input).toEqual(baseQuery);
    expect(command.input).not.toHaveProperty('IndexName');
    expect(command.input).not.toHaveProperty('FilterExpression');
    expect(command.input).not.toHaveProperty('Limit');
  });

  it('follows every continuation key and keeps the order across pages', async () => {
    const client = new ScriptedClient([
      {
        Items: [stored('a'), stored('b')],
        LastEvaluatedKey: { PK: 'CATEGORIES', SK: 'CATEGORY#b' },
      },
      {
        Items: [],
        LastEvaluatedKey: { PK: 'CATEGORIES', SK: 'CATEGORY#b2' },
      },
      { Items: [stored('c'), stored('d')] },
    ]);

    const list = await readerOver(client).list();

    expect(list.map((c) => c.categoryId)).toEqual(['a', 'b', 'c', 'd']);
    const inputs = client.commands.map((c) => (c as QueryCommand).input);
    expect(inputs).toEqual([
      baseQuery,
      {
        ...baseQuery,
        ExclusiveStartKey: { PK: 'CATEGORIES', SK: 'CATEGORY#b' },
      },
      {
        ...baseQuery,
        ExclusiveStartKey: { PK: 'CATEGORIES', SK: 'CATEGORY#b2' },
      },
    ]);
  });

  it('returns an empty list when there are no categories', async () => {
    const client = new ScriptedClient([{}]);
    expect(await readerOver(client).list()).toEqual([]);
  });

  it('rejects a malformed item on any page with the codec error', async () => {
    const client = new ScriptedClient([
      {
        Items: [stored('a')],
        LastEvaluatedKey: { PK: 'CATEGORIES', SK: 'CATEGORY#a' },
      },
      { Items: [{ ...stored('b'), currency: 42 }] },
    ]);
    await expect(readerOver(client).list()).rejects.toBeInstanceOf(
      ItemIntegrityError,
    );
  });

  it('rejects an item that is not a category', async () => {
    const client = new ScriptedClient([
      {
        Items: [
          encodeClaimItem({
            claimId: 'claim-001',
            employeeId: 'sub-aisha',
            categoryId: 'travel',
            amountMinor: 1,
            currency: 'MYR',
            expenseDate: '2026-01-01',
            merchant: 'x',
            businessPurpose: 'y',
            status: 'DRAFT',
            version: 1,
            createdAt: time,
            updatedAt: time,
          } as never),
        ],
      },
    ]);
    await expect(readerOver(client).list()).rejects.toThrow();
  });

  it('refuses a continuation key that makes no progress', async () => {
    const key = { PK: 'CATEGORIES', SK: 'CATEGORY#a' };
    const client = new ScriptedClient([
      { Items: [stored('a')], LastEvaluatedKey: key },
      { Items: [], LastEvaluatedKey: { ...key } },
    ]);
    await expect(readerOver(client).list()).rejects.toThrow(
      new Error('The category query did not make progress.'),
    );
    expect(client.commands).toHaveLength(2);
  });

  it('propagates SDK errors unchanged, even after a first page', async () => {
    const failure = new Error('ProvisionedThroughputExceededException');
    const client = new ScriptedClient([
      {
        Items: [stored('a')],
        LastEvaluatedKey: { PK: 'CATEGORIES', SK: 'CATEGORY#a' },
      },
      failure,
    ]);
    await expect(readerOver(client).list()).rejects.toBe(failure);
  });
});

it('sends only GetItem and Query commands', async () => {
  const client = new ScriptedClient([
    { Item: stored('travel') },
    { Item: stored('travel') },
    {
      Items: [stored('a')],
      LastEvaluatedKey: { PK: 'CATEGORIES', SK: 'CATEGORY#a' },
    },
    { Items: [stored('b')] },
  ]);
  const reader = readerOver(client);

  await reader.get('travel');
  await reader.getStored('travel');
  await reader.list();

  expect(client.commands.map((c) => (c as object).constructor.name)).toEqual([
    'GetCommand',
    'GetCommand',
    'QueryCommand',
    'QueryCommand',
  ]);
});

it('exposes no write methods', () => {
  const reader = readerOver(new ScriptedClient());
  expect(
    Object.getOwnPropertyNames(Object.getPrototypeOf(reader)).sort(),
  ).toEqual(['constructor', 'get', 'getStored', 'list']);
});
