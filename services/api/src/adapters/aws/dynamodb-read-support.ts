import {
  QueryCommand,
  type GetCommand,
  type GetCommandOutput,
  type QueryCommandInput,
  type QueryCommandOutput,
} from '@aws-sdk/lib-dynamodb';

import type { Page, PageRequest } from '../../application/ports.js';
import { decodeCursor, type CursorList } from './dynamodb-cursor.js';
import type { DynamoItem } from './dynamodb-items.js';

/**
 * What the DynamoDB read adapters share (docs/aws-architecture.md, sections
 * 6 and 13): their client and option types, constructor validation, and the
 * look-ahead page query. It imports no reader, so the readers can import it
 * without a runtime cycle.
 */

/** The commands the readers send; a `DynamoDBDocumentClient` provides them. */
export interface ReadDocumentClient {
  send(command: GetCommand): Promise<GetCommandOutput>;
  send(command: QueryCommand): Promise<QueryCommandOutput>;
}

export interface DynamoDbReaderOptions {
  readonly client: ReadDocumentClient;
  readonly tableName: string;
}

/** Fixed messages; none names a supplied value. */
export function checkReaderOptions({
  client,
  tableName,
}: DynamoDbReaderOptions): void {
  if (typeof client?.send !== 'function') {
    throw new TypeError('The DynamoDB client is missing.');
  }
  if (typeof tableName !== 'string' || tableName.length === 0) {
    throw new TypeError('The table name is missing.');
  }
}

/**
 * One page of at most `limit` items. It asks DynamoDB for one item more than
 * the page holds, continuing through partial responses, and issues a cursor
 * for the last returned item only when that extra item exists, so a page is
 * never followed by an empty one. The limit and the cursor are validated
 * before any query.
 */
export async function queryPage<T>(
  client: ReadDocumentClient,
  query: Omit<QueryCommandInput, 'Limit' | 'ExclusiveStartKey'>,
  page: PageRequest,
  list: CursorList,
  decode: (item: DynamoItem) => T,
  cursorAfter: (item: T) => string,
): Promise<Page<T>> {
  if (typeof page !== 'object' || page === null) {
    throw new TypeError('The page request is missing.');
  }
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
export function nextStartKey(
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
