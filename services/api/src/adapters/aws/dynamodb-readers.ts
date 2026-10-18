import {
  GetCommand,
  QueryCommand,
  type GetCommandOutput,
  type QueryCommandInput,
  type QueryCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import type {
  Category,
  Claim,
  ClaimHistoryEntry,
  ClaimStatus,
} from '@claimflow/domain';

import type {
  CategoryRepository,
  ClaimRepository,
  Page,
  PageRequest,
} from '../../application/ports.js';
import {
  decodeCursor,
  encodeClaimCursor,
  encodeHistoryCursor,
  type CursorList,
} from './dynamodb-cursor.js';
import {
  categoriesPartitionKey,
  categoryKey,
  claimKey,
  decodeCategoryItem,
  decodeClaimItem,
  decodeHistoryItem,
  type DynamoItem,
} from './dynamodb-items.js';

/**
 * Read-only DynamoDB adapters for claims, history, and categories
 * (docs/aws-architecture.md, sections 6 and 13). They send only `GetItem`
 * and `Query`, with no filter expressions, and decode every item with the
 * item codecs. Write methods are added in a later increment.
 */

/** The commands these readers send; a `DynamoDBDocumentClient` provides them. */
export interface ReadDocumentClient {
  send(command: GetCommand): Promise<GetCommandOutput>;
  send(command: QueryCommand): Promise<QueryCommandOutput>;
}

export interface DynamoDbReaderOptions {
  readonly client: ReadDocumentClient;
  readonly tableName: string;
}

type ClaimReads = Pick<
  ClaimRepository,
  | 'get'
  | 'existsForCategory'
  | 'listByEmployee'
  | 'listOpenForManager'
  | 'listByStatus'
  | 'listHistory'
>;

type CategoryReads = Pick<CategoryRepository, 'get' | 'list'>;

export class DynamoDbClaimReader implements ClaimReads {
  private readonly client: ReadDocumentClient;
  private readonly tableName: string;

  public constructor({ client, tableName }: DynamoDbReaderOptions) {
    this.client = client;
    this.tableName = tableName;
  }

  /** A1: strongly consistent `GetItem`. */
  public async get(claimId: string): Promise<Claim | undefined> {
    const output = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: claimKey(claimId),
        ConsistentRead: true,
      }),
    );
    return output.Item === undefined
      ? undefined
      : decodeClaimItem(output.Item).claim;
  }

  /**
   * A5: the category's `claimCount`, read strongly consistently. A category
   * that does not exist is not used by any claim.
   */
  public async existsForCategory(categoryId: string): Promise<boolean> {
    const output = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: categoryKey(categoryId),
        ConsistentRead: true,
      }),
    );
    return output.Item === undefined
      ? false
      : decodeCategoryItem(output.Item).metadata.claimCount > 0;
  }

  /** A6: GSI1, most recently updated first. */
  public listByEmployee(
    employeeId: string,
    page: PageRequest,
  ): Promise<Page<Claim>> {
    return this.claimPage(
      { list: 'employee', employeeId },
      'GSI1',
      `EMPLOYEE#${employeeId}`,
      false,
      page,
    );
  }

  /** A7: GSI2, oldest submission first. */
  public listOpenForManager(
    managerId: string,
    page: PageRequest,
  ): Promise<Page<Claim>> {
    return this.claimPage(
      { list: 'queue', managerId },
      'GSI2',
      `MANAGER#${managerId}#OPEN`,
      true,
      page,
    );
  }

  /** A8 (GSI3) for one status, or A9 (GSI4) for all; newest first. */
  public listByStatus(
    status: ClaimStatus | undefined,
    page: PageRequest,
  ): Promise<Page<Claim>> {
    return status === undefined
      ? this.claimPage({ list: 'all' }, 'GSI4', 'CLAIM', false, page)
      : this.claimPage(
          { list: 'status', status },
          'GSI3',
          `STATUS#${status}`,
          false,
          page,
        );
  }

  /** A10: strongly consistent base-table query, oldest version first. */
  public listHistory(
    claimId: string,
    page: PageRequest,
  ): Promise<Page<ClaimHistoryEntry>> {
    const list: CursorList = { list: 'history', claimId };
    return queryPage(
      this.client,
      {
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :history)',
        ExpressionAttributeValues: {
          ':pk': claimKey(claimId).PK,
          ':history': 'HISTORY#',
        },
        ScanIndexForward: true,
        ConsistentRead: true,
      },
      page,
      list,
      decodeHistoryItem,
      encodeHistoryCursor,
    );
  }

  private claimPage(
    list: Exclude<CursorList, { list: 'history' }>,
    index: 'GSI1' | 'GSI2' | 'GSI3' | 'GSI4',
    partition: string,
    ascending: boolean,
    page: PageRequest,
  ): Promise<Page<Claim>> {
    return queryPage(
      this.client,
      {
        TableName: this.tableName,
        IndexName: index,
        KeyConditionExpression: '#pk = :pk',
        ExpressionAttributeNames: { '#pk': `${index}PK` },
        ExpressionAttributeValues: { ':pk': partition },
        ScanIndexForward: ascending,
        // Global secondary indexes support only eventually consistent reads.
        ConsistentRead: false,
      },
      page,
      list,
      (item) => decodeClaimItem(item).claim,
      (claim) => encodeClaimCursor(list, claim),
    );
  }
}

export class DynamoDbCategoryReader implements CategoryReads {
  private readonly client: ReadDocumentClient;
  private readonly tableName: string;

  public constructor({ client, tableName }: DynamoDbReaderOptions) {
    this.client = client;
    this.tableName = tableName;
  }

  /** C1: strongly consistent `GetItem`. */
  public async get(categoryId: string): Promise<Category | undefined> {
    const output = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: categoryKey(categoryId),
        ConsistentRead: true,
      }),
    );
    return output.Item === undefined
      ? undefined
      : decodeCategoryItem(output.Item).category;
  }

  /**
   * C2: every category, in key order, read strongly consistently. The
   * category partition is small and bounded, so every page is read.
   */
  public async list(): Promise<readonly Category[]> {
    const categories: Category[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const output: QueryCommandOutput = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :category)',
          ExpressionAttributeValues: {
            ':pk': categoriesPartitionKey,
            ':category': 'CATEGORY#',
          },
          ScanIndexForward: true,
          ConsistentRead: true,
          ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
        }),
      );
      for (const item of output.Items ?? []) {
        categories.push(decodeCategoryItem(item).category);
      }
      startKey = nextStartKey(startKey, output.LastEvaluatedKey);
    } while (startKey !== undefined);
    return categories;
  }
}

/**
 * One page of at most `limit` items. It asks DynamoDB for one item more than
 * the page holds, continuing through partial responses, and issues a cursor
 * for the last returned item only when that extra item exists, so a page is
 * never followed by an empty one.
 */
async function queryPage<T>(
  client: ReadDocumentClient,
  query: Omit<QueryCommandInput, 'Limit' | 'ExclusiveStartKey'>,
  page: PageRequest,
  list: CursorList,
  decode: (item: DynamoItem) => T,
  cursorAfter: (item: T) => string,
): Promise<Page<T>> {
  if (!Number.isSafeInteger(page.limit) || page.limit < 1) {
    throw new RangeError('The page limit must be a positive whole number.');
  }
  // Validated before any query, so an invalid cursor never reaches DynamoDB.
  let startKey: Record<string, unknown> | undefined =
    page.cursor === undefined ? undefined : decodeCursor(page.cursor, list);

  const items: T[] = [];
  let more = false;
  do {
    const output: QueryCommandOutput = await client.send(
      new QueryCommand({
        ...query,
        Limit: page.limit + 1 - items.length,
        ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
      }),
    );
    for (const item of output.Items ?? []) {
      items.push(decode(item));
    }
    if (items.length > page.limit) {
      more = true;
      break;
    }
    startKey = nextStartKey(startKey, output.LastEvaluatedKey);
  } while (startKey !== undefined);

  const returned = items.slice(0, page.limit);
  const last = returned.at(-1);
  return more && last !== undefined
    ? { items: returned, nextCursor: cursorAfter(last) }
    : { items: returned };
}

/** The next start key, refusing a response that would not make progress. */
function nextStartKey(
  previous: Record<string, unknown> | undefined,
  lastEvaluated: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (
    lastEvaluated !== undefined &&
    previous !== undefined &&
    JSON.stringify(lastEvaluated) === JSON.stringify(previous)
  ) {
    throw new Error('DynamoDB returned the same LastEvaluatedKey twice.');
  }
  return lastEvaluated;
}
