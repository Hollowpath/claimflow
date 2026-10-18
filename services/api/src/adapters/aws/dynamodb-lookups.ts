import { GetCommand, type GetCommandOutput } from '@aws-sdk/lib-dynamodb';

import type { EpochSeconds } from '../../application/commit.js';
import {
  decodeIdempotencyItem,
  idempotencyKey,
  type IdempotencyRecord,
} from './dynamodb-idempotency-items.js';
import {
  decodeReceiptItem,
  receiptKey,
  type ReceiptRecord,
} from './dynamodb-receipt-items.js';

/**
 * Strongly consistent single-item lookups (docs/aws-architecture.md,
 * sections 10 and 11) used before receipt attachment, idempotent replay, and
 * transaction recovery. They send only `GetItem` and decode every item with
 * its codec; SDK errors and malformed items propagate unchanged.
 */

/** The command these lookups send; a `DynamoDBDocumentClient` provides it. */
export interface GetDocumentClient {
  send(command: GetCommand): Promise<GetCommandOutput>;
}

export interface DynamoDbLookupOptions {
  readonly client: GetDocumentClient;
  readonly tableName: string;
}

/** Receipt metadata by receipt ID, in whatever state it is. */
export class DynamoDbReceiptMetadataReader {
  private readonly client: GetDocumentClient;
  private readonly tableName: string;

  public constructor({ client, tableName }: DynamoDbLookupOptions) {
    this.client = client;
    this.tableName = tableName;
  }

  public async get(receiptId: string): Promise<ReceiptRecord | undefined> {
    const output = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: receiptKey(receiptId),
        ConsistentRead: true,
      }),
    );
    return output.Item === undefined
      ? undefined
      : decodeReceiptItem(output.Item);
  }
}

/** The stored result of an actor's idempotency key, if it has not expired. */
export class DynamoDbIdempotencyReader {
  private readonly client: GetDocumentClient;
  private readonly tableName: string;

  public constructor({ client, tableName }: DynamoDbLookupOptions) {
    this.client = client;
    this.tableName = tableName;
  }

  /**
   * TTL deletion can lag, so a record with `expiresAt < nowEpoch` counts as
   * absent, matching the `expiresAt < :nowEpoch` write condition; a record
   * expiring exactly now is still present.
   */
  public async find(
    actorId: string,
    key: string,
    nowEpoch: EpochSeconds,
  ): Promise<IdempotencyRecord | undefined> {
    if (!Number.isSafeInteger(nowEpoch) || nowEpoch < 0) {
      throw new RangeError('nowEpoch must be whole Unix epoch seconds.');
    }
    const output = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: idempotencyKey(actorId, key),
        ConsistentRead: true,
      }),
    );
    if (output.Item === undefined) {
      return undefined;
    }
    const record = decodeIdempotencyItem(output.Item);
    return record.expiresAt < nowEpoch ? undefined : record;
  }
}
