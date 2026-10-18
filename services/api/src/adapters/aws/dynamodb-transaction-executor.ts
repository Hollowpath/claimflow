import {
  TransactWriteCommand,
  type TransactWriteCommandInput,
  type TransactWriteCommandOutput,
} from '@aws-sdk/lib-dynamodb';

/**
 * Sends a composed business transaction (docs/aws-architecture.md, sections
 * 8 and 10). It sends the input exactly as given and does nothing else: no
 * retries, no inspection of cancellation reasons, no logging, and no error
 * mapping. Recovery after a failure belongs to the idempotency orchestration.
 */

/** The command this executor sends; a `DynamoDBDocumentClient` provides it. */
export interface TransactDocumentClient {
  send(command: TransactWriteCommand): Promise<TransactWriteCommandOutput>;
}

export interface DynamoDbTransactionExecutorOptions {
  readonly client: TransactDocumentClient;
}

export class DynamoDbTransactionExecutor {
  private readonly client: TransactDocumentClient;

  public constructor({ client }: DynamoDbTransactionExecutorOptions) {
    this.client = client;
  }

  /**
   * One `TransactWriteItems` call with the composed input, including its
   * `ClientRequestToken` and item order. Every SDK error, including
   * `TransactionCanceledException` and `IdempotentParameterMismatchException`,
   * propagates unchanged.
   */
  public execute(
    input: TransactWriteCommandInput,
  ): Promise<TransactWriteCommandOutput> {
    return this.client.send(new TransactWriteCommand(input));
  }
}
