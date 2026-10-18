import {
  BatchWriteCommand,
  QueryCommand,
  type BatchWriteCommandInput,
  type BatchWriteCommandOutput,
  type QueryCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import { idSchema } from '@claimflow/contracts';

/**
 * Purges the history of a deleted claim (docs/aws-architecture.md, section
 * 12). The cleanup worker calls it after the claim itself is gone: it reads
 * every `HISTORY#` key in the claim's partition, page by page, and deletes
 * them in batches of 25, retrying only what DynamoDB reports unprocessed.
 * Purging a claim with no history, or one already purged, succeeds.
 */

/** The commands the purger sends; a `DynamoDBDocumentClient` provides them. */
export interface HistoryPurgeClient {
  send(command: QueryCommand): Promise<QueryCommandOutput>;
  send(command: BatchWriteCommand): Promise<BatchWriteCommandOutput>;
}

export interface DynamoDbHistoryPurgerOptions {
  readonly client: HistoryPurgeClient;
  readonly tableName: string;
  /** Writes of one batch, including the first; at least 1. Default 6. */
  readonly maxAttempts?: number;
  /** Delay before the first retry; doubled for each later one. Default 50 ms. */
  readonly baseDelayMs?: number;
  /** Longest delay between retries. Default 1,000 ms. */
  readonly maxDelayMs?: number;
  /** Waits between retries; replaceable so tests do not wait. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** `BatchWriteItem` accepts at most 25 requests per call. */
export const maxBatchDeletes = 25;

const reasons = {
  unprocessed:
    'Some history items were still unprocessed after the last attempt.',
  unexpectedKey:
    "A returned history key was not one of the claim's history keys.",
  noProgress: 'The history query did not make progress.',
} as const;

/** A purge that could not finish; the messages are fixed and name no value. */
export class HistoryPurgeError extends Error {
  public constructor(reason: keyof typeof reasons) {
    super(reasons[reason]);
    this.name = 'HistoryPurgeError';
  }
}

type Key = { readonly PK: string; readonly SK: string };

export class DynamoDbHistoryPurger {
  private readonly client: HistoryPurgeClient;
  private readonly tableName: string;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  public constructor(options: DynamoDbHistoryPurgerOptions) {
    if (
      typeof options.tableName !== 'string' ||
      options.tableName.length === 0
    ) {
      throw new TypeError('The table name is missing.');
    }
    this.client = options.client;
    this.tableName = options.tableName;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 6);
    this.baseDelayMs = options.baseDelayMs ?? 50;
    this.maxDelayMs = options.maxDelayMs ?? 1000;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Deletes every history item of the claim. SDK errors propagate unchanged;
   * a returned key outside the claim's history, or items still unprocessed
   * after the last attempt, raise `HistoryPurgeError`.
   */
  public async purge(claimId: string): Promise<void> {
    if (!idSchema.safeParse(claimId).success) {
      throw new TypeError('The claim ID is not valid.');
    }
    const partition = `CLAIM#${claimId}`;

    let startKey: Record<string, unknown> | undefined;
    do {
      const output: QueryCommandOutput = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :history)',
          ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
          ExpressionAttributeValues: {
            ':pk': partition,
            ':history': 'HISTORY#',
          },
          ProjectionExpression: '#pk, #sk',
          ScanIndexForward: true,
          ConsistentRead: true,
          ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
        }),
      );

      // The whole page is checked before any of it is deleted.
      const keys = (output.Items ?? []).map((item) =>
        checkKey(item, partition),
      );
      for (let from = 0; from < keys.length; from += maxBatchDeletes) {
        await this.deleteBatch(keys.slice(from, from + maxBatchDeletes));
      }

      const next = output.LastEvaluatedKey;
      if (
        next !== undefined &&
        startKey !== undefined &&
        JSON.stringify(next) === JSON.stringify(startKey)
      ) {
        throw new HistoryPurgeError('noProgress');
      }
      startKey = next;
    } while (startKey !== undefined);
  }

  /** One batch of deletes, resending only unprocessed requests. */
  private async deleteBatch(keys: readonly Key[]): Promise<void> {
    let requests: NonNullable<BatchWriteCommandInput['RequestItems']>[string] =
      keys.map((Key) => ({ DeleteRequest: { Key } }));

    for (let attempt = 1; ; attempt += 1) {
      const output = await this.client.send(
        new BatchWriteCommand({
          RequestItems: { [this.tableName]: requests },
        }),
      );
      requests = output.UnprocessedItems?.[this.tableName] ?? [];
      if (requests.length === 0) {
        return;
      }
      if (attempt >= this.maxAttempts) {
        throw new HistoryPurgeError('unprocessed');
      }
      await this.sleep(
        Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (attempt - 1)),
      );
    }
  }
}

/** Only `PK` and `SK`, the claim's partition, and `HISTORY#` plus ten digits. */
function checkKey(item: Record<string, unknown>, partition: string): Key {
  const names = Object.keys(item);
  if (
    names.length !== 2 ||
    item.PK !== partition ||
    typeof item.SK !== 'string' ||
    !/^HISTORY#\d{10}$/.test(item.SK)
  ) {
    throw new HistoryPurgeError('unexpectedKey');
  }
  return { PK: item.PK, SK: item.SK };
}
