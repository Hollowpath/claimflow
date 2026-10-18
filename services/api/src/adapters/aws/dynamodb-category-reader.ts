import {
  GetCommand,
  QueryCommand,
  type QueryCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import { idSchema } from '@claimflow/contracts';
import type { Category } from '@claimflow/domain';

import type { CategoryRepository } from '../../application/ports.js';
import {
  categoriesPartitionKey,
  categoryKey,
  decodeCategoryItem,
  ItemIntegrityError,
} from './dynamodb-items.js';
import type {
  DynamoDbReaderOptions,
  ReadDocumentClient,
} from './dynamodb-readers.js';

/**
 * The read side of the DynamoDB category repository
 * (docs/aws-architecture.md, section 6, access patterns C1 and C2). It sends
 * only `GetItem` and `Query`, never `Scan`, and decodes every item with the
 * category codec. Writes are a later increment. Validation errors are fixed
 * messages that name no value; SDK and codec errors propagate unchanged.
 */

type CategoryReads = Pick<CategoryRepository, 'get' | 'list'>;

export class DynamoDbCategoryReader implements CategoryReads {
  private readonly client: ReadDocumentClient;
  private readonly tableName: string;

  public constructor({ client, tableName }: DynamoDbReaderOptions) {
    if (typeof tableName !== 'string' || tableName.length === 0) {
      throw new TypeError('The table name is missing.');
    }
    this.client = client;
    this.tableName = tableName;
  }

  /** C1: one strongly consistent `GetItem`; a missing category is `undefined`. */
  public async get(categoryId: string): Promise<Category | undefined> {
    if (!idSchema.safeParse(categoryId).success) {
      throw new TypeError('The category ID is not valid.');
    }
    const output = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: categoryKey(categoryId),
        ConsistentRead: true,
      }),
    );
    if (output.Item === undefined) {
      return undefined;
    }
    const { category } = decodeCategoryItem(output.Item);
    // The ID was validated, so the key below names no unchecked value.
    if (category.categoryId !== categoryId) {
      throw new ItemIntegrityError(
        `CATEGORIES / CATEGORY#${categoryId}`,
        'the item is not the requested category',
      );
    }
    return category;
  }

  /**
   * C2: every category, in sort-key order, from the category partition of
   * the base table, strongly consistent. The partition is small and bounded,
   * so every page is read until DynamoDB gives no continuation key.
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
      const next = output.LastEvaluatedKey;
      if (
        next !== undefined &&
        startKey !== undefined &&
        JSON.stringify(next) === JSON.stringify(startKey)
      ) {
        throw new Error('The category query did not make progress.');
      }
      startKey = next;
    } while (startKey !== undefined);
    return categories;
  }
}
