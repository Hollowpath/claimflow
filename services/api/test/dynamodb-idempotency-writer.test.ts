import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  PutCommand,
  type DynamoDBDocumentClient,
  type PutCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import { beforeEach, describe, expect, expectTypeOf, it } from 'vitest';

import {
  encodeIdempotencyItem,
  type IdempotencyRecord,
} from '../src/adapters/aws/dynamodb-idempotency-items.js';
import {
  DynamoDbRejectionWriter,
  rejectionWriteCondition,
  type PutDocumentClient,
  type RejectedIdempotencyRecord,
} from '../src/adapters/aws/dynamodb-idempotency-writer.js';
import {
  ItemEncodingError,
  type DynamoItem,
} from '../src/adapters/aws/dynamodb-items.js';

const tableName = 'ClaimFlow';

/**
 * Records every command. It applies the approved condition to an existing
 * item, so the `<` boundary can be checked, or fails with a set error.
 */
class FakeClient implements PutDocumentClient {
  public readonly commands: unknown[] = [];
  public existing: DynamoItem | undefined;
  public failure: Error | undefined;

  public send(command: PutCommand): Promise<PutCommandOutput> {
    this.commands.push(command);
    if (!(command instanceof PutCommand)) {
      return Promise.reject(new Error('Only PutCommand is expected.'));
    }
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
    const input = command.input;
    expect(input.ConditionExpression).toBe(
      'attribute_not_exists(PK) OR expiresAt < :nowEpoch',
    );
    const now = input.ExpressionAttributeValues?.[':nowEpoch'] as number;
    if (
      this.existing !== undefined &&
      !((this.existing.expiresAt as number) < now)
    ) {
      return Promise.reject(
        new ConditionalCheckFailedException({
          message: 'The conditional request failed',
          $metadata: {},
        }),
      );
    }
    this.existing = input.Item;
    return Promise.resolve({ $metadata: {} });
  }
}

const rejected: RejectedIdempotencyRecord = {
  actorId: 'sub-aisha',
  key: '5b0d6a8e-retry-key',
  fingerprint: 'ab'.repeat(32),
  outcome: 'REJECTED',
  response: {
    status: 409,
    body: {
      error: {
        code: 'VERSION_CONFLICT',
        message: 'This claim was changed by someone else.',
        requestId: 'request-1',
      },
    },
  },
  createdAt: '2026-10-14T10:41:00.000Z',
  expiresAt: 1_792_060_860,
};

/** The time the rejection is stored: when it was created. */
const createdEpoch = 1_791_974_460;

let client: FakeClient;
let writer: DynamoDbRejectionWriter;

beforeEach(() => {
  client = new FakeClient();
  writer = new DynamoDbRejectionWriter({ client, tableName });
});

const puts = () => client.commands as PutCommand[];

it('accepts the real DynamoDB document client and only rejected records', () => {
  expectTypeOf<DynamoDBDocumentClient>().toExtend<PutDocumentClient>();
  expectTypeOf<
    RejectedIdempotencyRecord['outcome']
  >().toEqualTypeOf<'REJECTED'>();
  expectTypeOf<
    Extract<IdempotencyRecord, { outcome: 'COMPLETED' }>
  >().not.toExtend<RejectedIdempotencyRecord>();
});

describe('recordRejection', () => {
  it('sends one conditional PutItem of the complete encoded record', async () => {
    await writer.recordRejection(rejected, createdEpoch);

    expect(puts()).toHaveLength(1);
    expect(puts()[0]!.input).toEqual({
      TableName: 'ClaimFlow',
      Item: {
        PK: 'IDEMPOTENCY#sub-aisha#5b0d6a8e-retry-key',
        SK: 'IDEMPOTENCY',
        entityType: 'IdempotencyRecord',
        fingerprint: 'ab'.repeat(32),
        outcome: 'REJECTED',
        response: rejected.response,
        createdAt: '2026-10-14T10:41:00.000Z',
        expiresAt: 1_792_060_860,
      },
      ConditionExpression: 'attribute_not_exists(PK) OR expiresAt < :nowEpoch',
      ExpressionAttributeValues: { ':nowEpoch': createdEpoch },
    });
    expect(puts()[0]!.input.Item).toEqual(encodeIdempotencyItem(rejected));
    expect(rejectionWriteCondition).toBe(
      'attribute_not_exists(PK) OR expiresAt < :nowEpoch',
    );
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects a current time of %s before sending anything',
    async (nowEpoch) => {
      await expect(writer.recordRejection(rejected, nowEpoch)).rejects.toThrow(
        RangeError,
      );
      expect(client.commands).toEqual([]);
    },
  );

  it('rejects a completed record before sending anything', async () => {
    const completed = {
      ...rejected,
      outcome: 'COMPLETED',
      response: { status: 200, body: {} },
    } as unknown as RejectedIdempotencyRecord;

    await expect(
      writer.recordRejection(completed, createdEpoch),
    ).rejects.toThrow(TypeError);
    expect(client.commands).toEqual([]);
  });

  it('rejects an invalid record through the codec before sending anything', async () => {
    await expect(
      writer.recordRejection(
        { ...rejected, fingerprint: 'not-a-sha256' },
        createdEpoch,
      ),
    ).rejects.toBeInstanceOf(ItemEncodingError);
    expect(client.commands).toEqual([]);
  });

  it('refuses a record that has already expired', async () => {
    await expect(
      writer.recordRejection(rejected, rejected.expiresAt + 1),
    ).rejects.toThrow('already expired');
    expect(client.commands).toEqual([]);
  });

  it('still writes a record expiring exactly now, which the lookup treats as present', async () => {
    await writer.recordRejection(rejected, rejected.expiresAt);

    expect(puts()).toHaveLength(1);
    expect(puts()[0]!.input).toMatchObject({
      ConditionExpression: 'attribute_not_exists(PK) OR expiresAt < :nowEpoch',
      ExpressionAttributeValues: { ':nowEpoch': rejected.expiresAt },
    });
  });
});

describe('the condition on an existing record', () => {
  const existingExpiringAt = (expiresAt: number): DynamoItem => ({
    ...encodeIdempotencyItem(rejected),
    expiresAt,
  });

  it('blocks the write while the existing record expires exactly now', async () => {
    client.existing = existingExpiringAt(createdEpoch);

    await expect(
      writer.recordRejection(rejected, createdEpoch),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
  });

  it('blocks the write while the existing record is unexpired', async () => {
    client.existing = existingExpiringAt(createdEpoch + 1);

    await expect(
      writer.recordRejection(rejected, createdEpoch),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
  });

  it('replaces an existing record that expired before now', async () => {
    client.existing = existingExpiringAt(createdEpoch - 1);

    await writer.recordRejection(rejected, createdEpoch);

    expect(client.existing).toEqual(encodeIdempotencyItem(rejected));
  });
});

describe('SDK errors', () => {
  it('propagate ConditionalCheckFailedException as the identical object', async () => {
    const failure = new ConditionalCheckFailedException({
      message: 'The conditional request failed',
      $metadata: { httpStatusCode: 400 },
    });
    client.failure = failure;

    await expect(writer.recordRejection(rejected, createdEpoch)).rejects.toBe(
      failure,
    );
  });

  it('propagate other SDK errors unchanged', async () => {
    const failure = Object.assign(new Error('Rate exceeded'), {
      name: 'ProvisionedThroughputExceededException',
    });
    client.failure = failure;

    await expect(writer.recordRejection(rejected, createdEpoch)).rejects.toBe(
      failure,
    );
  });
});

it('sends only PutCommand', async () => {
  await writer.recordRejection(rejected, createdEpoch);
  client.existing = undefined;
  await writer.recordRejection(rejected, rejected.expiresAt);
  await writer.recordRejection(rejected, createdEpoch).catch(() => undefined);

  expect(client.commands.length).toBeGreaterThan(0);
  expect(client.commands.every((c) => c instanceof PutCommand)).toBe(true);
});
