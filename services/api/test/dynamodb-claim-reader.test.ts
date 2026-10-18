import {
  GetCommand,
  QueryCommand,
  type GetCommandOutput,
  type QueryCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import type { Category, Claim, ClaimHistoryEntry } from '@claimflow/domain';
import { describe, expect, it } from 'vitest';

import { DynamoDbClaimReader } from '../src/adapters/aws/dynamodb-claim-reader.js';
import {
  encodeCategoryItem,
  encodeClaimItem,
  encodeHistoryItem,
  ItemIntegrityError,
} from '../src/adapters/aws/dynamodb-items.js';
import * as readers from '../src/adapters/aws/dynamodb-readers.js';
import type { ReadDocumentClient } from '../src/adapters/aws/dynamodb-read-support.js';
import { encodeClaimCursor } from '../src/adapters/aws/dynamodb-cursor.js';

const tableName = 'ClaimFlow';
const time = (n: number) =>
  new Date(Date.parse('2026-10-01T00:00:00.000Z') + n * 60_000).toISOString();

const draft = (n: number): Claim => ({
  claimId: `claim-${String(n).padStart(3, '0')}`,
  employeeId: 'sub-aisha',
  status: 'DRAFT',
  version: 2,
  createdAt: time(0),
  updatedAt: time(n),
});
const submitted = (n: number): Claim => ({
  ...draft(n),
  status: 'SUBMITTED',
  assignedManagerId: 'sub-ben',
  submittedAt: time(100 - n),
});
const travel: Category = {
  categoryId: 'travel',
  name: 'Travel',
  active: true,
  currency: 'MYR',
  maxAmountMinor: 100_000,
  receiptRequiredAboveMinor: 10_000,
  version: 1,
  createdAt: time(0),
  updatedAt: time(0),
  updatedBy: 'sub-dan',
};
const entry = (version: number): ClaimHistoryEntry => ({
  claimId: 'claim-001',
  version,
  action: 'UPDATE',
  toStatus: 'DRAFT',
  actorId: 'sub-aisha',
  occurredAt: time(version),
});

type Response = Partial<GetCommandOutput> | Partial<QueryCommandOutput> | Error;

/** Answers each command with the next scripted response and records it. */
class ScriptedClient implements ReadDocumentClient {
  public readonly commands: (GetCommand | QueryCommand)[] = [];
  public constructor(private readonly responses: Response[] = []) {}

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

const readerOver = (...responses: Response[]) => {
  const client = new ScriptedClient(responses);
  return {
    client,
    reader: new DynamoDbClaimReader({ client, tableName }),
  };
};

describe('module layout', () => {
  it('is re-exported, not duplicated, by dynamodb-readers', () => {
    expect(readers.DynamoDbClaimReader).toBe(DynamoDbClaimReader);
  });
});

describe('construction', () => {
  it.each([undefined, null, {}, { send: 'send' }])(
    'rejects the client %j',
    (client) => {
      expect(
        () =>
          new DynamoDbClaimReader({
            client: client as unknown as ReadDocumentClient,
            tableName,
          }),
      ).toThrow(new TypeError('The DynamoDB client is missing.'));
    },
  );

  it.each(['', undefined, 7])('rejects the table name %j', (name) => {
    expect(
      () =>
        new DynamoDbClaimReader({
          client: new ScriptedClient(),
          tableName: name as unknown as string,
        }),
    ).toThrow(new TypeError('The table name is missing.'));
  });
});

describe('A1: claim by ID', () => {
  it('sends one strongly consistent GetItem and returns the domain claim', async () => {
    const { client, reader } = readerOver({
      Item: encodeClaimItem(draft(1), { lastEventVersion: 2 }),
    });

    expect(await reader.get('claim-001')).toEqual(draft(1));

    expect(client.commands).toHaveLength(1);
    expect(client.commands[0]).toBeInstanceOf(GetCommand);
    expect(client.commands[0]!.input).toEqual({
      TableName: 'ClaimFlow',
      Key: { PK: 'CLAIM#claim-001', SK: 'CLAIM' },
      ConsistentRead: true,
    });
  });

  it('returns undefined for a missing claim', async () => {
    const { reader } = readerOver({});
    expect(await reader.get('claim-404')).toBeUndefined();
  });

  it('rejects an item for a different claim with a fixed message', async () => {
    const { reader } = readerOver({ Item: encodeClaimItem(draft(2)) });
    const failure = await reader.get('claim-001').catch((error) => error);
    expect(failure).toBeInstanceOf(ItemIntegrityError);
    expect(String(failure)).not.toContain('claim-002');
  });

  it('rejects a malformed stored item with the codec error', async () => {
    const { reader } = readerOver({
      Item: { ...encodeClaimItem(draft(1)), version: 'two' },
    });
    await expect(reader.get('claim-001')).rejects.toBeInstanceOf(
      ItemIntegrityError,
    );
  });
});

describe('A5: is a category used?', () => {
  it('reads the category strongly consistently and checks claimCount', async () => {
    const used = readerOver({
      Item: encodeCategoryItem(travel, { claimCount: 2 }),
    });
    expect(await used.reader.existsForCategory('travel')).toBe(true);
    expect(used.client.commands[0]!.input).toEqual({
      TableName: 'ClaimFlow',
      Key: { PK: 'CATEGORIES', SK: 'CATEGORY#travel' },
      ConsistentRead: true,
    });

    const unused = readerOver({
      Item: encodeCategoryItem(travel, { claimCount: 0 }),
    });
    expect(await unused.reader.existsForCategory('travel')).toBe(false);
    expect(await readerOver({}).reader.existsForCategory('travel')).toBe(false);
  });

  it('rejects a malformed category item with the codec error', async () => {
    const { reader } = readerOver({
      Item: {
        ...encodeCategoryItem(travel, { claimCount: 0 }),
        claimCount: -1,
      },
    });
    await expect(reader.existsForCategory('travel')).rejects.toBeInstanceOf(
      ItemIntegrityError,
    );
  });
});

describe('claim list queries', () => {
  const claimQuery = (
    index: string,
    partition: string,
    ascending: boolean,
    extra: object = {},
  ) => ({
    TableName: 'ClaimFlow',
    IndexName: index,
    KeyConditionExpression: '#pk = :pk',
    ExpressionAttributeNames: { '#pk': `${index}PK` },
    ExpressionAttributeValues: { ':pk': partition },
    ScanIndexForward: ascending,
    ConsistentRead: false,
    Limit: 3,
    ...extra,
  });

  it.each([
    [
      'A6: GSI1, newest first',
      (r: DynamoDbClaimReader) => r.listByEmployee('sub-aisha', { limit: 2 }),
      claimQuery('GSI1', 'EMPLOYEE#sub-aisha', false),
    ],
    [
      'A7: GSI2, oldest first',
      (r: DynamoDbClaimReader) => r.listOpenForManager('sub-ben', { limit: 2 }),
      claimQuery('GSI2', 'MANAGER#sub-ben#OPEN', true),
    ],
    [
      'A8: GSI3, newest first',
      (r: DynamoDbClaimReader) => r.listByStatus('SUBMITTED', { limit: 2 }),
      claimQuery('GSI3', 'STATUS#SUBMITTED', false),
    ],
    [
      'A9: GSI4, newest first',
      (r: DynamoDbClaimReader) => r.listByStatus(undefined, { limit: 2 }),
      claimQuery('GSI4', 'CLAIM', false),
    ],
  ])('%s', async (_name, read, expected) => {
    const { client, reader } = readerOver({
      Items: [encodeClaimItem(submitted(1)), encodeClaimItem(submitted(2))],
    });

    const page = await read(reader);

    expect(page.items.map((c) => c.claimId)).toEqual([
      'claim-001',
      'claim-002',
    ]);
    expect(page).not.toHaveProperty('nextCursor');
    expect(client.commands).toHaveLength(1);
    expect(client.commands[0]).toBeInstanceOf(QueryCommand);
    expect(client.commands[0]!.input).toEqual(expected);
    expect(client.commands[0]!.input).not.toHaveProperty('FilterExpression');
  });

  it('asks for one item more, returns a cursor for the last returned item only', async () => {
    const { reader } = readerOver({
      Items: [1, 2, 3].map((n) => encodeClaimItem(submitted(n))),
      LastEvaluatedKey: { PK: 'x' },
    });

    const page = await reader.listByEmployee('sub-aisha', { limit: 2 });

    expect(page.items.map((c) => c.claimId)).toEqual([
      'claim-001',
      'claim-002',
    ]);
    expect(page.nextCursor).toBe(
      encodeClaimCursor(
        { list: 'employee', employeeId: 'sub-aisha' },
        submitted(2),
      ),
    );
  });

  it('continues through a partial response and sends the cursor as the start key', async () => {
    const key = { PK: 'CLAIM#claim-001', SK: 'CLAIM#claim-001' };
    const { client, reader } = readerOver(
      { Items: [encodeClaimItem(submitted(1))], LastEvaluatedKey: key },
      { Items: [encodeClaimItem(submitted(2)), encodeClaimItem(submitted(3))] },
    );

    const page = await reader.listByEmployee('sub-aisha', { limit: 2 });

    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeDefined();
    expect(client.commands.map((c) => (c as QueryCommand).input.Limit)).toEqual(
      [3, 2],
    );
    expect(
      (client.commands[1] as QueryCommand).input.ExclusiveStartKey,
    ).toEqual(key);
  });

  it('rejects a malformed stored claim with the codec error', async () => {
    const { reader } = readerOver({
      Items: [{ ...encodeClaimItem(submitted(1)), status: 'LOST' }],
    });
    await expect(
      reader.listByEmployee('sub-aisha', { limit: 2 }),
    ).rejects.toBeInstanceOf(ItemIntegrityError);
  });
});

describe('A10: claim history', () => {
  it('queries the base table strongly consistent, oldest first', async () => {
    const { client, reader } = readerOver({
      Items: [1, 2].map((v) => encodeHistoryItem(entry(v))),
    });

    const page = await reader.listHistory('claim-001', { limit: 5 });

    expect(page.items).toEqual([entry(1), entry(2)]);
    expect(client.commands[0]!.input).toEqual({
      TableName: 'ClaimFlow',
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :history)',
      ExpressionAttributeValues: {
        ':pk': 'CLAIM#claim-001',
        ':history': 'HISTORY#',
      },
      ScanIndexForward: true,
      ConsistentRead: true,
      Limit: 6,
    });
    expect(client.commands[0]!.input).not.toHaveProperty('IndexName');
  });

  it('rejects a malformed history item with the codec error', async () => {
    const { reader } = readerOver({
      Items: [{ ...encodeHistoryItem(entry(1)), version: 0 }],
    });
    await expect(
      reader.listHistory('claim-001', { limit: 5 }),
    ).rejects.toBeInstanceOf(ItemIntegrityError);
  });
});

describe('rejections before any command', () => {
  const badIds = ['', ' ', 'a b', '../x', 'x'.repeat(200), 7, undefined];

  it.each(badIds)('rejects the ID %j everywhere', async (id) => {
    const { client, reader } = readerOver();
    const value = id as unknown as string;
    const page = { limit: 2 };

    await expect(reader.get(value)).rejects.toThrow(
      new TypeError('The claim ID is not valid.'),
    );
    await expect(reader.existsForCategory(value)).rejects.toThrow(
      new TypeError('The category ID is not valid.'),
    );
    expect(() => reader.listByEmployee(value, page)).toThrow(
      new TypeError('The employee ID is not valid.'),
    );
    expect(() => reader.listOpenForManager(value, page)).toThrow(
      new TypeError('The manager ID is not valid.'),
    );
    expect(() => reader.listHistory(value, page)).toThrow(
      new TypeError('The claim ID is not valid.'),
    );
    expect(client.commands).toEqual([]);
  });

  it.each(['LOST', 'draft', null, 5, ''])('rejects the status %j', (status) => {
    const { client, reader } = readerOver();
    expect(() => reader.listByStatus(status as never, { limit: 2 })).toThrow(
      new TypeError('The claim status is not valid.'),
    );
    expect(client.commands).toEqual([]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '2', undefined])(
    'rejects the page limit %j',
    async (limit) => {
      const { client, reader } = readerOver();
      const page = { limit: limit as number };
      const reads = [
        () => reader.listByEmployee('sub-aisha', page),
        () => reader.listOpenForManager('sub-ben', page),
        () => reader.listByStatus('DRAFT', page),
        () => reader.listByStatus(undefined, page),
        () => reader.listHistory('claim-001', page),
      ];
      for (const read of reads) {
        await expect(read()).rejects.toThrow(
          new RangeError('The page limit must be a positive whole number.'),
        );
      }
      expect(client.commands).toEqual([]);
    },
  );

  it('rejects a missing page request', async () => {
    const { client, reader } = readerOver();
    await expect(
      reader.listByEmployee('sub-aisha', undefined as never),
    ).rejects.toThrow(new TypeError('The page request is missing.'));
    expect(client.commands).toEqual([]);
  });

  it('rejects malformed, oversized, and foreign cursors', async () => {
    const { client, reader } = readerOver();
    const foreign = encodeClaimCursor(
      { list: 'employee', employeeId: 'sub-other' },
      { ...submitted(1), employeeId: 'sub-other' },
    );
    for (const cursor of ['not-a-cursor', 'A'.repeat(513), '', foreign]) {
      await expect(
        reader.listByEmployee('sub-aisha', { limit: 2, cursor }),
      ).rejects.toBeInstanceOf(Error);
    }
    expect(client.commands).toEqual([]);
  });

  it('names no supplied value in a message', () => {
    const { reader } = readerOver();
    expect(() =>
      reader.listByEmployee('Secret Employee', { limit: 2 }),
    ).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('Secret'),
      }),
    );
  });
});

describe('errors and command types', () => {
  it('propagates SDK errors unchanged for every read', async () => {
    const failure = new Error('ThrottlingException');
    const page = { limit: 2 };
    const reads: ((r: DynamoDbClaimReader) => Promise<unknown>)[] = [
      (r) => r.get('claim-001'),
      (r) => r.existsForCategory('travel'),
      (r) => r.listByEmployee('sub-aisha', page),
      (r) => r.listOpenForManager('sub-ben', page),
      (r) => r.listByStatus('DRAFT', page),
      (r) => r.listByStatus(undefined, page),
      (r) => r.listHistory('claim-001', page),
    ];
    for (const read of reads) {
      const { reader } = readerOver(failure);
      await expect(read(reader)).rejects.toBe(failure);
    }
  });

  it('refuses a continuation key that makes no progress', async () => {
    const key = { PK: 'CLAIM#claim-001', SK: 'CLAIM#claim-001' };
    const { reader } = readerOver(
      { Items: [], LastEvaluatedKey: key },
      { Items: [], LastEvaluatedKey: { ...key } },
    );
    await expect(
      reader.listByEmployee('sub-aisha', { limit: 2 }),
    ).rejects.toThrow('DynamoDB returned the same LastEvaluatedKey twice.');
  });

  it('sends only GetItem and Query commands and has only read methods', async () => {
    const { client, reader } = readerOver();
    await reader.get('claim-001');
    await reader.existsForCategory('travel');
    await reader.listByEmployee('sub-aisha', { limit: 1 });
    await reader.listOpenForManager('sub-ben', { limit: 1 });
    await reader.listByStatus('DRAFT', { limit: 1 });
    await reader.listByStatus(undefined, { limit: 1 });
    await reader.listHistory('claim-001', { limit: 1 });

    expect(client.commands.map((c) => c.constructor.name)).toEqual([
      'GetCommand',
      'GetCommand',
      'QueryCommand',
      'QueryCommand',
      'QueryCommand',
      'QueryCommand',
      'QueryCommand',
    ]);
    expect(
      Object.getOwnPropertyNames(Object.getPrototypeOf(reader)).sort(),
    ).toEqual(
      [
        'claimPage',
        'constructor',
        'existsForCategory',
        'get',
        'listByEmployee',
        'listByStatus',
        'listHistory',
        'listOpenForManager',
      ].sort(),
    );
  });
});
