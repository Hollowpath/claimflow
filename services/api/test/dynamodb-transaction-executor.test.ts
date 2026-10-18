import {
  TransactWriteCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import { beforeEach, describe, expect, expectTypeOf, it } from 'vitest';

import {
  DynamoDbTransactionExecutor,
  type TransactDocumentClient,
} from '../src/adapters/aws/dynamodb-transaction-executor.js';
import {
  composeBusinessTransaction,
  type TransactionItem,
} from '../src/adapters/aws/dynamodb-transaction.js';
import type { CompletedRequest } from '../src/application/commit.js';

const tableName = 'ClaimFlow';

/** Records every command and answers with a set output or error. */
class FakeClient implements TransactDocumentClient {
  public readonly commands: unknown[] = [];
  public output: TransactWriteCommandOutput = { $metadata: {} };
  public failure: unknown;

  public send(
    command: TransactWriteCommand,
  ): Promise<TransactWriteCommandOutput> {
    this.commands.push(command);
    return this.failure === undefined
      ? Promise.resolve(this.output)
      : // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        Promise.reject(this.failure);
  }
}

const check = (id: string): TransactionItem => ({
  ConditionCheck: {
    TableName: tableName,
    Key: { PK: `CLAIM#${id}`, SK: 'CLAIM' },
    ConditionExpression: 'attribute_exists(PK)',
  },
});

const completed: CompletedRequest = {
  actorId: 'sub-aisha',
  key: 'executor-key-0001',
  fingerprint: 'ab'.repeat(32),
  response: { status: 200, body: { ok: true } },
  createdAt: '2026-10-14T10:41:00.000Z',
  expiresAt: 1_792_060_860,
};

const composed = () =>
  composeBusinessTransaction({
    tableName,
    businessItems: [check('b'), check('a'), check('c')],
    events: [],
    completed,
  });

let client: FakeClient;
let executor: DynamoDbTransactionExecutor;

beforeEach(() => {
  client = new FakeClient();
  executor = new DynamoDbTransactionExecutor({ client });
});

it('accepts the real DynamoDB document client', () => {
  expectTypeOf<DynamoDBDocumentClient>().toExtend<TransactDocumentClient>();
});

describe('execute', () => {
  it('sends the exact composed input in one TransactWriteCommand', async () => {
    const input = composed();
    const snapshot = structuredClone(input);

    await executor.execute(input);

    expect(client.commands).toHaveLength(1);
    expect(client.commands[0]).toBeInstanceOf(TransactWriteCommand);
    expect((client.commands[0] as TransactWriteCommand).input).toEqual(
      snapshot,
    );
    expect(input).toEqual(snapshot);
  });

  it('preserves the token and the operation order', async () => {
    const input = composed();

    await executor.execute(input);

    const sent = (client.commands[0] as TransactWriteCommand).input;
    expect(sent.ClientRequestToken).toBe(input.ClientRequestToken);
    expect(sent.ClientRequestToken).toMatch(/^[0-9a-f]{32}$/);
    expect(sent.TransactItems).toEqual(input.TransactItems);
    expect(
      sent
        .TransactItems!.slice(0, 3)
        .map((item) => item.ConditionCheck!.Key!.PK),
    ).toEqual(['CLAIM#b', 'CLAIM#a', 'CLAIM#c']);
  });

  it('returns the SDK output', async () => {
    client.output = {
      $metadata: { httpStatusCode: 200, requestId: 'req-1' },
      ConsumedCapacity: [{ TableName: tableName, CapacityUnits: 9 }],
    };

    expect(await executor.execute(composed())).toBe(client.output);
  });
});

describe('SDK errors', () => {
  it.each([
    ['a cancellation', 'TransactionCanceledException'],
    ['a token mismatch', 'IdempotentParameterMismatchException'],
    ['throttling', 'ProvisionedThroughputExceededException'],
    ['a timeout', 'TimeoutError'],
    ['an internal error', 'InternalServerError'],
  ])('propagates %s by identity, without a retry', async (_label, name) => {
    const failure = Object.assign(new Error('failed'), {
      name,
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
    });
    client.failure = failure;

    await expect(executor.execute(composed())).rejects.toBe(failure);
    expect(client.commands).toHaveLength(1);
  });

  it('propagates a non-Error rejection unchanged', async () => {
    client.failure = 'boom';

    await expect(executor.execute(composed())).rejects.toBe('boom');
    expect(client.commands).toHaveLength(1);
  });
});

it('sends one new command per call and never a second one on its own', async () => {
  await executor.execute(composed());
  await executor.execute(composed());

  expect(client.commands).toHaveLength(2);
  expect(client.commands.every((c) => c instanceof TransactWriteCommand)).toBe(
    true,
  );
  expect(client.commands[0]).not.toBe(client.commands[1]);
});
