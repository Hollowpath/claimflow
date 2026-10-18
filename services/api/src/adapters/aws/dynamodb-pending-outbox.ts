import { QueryCommand, type QueryCommandOutput } from '@aws-sdk/lib-dynamodb';

import {
  failWith,
  isIsoTimestamp,
  ItemIntegrityError,
} from './dynamodb-items.js';
import {
  decodeOutboxItem,
  pendingOutboxPartition,
  type StoredOutboxEvent,
} from './dynamodb-outbox-items.js';

/**
 * The sweeper's view of unpublished events (docs/aws-architecture.md,
 * section 15, access pattern O1): pending outbox items older than a cutoff,
 * oldest first, read from the sparse `GSI4` partition. One eventually
 * consistent query; no scan, filter, or paging.
 */

/** The command this adapter sends; a `DynamoDBDocumentClient` provides it. */
export interface QueryDocumentClient {
  send(command: QueryCommand): Promise<QueryCommandOutput>;
}

export interface DynamoDbPendingOutboxOptions {
  readonly client: QueryDocumentClient;
  readonly tableName: string;
}

/** Most events one sweep handles: the publisher's batch size. */
export const maxPendingBatch = 10;

/** Items are ordered by `<occurredAt>#<eventId>`; the cutoff is a time. */
export const pendingOutboxCondition = '#pk = :pk AND #sk < :cutoff';

export class DynamoDbPendingOutbox {
  private readonly client: QueryDocumentClient;
  private readonly tableName: string;

  public constructor({ client, tableName }: DynamoDbPendingOutboxOptions) {
    if (typeof tableName !== 'string' || tableName.length === 0) {
      throw new TypeError('The table name is missing.');
    }
    this.client = client;
    this.tableName = tableName;
  }

  /**
   * Up to `limit` pending events that occurred strictly before `cutoff`,
   * oldest first. Every item is decoded strictly, and anything that is not
   * pending raises `ItemIntegrityError`. SDK errors propagate unchanged.
   */
  public async listPending(
    cutoff: string,
    limit: number,
  ): Promise<readonly StoredOutboxEvent[]> {
    if (!isIsoTimestamp(cutoff)) {
      throw new TypeError('The cutoff must be a canonical ISO timestamp.');
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxPendingBatch) {
      throw new RangeError(
        `The limit must be a whole number from 1 to ${maxPendingBatch}.`,
      );
    }

    const output = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI4',
        KeyConditionExpression: pendingOutboxCondition,
        ExpressionAttributeNames: { '#pk': 'GSI4PK', '#sk': 'GSI4SK' },
        ExpressionAttributeValues: {
          ':pk': pendingOutboxPartition,
          ':cutoff': cutoff,
        },
        ScanIndexForward: true,
        ConsistentRead: false,
        Limit: limit,
      }),
    );

    return (output.Items ?? []).map((item) => {
      const stored = decodeOutboxItem(item);
      if (stored.state.state !== 'PENDING') {
        return failWith(
          ItemIntegrityError,
          item,
        )('a published event is in the pending index');
      }
      return stored;
    });
  }
}
