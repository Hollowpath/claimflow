import { PutCommand, type PutCommandOutput } from '@aws-sdk/lib-dynamodb';

import type { EpochSeconds } from '../../application/commit.js';
import {
  encodeIdempotencyItem,
  idempotencyWriteCondition,
  type IdempotencyRecord,
} from './dynamodb-idempotency-items.js';

/**
 * Stores business rejections under their idempotency key
 * (docs/aws-architecture.md, section 10, step 5), so that a retry gets the
 * same answer. Successful results are stored by the mutation's transaction
 * instead.
 */

export type RejectedIdempotencyRecord = Extract<
  IdempotencyRecord,
  { readonly outcome: 'REJECTED' }
>;

/** The command this writer sends; a `DynamoDBDocumentClient` provides it. */
export interface PutDocumentClient {
  send(command: PutCommand): Promise<PutCommandOutput>;
}

export interface DynamoDbRejectionWriterOptions {
  readonly client: PutDocumentClient;
  readonly tableName: string;
}

export class DynamoDbRejectionWriter {
  private readonly client: PutDocumentClient;
  private readonly tableName: string;

  public constructor({ client, tableName }: DynamoDbRejectionWriterOptions) {
    this.client = client;
    this.tableName = tableName;
  }

  /**
   * One conditional `PutItem` of the encoded record. When the condition
   * fails, `ConditionalCheckFailedException` propagates unchanged, as does
   * every other SDK error, so the caller can strongly reread the record.
   */
  public async recordRejection(
    record: RejectedIdempotencyRecord,
    nowEpoch: EpochSeconds,
  ): Promise<void> {
    if (!Number.isSafeInteger(nowEpoch) || nowEpoch < 0) {
      throw new RangeError('nowEpoch must be whole Unix epoch seconds.');
    }
    if ((record as IdempotencyRecord).outcome !== 'REJECTED') {
      throw new TypeError(
        'Only REJECTED idempotency records can be stored here.',
      );
    }
    const item = encodeIdempotencyItem(record);
    // Under the lookup's rule a record expiring exactly now is still present,
    // so only one that has already expired is refused.
    if (record.expiresAt < nowEpoch) {
      throw new RangeError('The idempotency record has already expired.');
    }

    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: item,
        ConditionExpression: idempotencyWriteCondition,
        ExpressionAttributeValues: { ':nowEpoch': nowEpoch },
      }),
    );
  }
}
