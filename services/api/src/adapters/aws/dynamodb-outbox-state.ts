import {
  GetCommand,
  UpdateCommand,
  type GetCommandOutput,
  type UpdateCommandOutput,
} from '@aws-sdk/lib-dynamodb';

import type { OutboxEvent } from '../../application/events.js';
import {
  decodeOutboxItem,
  encodeOutboxItem,
  outboxKey,
  publishedState,
  type StoredOutboxEvent,
} from './dynamodb-outbox-items.js';

/**
 * Reads and advances the publication state of one outbox item
 * (docs/aws-architecture.md, section 15): the publisher rereads an item
 * before publishing it and marks it published afterwards. Duplicate
 * publication, which surfaces as a failed condition, is for the publisher to
 * handle, so every SDK error propagates unchanged.
 */

/** The commands this adapter sends; a `DynamoDBDocumentClient` provides them. */
export interface OutboxDocumentClient {
  send(command: GetCommand): Promise<GetCommandOutput>;
  send(command: UpdateCommand): Promise<UpdateCommandOutput>;
}

export interface DynamoDbOutboxStateOptions {
  readonly client: OutboxDocumentClient;
  readonly tableName: string;
}

/** Only an item that is still pending can be marked published. */
export const outboxPublishCondition = '#state = :pending';

export class DynamoDbOutboxState {
  private readonly client: OutboxDocumentClient;
  private readonly tableName: string;

  public constructor({ client, tableName }: DynamoDbOutboxStateOptions) {
    if (typeof tableName !== 'string' || tableName.length === 0) {
      throw new TypeError('The table name is missing.');
    }
    this.client = client;
    this.tableName = tableName;
  }

  /**
   * The stored item for an event, read strongly consistently, or
   * `undefined` if it does not exist. The event identifies the key and is
   * validated first; the stored item is decoded strictly.
   */
  public async get(event: OutboxEvent): Promise<StoredOutboxEvent | undefined> {
    encodeOutboxItem(event);
    const output = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: outboxKey(event),
        ConsistentRead: true,
      }),
    );
    return output.Item === undefined
      ? undefined
      : decodeOutboxItem(output.Item);
  }

  /**
   * One `UpdateItem` that sets `PUBLISHED`, `publishedAt`, and the TTL seven
   * days later, and removes the item from the pending index, only while the
   * stored state is `PENDING`. `publishedAt` must be a canonical timestamp
   * not before the event occurred.
   */
  public async markPublished(
    event: OutboxEvent,
    publishedAt: string,
  ): Promise<void> {
    const state = publishedState(publishedAt);
    // Validates the event, the timestamp, and the TTL as the codec would store them.
    encodeOutboxItem(event, state);
    if (state.state !== 'PUBLISHED') {
      throw new TypeError('The published state is not valid.');
    }
    await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: outboxKey(event),
        UpdateExpression:
          'SET #state = :published, #publishedAt = :publishedAt, ' +
          '#expiresAt = :expiresAt REMOVE #GSI4PK, #GSI4SK',
        ConditionExpression: outboxPublishCondition,
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
          ':publishedAt': state.publishedAt,
          ':expiresAt': state.expiresAt,
        },
      }),
    );
  }
}
