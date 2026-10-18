import {
  GetCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
  type GetCommandOutput,
  type QueryCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import type {
  Category,
  Claim,
  ClaimHistoryEntry,
  ClaimStatus,
} from '@claimflow/domain';
import { beforeEach, describe, expect, expectTypeOf, it } from 'vitest';

import { decodeCursor } from '../src/adapters/aws/dynamodb-cursor.js';
import {
  encodeCategoryItem,
  encodeClaimItem,
  encodeHistoryItem,
  ItemIntegrityError,
  type DynamoItem,
} from '../src/adapters/aws/dynamodb-items.js';
import {
  DynamoDbCategoryReader,
  DynamoDbClaimReader,
  type ReadDocumentClient,
} from '../src/adapters/aws/dynamodb-readers.js';
import { ValidationError } from '../src/application/errors.js';
import type {
  CategoryRepository,
  ClaimRepository,
} from '../src/application/ports.js';

const tableName = 'ClaimFlow';
type Key = Record<string, unknown>;

/**
 * An in-memory ClaimFlow table that answers `GetItem` and `Query` as DynamoDB
 * does: key order, `Limit`, `ExclusiveStartKey`, and a `LastEvaluatedKey`
 * whenever a response stops early, including when `Limit` is reached exactly.
 * `responseCap` limits items per response, like the 1 MB response limit.
 */
class FakeTable implements ReadDocumentClient {
  public readonly commands: (GetCommand | QueryCommand)[] = [];
  public readonly items: DynamoItem[] = [];
  public responseCap = Number.POSITIVE_INFINITY;

  public send(command: GetCommand): Promise<GetCommandOutput>;
  public send(command: QueryCommand): Promise<QueryCommandOutput>;
  public send(
    command: GetCommand | QueryCommand,
  ): Promise<GetCommandOutput | QueryCommandOutput> {
    this.commands.push(command);
    if (command instanceof GetCommand) {
      const key = command.input.Key as Key;
      const item = this.items.find(
        (candidate) => candidate.PK === key.PK && candidate.SK === key.SK,
      );
      return Promise.resolve({
        $metadata: {},
        ...(item === undefined ? {} : { Item: item }),
      });
    }
    if (command instanceof QueryCommand) {
      return Promise.resolve(this.query(command));
    }
    return Promise.reject(new Error('Unexpected command.'));
  }

  public queries(): QueryCommand[] {
    return this.commands.filter((c) => c instanceof QueryCommand);
  }

  private query(command: QueryCommand): QueryCommandOutput {
    const input = command.input;
    const index = input.IndexName;
    if (index !== undefined && input.ConsistentRead === true) {
      throw new Error('Strongly consistent reads are not supported on GSIs.');
    }
    if ('FilterExpression' in input || 'ScanFilter' in input) {
      throw new Error('Filters are not expected.');
    }
    const partitionAttribute = index === undefined ? 'PK' : `${index}PK`;
    const sortAttribute = index === undefined ? 'SK' : `${index}SK`;
    const values = input.ExpressionAttributeValues ?? {};
    const prefix = (values[':history'] ?? values[':category']) as
      string | undefined;

    const order = (item: Key) =>
      [item[sortAttribute], item.PK, item.SK].map(String);
    const compare = (a: Key, b: Key) => {
      const [x, y] = [order(a), order(b)];
      for (let i = 0; i < x.length; i += 1) {
        if (x[i]! !== y[i]!) {
          return x[i]! < y[i]! ? -1 : 1;
        }
      }
      return 0;
    };
    const forward = input.ScanIndexForward !== false;
    let matches = this.items
      .filter(
        (item) =>
          item[partitionAttribute] === values[':pk'] &&
          (prefix === undefined ||
            String(item[sortAttribute]).startsWith(prefix)),
      )
      .sort((a, b) => (forward ? compare(a, b) : compare(b, a)));
    const start = input.ExclusiveStartKey;
    if (start !== undefined) {
      matches = matches.filter((item) =>
        forward ? compare(item, start) > 0 : compare(item, start) < 0,
      );
    }

    const limit = Math.min(
      input.Limit ?? Number.POSITIVE_INFINITY,
      this.responseCap,
    );
    const returned = matches.slice(0, limit);
    const last = returned.at(-1);
    const stoppedEarly =
      last !== undefined &&
      (returned.length === input.Limit || matches.length > returned.length);
    return {
      $metadata: {},
      Items: returned,
      Count: returned.length,
      ...(stoppedEarly
        ? {
            LastEvaluatedKey: Object.fromEntries(
              [...new Set(['PK', 'SK', partitionAttribute, sortAttribute])].map(
                (name) => [name, last[name]],
              ),
            ),
          }
        : {}),
    };
  }
}

const minute = 60_000;
const time = (n: number) =>
  new Date(Date.parse('2026-10-01T00:00:00.000Z') + n * minute).toISOString();

/** A claim whose activity time grows with `n`. */
function claim(
  n: number,
  overrides: Partial<Claim> & { status?: ClaimStatus } = {},
): Claim {
  const status = overrides.status ?? 'DRAFT';
  const open = status === 'SUBMITTED' || status === 'UNDER_REVIEW';
  return {
    claimId: `claim-${String(n).padStart(3, '0')}`,
    employeeId: 'sub-aisha',
    status,
    version: 2,
    createdAt: time(0),
    updatedAt: time(n),
    ...(open || status !== 'DRAFT'
      ? { assignedManagerId: 'sub-ben', submittedAt: time(100 - n) }
      : {}),
    ...(['APPROVED', 'REJECTED', 'PAID'].includes(status)
      ? { reviewedAt: time(n) }
      : {}),
    ...overrides,
  };
}

function category(id: string, overrides: Partial<Category> = {}): Category {
  return {
    categoryId: id,
    name: `Category ${id}`,
    active: true,
    currency: 'MYR',
    maxAmountMinor: 100_000,
    receiptRequiredAboveMinor: 10_000,
    version: 1,
    createdAt: time(0),
    updatedAt: time(0),
    updatedBy: 'sub-dan',
    ...overrides,
  };
}

function entry(claimId: string, version: number): ClaimHistoryEntry {
  return {
    claimId,
    version,
    action: version === 1 ? 'CREATE' : 'UPDATE',
    toStatus: 'DRAFT',
    actorId: 'sub-aisha',
    occurredAt: time(version),
  };
}

let table: FakeTable;
let claims: DynamoDbClaimReader;
let categories: DynamoDbCategoryReader;

beforeEach(() => {
  table = new FakeTable();
  claims = new DynamoDbClaimReader({ client: table, tableName });
  categories = new DynamoDbCategoryReader({ client: table, tableName });
});

const store = (...items: DynamoItem[]) => table.items.push(...items);
const storeClaims = (...list: Claim[]) =>
  store(...list.map((c) => encodeClaimItem(c)));
const ids = (page: { items: readonly { claimId: string }[] }) =>
  page.items.map((c) => c.claimId);

/** Every page of a list, following its cursors. */
async function allPages<T>(
  read: (cursor: string | undefined) => Promise<{
    items: readonly T[];
    nextCursor?: string;
  }>,
): Promise<{ pages: (readonly T[])[]; cursors: string[] }> {
  const pages: (readonly T[])[] = [];
  const cursors: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await read(cursor);
    pages.push(page.items);
    cursor = page.nextCursor;
    if (cursor !== undefined) {
      cursors.push(cursor);
    }
  } while (cursor !== undefined);
  return { pages, cursors };
}

describe('types', () => {
  it('match the repository read methods and the real document client', () => {
    expectTypeOf<DynamoDbClaimReader['listByEmployee']>().toEqualTypeOf<
      ClaimRepository['listByEmployee']
    >();
    expectTypeOf<DynamoDbClaimReader['listByStatus']>().toEqualTypeOf<
      ClaimRepository['listByStatus']
    >();
    expectTypeOf<DynamoDbClaimReader['listHistory']>().toEqualTypeOf<
      ClaimRepository['listHistory']
    >();
    expectTypeOf<DynamoDbCategoryReader['list']>().toEqualTypeOf<
      CategoryRepository['list']
    >();
    expectTypeOf<DynamoDBDocumentClient>().toExtend<ReadDocumentClient>();
  });
});

describe('A1: claim by ID', () => {
  it('reads the claim key strongly consistently and decodes it', async () => {
    const stored = claim(1, { status: 'SUBMITTED', merchant: 'City Taxi' });
    storeClaims(stored);

    const found = await claims.get(stored.claimId);

    expect(table.commands).toHaveLength(1);
    expect(table.commands[0]).toBeInstanceOf(GetCommand);
    expect(table.commands[0]!.input).toEqual({
      TableName: 'ClaimFlow',
      Key: { PK: 'CLAIM#claim-001', SK: 'CLAIM' },
      ConsistentRead: true,
    });
    expect(found).toEqual(stored);
  });

  it('returns undefined for a missing claim', async () => {
    expect(await claims.get('claim-404')).toBeUndefined();
  });

  it('rejects a malformed stored claim through the codec', async () => {
    store({ ...encodeClaimItem(claim(1)), status: 'LOST' });

    await expect(claims.get('claim-001')).rejects.toBeInstanceOf(
      ItemIntegrityError,
    );
  });
});

describe('A5: is a category used?', () => {
  it.each([
    [3, true],
    [0, false],
  ])(
    'reads claimCount %s strongly consistently',
    async (claimCount, expected) => {
      store(encodeCategoryItem(category('travel'), { claimCount }));

      expect(await claims.existsForCategory('travel')).toBe(expected);
      expect(table.commands[0]!.input).toEqual({
        TableName: 'ClaimFlow',
        Key: { PK: 'CATEGORIES', SK: 'CATEGORY#travel' },
        ConsistentRead: true,
      });
    },
  );

  it('treats a missing category as unused', async () => {
    expect(await claims.existsForCategory('gone')).toBe(false);
  });
});

describe('claim lists', () => {
  it('A6: queries GSI1 for one employee, newest first', async () => {
    storeClaims(
      claim(1),
      claim(3),
      claim(2),
      claim(4, { employeeId: 'sub-ravi' }),
    );

    const page = await claims.listByEmployee('sub-aisha', { limit: 10 });

    expect(table.queries()[0]!.input).toEqual({
      TableName: 'ClaimFlow',
      IndexName: 'GSI1',
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'GSI1PK' },
      ExpressionAttributeValues: { ':pk': 'EMPLOYEE#sub-aisha' },
      ScanIndexForward: false,
      ConsistentRead: false,
      Limit: 11,
    });
    expect(ids(page)).toEqual(['claim-003', 'claim-002', 'claim-001']);
    expect(page).not.toHaveProperty('nextCursor');
  });

  it("A7: queries GSI2 for a manager's open claims, oldest submission first", async () => {
    storeClaims(
      claim(1, { status: 'SUBMITTED' }),
      claim(2, { status: 'UNDER_REVIEW' }),
      claim(3, { status: 'APPROVED' }),
      claim(4, { status: 'SUBMITTED', assignedManagerId: 'sub-chloe' }),
    );

    const page = await claims.listOpenForManager('sub-ben', { limit: 5 });

    expect(table.queries()[0]!.input).toMatchObject({
      IndexName: 'GSI2',
      ExpressionAttributeNames: { '#pk': 'GSI2PK' },
      ExpressionAttributeValues: { ':pk': 'MANAGER#sub-ben#OPEN' },
      ScanIndexForward: true,
      ConsistentRead: false,
      Limit: 6,
    });
    // submittedAt is later for smaller n, so claim-002 was submitted first.
    expect(ids(page)).toEqual(['claim-002', 'claim-001']);
  });

  it('A8: queries GSI3 for one status, newest first', async () => {
    storeClaims(
      claim(1, { status: 'APPROVED' }),
      claim(2, { status: 'PAID' }),
      claim(3, { status: 'APPROVED' }),
    );

    const page = await claims.listByStatus('APPROVED', { limit: 5 });

    expect(table.queries()[0]!.input).toMatchObject({
      IndexName: 'GSI3',
      ExpressionAttributeNames: { '#pk': 'GSI3PK' },
      ExpressionAttributeValues: { ':pk': 'STATUS#APPROVED' },
      ScanIndexForward: false,
      ConsistentRead: false,
    });
    expect(ids(page)).toEqual(['claim-003', 'claim-001']);
  });

  it('A9: queries GSI4 for every claim, newest first', async () => {
    storeClaims(
      claim(1, { status: 'APPROVED' }),
      claim(2),
      claim(3, { employeeId: 'sub-ravi', status: 'SUBMITTED' }),
    );

    const page = await claims.listByStatus(undefined, { limit: 5 });

    expect(table.queries()[0]!.input).toMatchObject({
      IndexName: 'GSI4',
      ExpressionAttributeNames: { '#pk': 'GSI4PK' },
      ExpressionAttributeValues: { ':pk': 'CLAIM' },
      ScanIndexForward: false,
    });
    expect(ids(page)).toEqual(['claim-003', 'claim-002', 'claim-001']);
  });
});

describe('A10: claim history', () => {
  it('queries the claim partition strongly consistently in version order', async () => {
    store(
      ...[12, 1, 9, 10, 2].map((v) => encodeHistoryItem(entry('claim-001', v))),
      encodeHistoryItem(entry('claim-002', 3)),
      encodeClaimItem(claim(1)),
    );

    const page = await claims.listHistory('claim-001', { limit: 10 });

    expect(table.queries()[0]!.input).toEqual({
      TableName: 'ClaimFlow',
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :history)',
      ExpressionAttributeValues: {
        ':pk': 'CLAIM#claim-001',
        ':history': 'HISTORY#',
      },
      ScanIndexForward: true,
      ConsistentRead: true,
      Limit: 11,
    });
    expect(page.items.map((e) => e.version)).toEqual([1, 2, 9, 10, 12]);
  });

  it('pages through history with cursors bound to the claim', async () => {
    store(
      ...[1, 2, 3, 4, 5].map((v) => encodeHistoryItem(entry('claim-001', v))),
    );

    const { pages, cursors } = await allPages((cursor) =>
      claims.listHistory('claim-001', { limit: 2, cursor }),
    );

    expect(pages.map((p) => p.map((e) => e.version))).toEqual([
      [1, 2],
      [3, 4],
      [5],
    ]);
    expect(
      decodeCursor(cursors[0]!, { list: 'history', claimId: 'claim-001' }),
    ).toEqual({ PK: 'CLAIM#claim-001', SK: 'HISTORY#0000000002' });
    await expect(
      claims.listHistory('claim-002', { limit: 2, cursor: cursors[0] }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('look-ahead pagination', () => {
  beforeEach(() => {
    storeClaims(...[1, 2, 3, 4, 5].map((n) => claim(n)));
  });

  it('returns at most limit items and a cursor for the last returned item', async () => {
    const first = await claims.listByEmployee('sub-aisha', { limit: 2 });

    expect(ids(first)).toEqual(['claim-005', 'claim-004']);
    expect(table.queries()[0]!.input.Limit).toBe(3);
    expect(
      decodeCursor(first.nextCursor!, {
        list: 'employee',
        employeeId: 'sub-aisha',
      }),
    ).toEqual({
      PK: 'CLAIM#claim-004',
      SK: 'CLAIM',
      GSI1PK: 'EMPLOYEE#sub-aisha',
      GSI1SK: `${time(4)}#claim-004`,
    });
  });

  it('continues from the cursor without skips, repeats, or an empty last page', async () => {
    const { pages, cursors } = await allPages((cursor) =>
      claims.listByEmployee('sub-aisha', { limit: 2, cursor }),
    );

    expect(pages.map((p) => p.map((c) => c.claimId))).toEqual([
      ['claim-005', 'claim-004'],
      ['claim-003', 'claim-002'],
      ['claim-001'],
    ]);
    expect(cursors).toHaveLength(2);
    expect(table.queries()[1]!.input.ExclusiveStartKey).toMatchObject({
      PK: 'CLAIM#claim-004',
    });
  });

  it('issues no cursor when the last page is exactly full', async () => {
    const { pages } = await allPages((cursor) =>
      claims.listByEmployee('sub-aisha', { limit: 5, cursor }),
    );

    expect(pages).toHaveLength(1);
    expect(pages[0]).toHaveLength(5);
  });

  it('continues through partial DynamoDB responses until it has a full page', async () => {
    table.responseCap = 1;

    const page = await claims.listByEmployee('sub-aisha', { limit: 3 });

    expect(ids(page)).toEqual(['claim-005', 'claim-004', 'claim-003']);
    expect(table.queries().map((q) => q.input.Limit)).toEqual([4, 3, 2, 1]);
    expect(table.queries()[1]!.input.ExclusiveStartKey).toMatchObject({
      PK: 'CLAIM#claim-005',
    });
    expect(
      decodeCursor(page.nextCursor!, {
        list: 'employee',
        employeeId: 'sub-aisha',
      }),
    ).toMatchObject({ PK: 'CLAIM#claim-003' });
  });

  it('stops at the end of the partition despite partial responses', async () => {
    table.responseCap = 2;

    const page = await claims.listByEmployee('sub-aisha', { limit: 10 });

    expect(ids(page)).toHaveLength(5);
    expect(page).not.toHaveProperty('nextCursor');
  });
});

describe('cursor rejection before querying', () => {
  beforeEach(() => {
    storeClaims(
      ...[1, 2, 3].map((n) => claim(n, { status: 'SUBMITTED' })),
      ...[4, 5, 6].map((n) => claim(n, { status: 'APPROVED' })),
    );
  });

  async function rejected(read: () => Promise<unknown>) {
    const before = table.commands.length;
    await expect(read()).rejects.toBeInstanceOf(ValidationError);
    expect(table.commands.length).toBe(before);
  }

  it('rejects cursors from another list, user, or status', async () => {
    const employeeCursor = (
      await claims.listByEmployee('sub-aisha', { limit: 1 })
    ).nextCursor;
    const statusCursor = (await claims.listByStatus('SUBMITTED', { limit: 1 }))
      .nextCursor;
    const queueCursor = (
      await claims.listOpenForManager('sub-ben', { limit: 1 })
    ).nextCursor;

    await rejected(() =>
      claims.listOpenForManager('sub-ben', {
        limit: 1,
        cursor: employeeCursor,
      }),
    );
    await rejected(() =>
      claims.listByEmployee('sub-ravi', { limit: 1, cursor: employeeCursor }),
    );
    await rejected(() =>
      claims.listByStatus('APPROVED', { limit: 1, cursor: statusCursor }),
    );
    await rejected(() =>
      claims.listByStatus(undefined, { limit: 1, cursor: statusCursor }),
    );
    await rejected(() =>
      claims.listOpenForManager('sub-chloe', { limit: 1, cursor: queueCursor }),
    );
    await rejected(() =>
      claims.listHistory('claim-001', { limit: 1, cursor: employeeCursor }),
    );
  });

  it('rejects malformed and oversized cursors', async () => {
    await rejected(() =>
      claims.listByEmployee('sub-aisha', { limit: 1, cursor: 'not-a-cursor' }),
    );
    await rejected(() =>
      claims.listByEmployee('sub-aisha', { limit: 1, cursor: 'A'.repeat(513) }),
    );
  });
});

describe('categories', () => {
  it('C1: reads one category strongly consistently and decodes it', async () => {
    const travel = category('travel');
    store(encodeCategoryItem(travel, { claimCount: 4, lastEventVersion: 1 }));

    expect(await categories.get('travel')).toEqual(travel);
    expect(table.commands[0]!.input).toEqual({
      TableName: 'ClaimFlow',
      Key: { PK: 'CATEGORIES', SK: 'CATEGORY#travel' },
      ConsistentRead: true,
    });
    expect(await categories.get('missing')).toBeUndefined();
  });

  it('C2: queries the category partition strongly consistently', async () => {
    store(
      encodeCategoryItem(category('travel'), { claimCount: 0 }),
      encodeCategoryItem(category('meals'), { claimCount: 0 }),
      encodeClaimItem(claim(1)),
    );

    const list = await categories.list();

    expect(table.queries()[0]!.input).toEqual({
      TableName: 'ClaimFlow',
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :category)',
      ExpressionAttributeValues: {
        ':pk': 'CATEGORIES',
        ':category': 'CATEGORY#',
      },
      ScanIndexForward: true,
      ConsistentRead: true,
    });
    expect(list.map((c) => c.categoryId)).toEqual(['meals', 'travel']);
  });

  it('C2: reads every page of the category partition', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    store(
      ...ids.map((id) => encodeCategoryItem(category(id), { claimCount: 0 })),
    );
    table.responseCap = 2;

    const list = await categories.list();

    expect(list.map((c) => c.categoryId)).toEqual(ids);
    expect(table.queries()).toHaveLength(3);
    expect(table.queries()[1]!.input.ExclusiveStartKey).toEqual({
      PK: 'CATEGORIES',
      SK: 'CATEGORY#b',
    });
  });

  it('C2: rejects a malformed category item', async () => {
    store({
      ...encodeCategoryItem(category('x'), { claimCount: 0 }),
      claimCount: -1,
    });

    await expect(categories.list()).rejects.toBeInstanceOf(ItemIntegrityError);
  });
});

it('sends only GetItem and Query commands', async () => {
  storeClaims(...[1, 2, 3].map((n) => claim(n, { status: 'SUBMITTED' })));
  store(
    encodeHistoryItem(entry('claim-001', 1)),
    encodeCategoryItem(category('travel'), { claimCount: 1 }),
  );
  table.responseCap = 1;

  await claims.get('claim-001');
  await claims.existsForCategory('travel');
  await claims.listByEmployee('sub-aisha', { limit: 2 });
  await claims.listOpenForManager('sub-ben', { limit: 2 });
  await claims.listByStatus('SUBMITTED', { limit: 2 });
  await claims.listByStatus(undefined, { limit: 2 });
  await claims.listHistory('claim-001', { limit: 2 });
  await categories.get('travel');
  await categories.list();

  expect(new Set(table.commands.map((c) => c.constructor.name))).toEqual(
    new Set(['GetCommand', 'QueryCommand']),
  );
});
