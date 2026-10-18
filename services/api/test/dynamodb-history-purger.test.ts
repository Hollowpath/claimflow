/* eslint-disable @typescript-eslint/prefer-promise-reject-errors -- the fake rejects with scripted values, which may not be Errors */
import {
  BatchWriteCommand,
  QueryCommand,
  type BatchWriteCommandOutput,
  type DynamoDBDocumentClient,
  type QueryCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import { beforeEach, describe, expect, expectTypeOf, it } from 'vitest';

import {
  DynamoDbHistoryPurger,
  HistoryPurgeError,
  maxBatchDeletes,
  type HistoryPurgeClient,
} from '../src/adapters/aws/dynamodb-history-purger.js';

const tableName = 'ClaimFlow';
const claimId = '4ce0c74b-9c64-46d6-87ba-07fb71b0628c';
const partition = `CLAIM#${claimId}`;
const historyKey = (version: number) => ({
  PK: partition,
  SK: `HISTORY#${String(version).padStart(10, '0')}`,
});

type Key = Record<string, unknown>;

/**
 * An in-memory partition. Queries page by `pageSize`, optionally starting with
 * an empty page that still has a continuation key; batch writes delete up to
 * 25 keys, leaving the planned number unprocessed per call.
 */
class FakeTable implements HistoryPurgeClient {
  public readonly commands: (QueryCommand | BatchWriteCommand)[] = [];
  public items: Key[] = [];
  public pageSize = Number.POSITIVE_INFINITY;
  public emptyFirstPage = false;
  public unprocessedPlan: number[] = [];
  public queryFailure: unknown;
  public writeFailure: unknown;
  private emptyServed = false;

  public seed(count: number): void {
    this.items = Array.from({ length: count }, (_, i) => historyKey(i + 1));
  }

  public send(command: QueryCommand): Promise<QueryCommandOutput>;
  public send(command: BatchWriteCommand): Promise<BatchWriteCommandOutput>;
  public send(
    command: QueryCommand | BatchWriteCommand,
  ): Promise<QueryCommandOutput | BatchWriteCommandOutput> {
    this.commands.push(command);
    if (command instanceof QueryCommand) {
      return this.queryFailure === undefined
        ? Promise.resolve(this.query(command))
        : Promise.reject(this.queryFailure);
    }
    return this.writeFailure === undefined
      ? Promise.resolve(this.write(command))
      : Promise.reject(this.writeFailure);
  }

  public queries(): QueryCommand[] {
    return this.commands.filter((c) => c instanceof QueryCommand);
  }

  public writes(): BatchWriteCommand[] {
    return this.commands.filter((c) => c instanceof BatchWriteCommand);
  }

  private query(command: QueryCommand): QueryCommandOutput {
    const start = command.input.ExclusiveStartKey as Key | undefined;
    if (this.emptyFirstPage && !this.emptyServed) {
      this.emptyServed = true;
      return {
        $metadata: {},
        Items: [],
        LastEvaluatedKey: { PK: partition, SK: 'HISTORY#0000000000' },
      };
    }
    const sorted = this.items
      .filter(
        (item) =>
          item.PK === partition && String(item.SK).startsWith('HISTORY#'),
      )
      .sort((a, b) => String(a.SK).localeCompare(String(b.SK)))
      .filter(
        (item) => start === undefined || String(item.SK) > String(start.SK),
      );
    const page = sorted.slice(0, this.pageSize);
    const more = sorted.length > page.length;
    return {
      $metadata: {},
      Items: page.map((item) => ({ PK: item.PK, SK: item.SK })),
      ...(more ? { LastEvaluatedKey: { ...page.at(-1)! } } : {}),
    };
  }

  private write(command: BatchWriteCommand): BatchWriteCommandOutput {
    const requests = command.input.RequestItems![tableName]!;
    if (requests.length > maxBatchDeletes) {
      throw new Error('batch too large');
    }
    const left = Math.min(this.unprocessedPlan.shift() ?? 0, requests.length);
    const processed = requests.slice(left);
    const gone = new Set(
      processed.map((r) => String(r.DeleteRequest!.Key!.SK)),
    );
    this.items = this.items.filter((item) => !gone.has(String(item.SK)));
    return {
      $metadata: {},
      ...(left === 0
        ? {}
        : { UnprocessedItems: { [tableName]: requests.slice(0, left) } }),
    };
  }
}

let table: FakeTable;
let sleeps: number[];
let purger: DynamoDbHistoryPurger;

beforeEach(() => {
  table = new FakeTable();
  sleeps = [];
  purger = new DynamoDbHistoryPurger({
    client: table,
    tableName,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
});

async function errorOf(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  return undefined;
}

const batchSizes = () =>
  table.writes().map((c) => c.input.RequestItems![tableName]!.length);

it('accepts the real DynamoDB document client', () => {
  expectTypeOf<DynamoDBDocumentClient>().toExtend<HistoryPurgeClient>();
});

describe('querying', () => {
  it('queries the claim partition for history keys only, ascending, with no scan, filter, or index', async () => {
    table.seed(2);

    await purger.purge(claimId);

    expect(table.queries()[0]!.input).toEqual({
      TableName: 'ClaimFlow',
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :history)',
      ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
      ExpressionAttributeValues: { ':pk': partition, ':history': 'HISTORY#' },
      ProjectionExpression: '#pk, #sk',
      ScanIndexForward: true,
      ConsistentRead: true,
    });
    for (const query of table.queries()) {
      expect(query.input).not.toHaveProperty('FilterExpression');
      expect(query.input).not.toHaveProperty('IndexName');
    }
  });

  it('follows every page until no continuation key remains', async () => {
    table.seed(7);
    table.pageSize = 3;

    await purger.purge(claimId);

    expect(table.queries()).toHaveLength(3);
    expect(table.queries().map((q) => q.input.ExclusiveStartKey)).toEqual([
      undefined,
      historyKey(3),
      historyKey(6),
    ]);
    expect(table.items).toEqual([]);
  });

  it('continues past an empty page that has a continuation key', async () => {
    table.seed(2);
    table.emptyFirstPage = true;

    await purger.purge(claimId);

    expect(table.queries()).toHaveLength(2);
    expect(table.items).toEqual([]);
  });

  it('refuses a continuation key that repeats the previous one', async () => {
    const stuck = new (class extends FakeTable {
      public override send(command: QueryCommand): Promise<QueryCommandOutput>;
      public override send(
        command: BatchWriteCommand,
      ): Promise<BatchWriteCommandOutput>;
      public override send(command: QueryCommand | BatchWriteCommand) {
        if (command instanceof QueryCommand) {
          this.commands.push(command);
          return Promise.resolve({
            $metadata: {},
            Items: [],
            LastEvaluatedKey: { PK: partition, SK: 'HISTORY#0000000001' },
          } as QueryCommandOutput);
        }
        return super.send(command);
      }
    })();

    const error = await errorOf(() =>
      new DynamoDbHistoryPurger({ client: stuck, tableName }).purge(claimId),
    );

    expect(error).toBeInstanceOf(HistoryPurgeError);
    expect(stuck.queries()).toHaveLength(2);
  });
});

describe('deleting', () => {
  it('succeeds without writing when there is no history', async () => {
    await expect(purger.purge(claimId)).resolves.toBeUndefined();

    expect(table.writes()).toEqual([]);
    expect(table.queries()).toHaveLength(1);
  });

  it('deletes a single entry with an exact request', async () => {
    table.seed(1);

    await purger.purge(claimId);

    expect(table.writes()).toHaveLength(1);
    expect(table.writes()[0]!.input).toEqual({
      RequestItems: {
        ClaimFlow: [{ DeleteRequest: { Key: historyKey(1) } }],
      },
    });
  });

  it.each([
    [25, [25]],
    [26, [25, 1]],
    [50, [25, 25]],
    [60, [25, 25, 10]],
  ])('splits %s entries into batches %j', async (count, sizes) => {
    table.seed(count);

    await purger.purge(claimId);

    expect(batchSizes()).toEqual(sizes);
    expect(table.items).toEqual([]);
  });

  it('batches within each page', async () => {
    table.seed(30);
    table.pageSize = 12;

    await purger.purge(claimId);

    expect(batchSizes()).toEqual([12, 12, 6]);
  });

  it('writes only keys, never other attributes', async () => {
    table.seed(2);

    await purger.purge(claimId);

    for (const write of table.writes()) {
      for (const request of write.input.RequestItems![tableName]!) {
        expect(Object.keys(request)).toEqual(['DeleteRequest']);
        expect(Object.keys(request.DeleteRequest!.Key!).sort()).toEqual([
          'PK',
          'SK',
        ]);
      }
    }
  });

  it('is idempotent: purging again, or after items vanished, succeeds', async () => {
    table.seed(3);

    await purger.purge(claimId);
    await expect(purger.purge(claimId)).resolves.toBeUndefined();
    await expect(purger.purge(claimId)).resolves.toBeUndefined();
    expect(table.items).toEqual([]);
  });

  it('accepts the ten-digit boundary history keys', async () => {
    table.items = [
      { PK: partition, SK: 'HISTORY#0000000001' },
      { PK: partition, SK: 'HISTORY#9999999999' },
    ];

    await purger.purge(claimId);

    expect(table.items).toEqual([]);
  });
});

describe('returned keys', () => {
  const returning = (items: Key[]) => {
    table.send = (command: QueryCommand | BatchWriteCommand) => {
      table.commands.push(command);
      return Promise.resolve(
        command instanceof QueryCommand
          ? { $metadata: {}, Items: items }
          : { $metadata: {} },
      );
    };
  };

  it.each<[string, Key]>([
    [
      'another claim partition',
      { PK: 'CLAIM#other', SK: 'HISTORY#0000000001' },
    ],
    ['the category partition', { PK: 'CATEGORIES', SK: 'HISTORY#0000000001' }],
    ['a claim item', { PK: partition, SK: 'CLAIM' }],
    [
      'an outbox item',
      { PK: partition, SK: 'OUTBOX#2026-10-14T10:41:00.000Z#e' },
    ],
    ['an unpadded version', { PK: partition, SK: 'HISTORY#1' }],
    ['a nine-digit version', { PK: partition, SK: 'HISTORY#000000001' }],
    ['an eleven-digit version', { PK: partition, SK: 'HISTORY#00000000001' }],
    ['a trailing suffix', { PK: partition, SK: 'HISTORY#0000000001x' }],
    ['non-digit characters', { PK: partition, SK: 'HISTORY#00000000a1' }],
    ['a missing sort key', { PK: partition }],
    ['a numeric sort key', { PK: partition, SK: 1 }],
    [
      'extra attributes',
      { PK: partition, SK: 'HISTORY#0000000001', version: 1 },
    ],
  ])(
    'fails safely on %s, deleting nothing from that page',
    async (_name, bad) => {
      returning([historyKey(1), bad, historyKey(3)]);

      const error = await errorOf(() => purger.purge(claimId));

      expect(error).toBeInstanceOf(HistoryPurgeError);
      expect(table.writes()).toEqual([]);
    },
  );

  it('never echoes keys, the claim ID, or the table name', async () => {
    returning([{ PK: 'CLAIM#Salary review', SK: 'HISTORY#x' }]);

    const error = await errorOf(() => purger.purge(claimId));

    for (const value of ['Salary', 'HISTORY', claimId, tableName]) {
      expect(String(error)).not.toContain(value);
    }
  });
});

describe('unprocessed items', () => {
  it('resends only the unprocessed requests', async () => {
    table.seed(5);
    table.unprocessedPlan = [3, 1];

    await purger.purge(claimId);

    expect(batchSizes()).toEqual([5, 3, 1]);
    expect(
      table
        .writes()[1]!
        .input.RequestItems![tableName]!.map((r) => r.DeleteRequest!.Key!.SK),
    ).toEqual([historyKey(1).SK, historyKey(2).SK, historyKey(3).SK]);
    expect(table.items).toEqual([]);
  });

  it('backs off exponentially, capped, between retries', async () => {
    table.seed(1);
    table.unprocessedPlan = [1, 1, 1, 1, 1];

    await purger.purge(claimId);

    expect(sleeps).toEqual([50, 100, 200, 400, 800]);
  });

  it('caps the delay and honours custom settings', async () => {
    table.seed(1);
    table.unprocessedPlan = [1, 1, 1];
    const custom = new DynamoDbHistoryPurger({
      client: table,
      tableName,
      maxAttempts: 4,
      baseDelayMs: 300,
      maxDelayMs: 500,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });

    await custom.purge(claimId);

    expect(sleeps).toEqual([300, 500, 500]);
  });

  it('throws the fixed error after the attempt limit', async () => {
    table.seed(2);
    table.unprocessedPlan = Array.from({ length: 10 }, () => 1);

    const error = await errorOf(() => purger.purge(claimId));

    expect(error).toBeInstanceOf(HistoryPurgeError);
    expect((error as Error).message).toBe(
      'Some history items were still unprocessed after the last attempt.',
    );
    expect(table.writes()).toHaveLength(6);
    expect(sleeps).toEqual([50, 100, 200, 400, 800]);
  });
});

describe('SDK errors and validation', () => {
  const failure = Object.assign(new Error('Rate exceeded'), {
    name: 'ProvisionedThroughputExceededException',
  });

  it('propagates query errors unchanged, writing nothing', async () => {
    table.queryFailure = failure;

    expect(await errorOf(() => purger.purge(claimId))).toBe(failure);
    expect(table.writes()).toEqual([]);
  });

  it('propagates write errors unchanged, without a retry', async () => {
    table.seed(2);
    table.writeFailure = failure;

    expect(await errorOf(() => purger.purge(claimId))).toBe(failure);
    expect(table.writes()).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it.each(['', undefined, null, 42] as unknown[])(
    'rejects table name %j before any command',
    (name) => {
      expect(
        () =>
          new DynamoDbHistoryPurger({
            client: table,
            tableName: name as string,
          }),
      ).toThrow('The table name is missing.');
      expect(table.commands).toEqual([]);
    },
  );

  it.each(['', 'claim #1', 'a/b', '../c', 'x'.repeat(65), 'CLAIM#c'])(
    'rejects claim ID %j before any command',
    async (id) => {
      const error = await errorOf(() => purger.purge(id));

      expect(error).toBeInstanceOf(TypeError);
      expect(String(error)).not.toContain(id === '' ? '\u0000' : id);
      expect(table.commands).toEqual([]);
    },
  );

  it('sends only Query and BatchWriteItem commands', async () => {
    table.seed(30);
    table.pageSize = 10;

    await purger.purge(claimId);

    expect(new Set(table.commands.map((c) => c.constructor.name))).toEqual(
      new Set(['QueryCommand', 'BatchWriteCommand']),
    );
  });
});
