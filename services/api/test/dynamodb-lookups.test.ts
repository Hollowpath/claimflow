import {
  GetCommand,
  type DynamoDBDocumentClient,
  type GetCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import { beforeEach, describe, expect, expectTypeOf, it } from 'vitest';

import {
  encodeIdempotencyItem,
  type IdempotencyRecord,
} from '../src/adapters/aws/dynamodb-idempotency-items.js';
import {
  ItemIntegrityError,
  type DynamoItem,
} from '../src/adapters/aws/dynamodb-items.js';
import {
  DynamoDbIdempotencyReader,
  DynamoDbReceiptMetadataReader,
  type GetDocumentClient,
} from '../src/adapters/aws/dynamodb-lookups.js';
import {
  encodeReceiptItem,
  pendingReceiptExpiresAt,
  retiredReceiptExpiresAt,
  type ReceiptRecord,
} from '../src/adapters/aws/dynamodb-receipt-items.js';

const tableName = 'ClaimFlow';

/** Records every command, answers from stored items, or fails as set. */
class FakeClient implements GetDocumentClient {
  public readonly commands: unknown[] = [];
  public readonly items = new Map<string, DynamoItem>();
  public failure: Error | undefined;

  public put(item: DynamoItem): void {
    this.items.set(`${String(item.PK)}|${String(item.SK)}`, item);
  }

  public send(command: GetCommand): Promise<GetCommandOutput> {
    this.commands.push(command);
    if (!(command instanceof GetCommand)) {
      return Promise.reject(new Error('Only GetCommand is expected.'));
    }
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
    const key = command.input.Key as DynamoItem;
    const item = this.items.get(`${String(key.PK)}|${String(key.SK)}`);
    return Promise.resolve({
      $metadata: {},
      ...(item === undefined ? {} : { Item: item }),
    });
  }
}

const claimId = '4ce0c74b-9c64-46d6-87ba-07fb71b0628c';
const uploadedAt = '2026-10-14T10:35:00.000Z';
const base = {
  receiptId: 'r-7731',
  ownerId: 'sub-aisha',
  fileName: 'flight.pdf',
  uploadedAt,
};
const measured = {
  contentType: 'application/pdf',
  sizeBytes: 52_144,
  checksumSha256: 'a1b2'.repeat(16),
  attachedClaimId: claimId,
} as const;

const receipts: readonly ReceiptRecord[] = [
  {
    ...base,
    state: 'PENDING',
    declaredContentType: 'application/pdf',
    declaredSizeBytes: 52_144,
    declaredChecksumSha256: '9f2c'.repeat(16),
    expiresAt: pendingReceiptExpiresAt(uploadedAt),
  },
  { ...base, ...measured, state: 'ATTACHED' },
  {
    ...base,
    ...measured,
    state: 'REPLACED',
    expiresAt: retiredReceiptExpiresAt('2026-10-20T08:00:00.000Z'),
  },
  {
    ...base,
    ...measured,
    state: 'REMOVED',
    expiresAt: retiredReceiptExpiresAt('2026-10-20T08:00:00.000Z'),
  },
];

const completed: IdempotencyRecord = {
  actorId: 'sub-aisha',
  key: '5b0d6a8e-retry-key',
  fingerprint: 'ab'.repeat(32),
  outcome: 'COMPLETED',
  response: { status: 200, body: { claimId, version: 4 } },
  createdAt: '2026-10-14T10:41:00.000Z',
  expiresAt: 1_792_060_860,
};

const rejected: IdempotencyRecord = {
  ...completed,
  key: 'rejected-retry-key',
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
};

const beforeExpiry = completed.expiresAt - 60;

let client: FakeClient;
let receiptReader: DynamoDbReceiptMetadataReader;
let idempotencyReader: DynamoDbIdempotencyReader;

beforeEach(() => {
  client = new FakeClient();
  receiptReader = new DynamoDbReceiptMetadataReader({ client, tableName });
  idempotencyReader = new DynamoDbIdempotencyReader({ client, tableName });
});

it('accepts the real DynamoDB document client', () => {
  expectTypeOf<DynamoDBDocumentClient>().toExtend<GetDocumentClient>();
});

describe('receipt metadata lookup', () => {
  it('reads the receipt key strongly consistently', async () => {
    await receiptReader.get('r-7731');

    expect(client.commands).toHaveLength(1);
    expect(client.commands[0]).toBeInstanceOf(GetCommand);
    expect((client.commands[0] as GetCommand).input).toEqual({
      TableName: 'ClaimFlow',
      Key: { PK: 'RECEIPT#r-7731', SK: 'RECEIPT' },
      ConsistentRead: true,
    });
  });

  it.each(receipts.map((record) => [record.state, record] as const))(
    'decodes a %s receipt',
    async (_state, record) => {
      client.put(encodeReceiptItem(record));

      expect(await receiptReader.get('r-7731')).toEqual(record);
    },
  );

  it('returns undefined for a missing receipt', async () => {
    expect(await receiptReader.get('r-missing')).toBeUndefined();
  });

  it('propagates the integrity error for a malformed item', async () => {
    client.put({ ...encodeReceiptItem(receipts[1]!), state: 'LOST' });

    await expect(receiptReader.get('r-7731')).rejects.toBeInstanceOf(
      ItemIntegrityError,
    );
  });
});

describe('idempotency lookup', () => {
  it('reads the actor and key strongly consistently', async () => {
    await idempotencyReader.find(
      'sub-aisha',
      '5b0d6a8e-retry-key',
      beforeExpiry,
    );

    expect(client.commands).toHaveLength(1);
    expect((client.commands[0] as GetCommand).input).toEqual({
      TableName: 'ClaimFlow',
      Key: {
        PK: 'IDEMPOTENCY#sub-aisha#5b0d6a8e-retry-key',
        SK: 'IDEMPOTENCY',
      },
      ConsistentRead: true,
    });
  });

  it.each([
    ['completed', completed],
    ['rejected', rejected],
  ] as const)('decodes a %s record', async (_name, record) => {
    client.put(encodeIdempotencyItem(record));

    expect(
      await idempotencyReader.find(record.actorId, record.key, beforeExpiry),
    ).toEqual(record);
  });

  it('returns undefined for a missing record', async () => {
    expect(
      await idempotencyReader.find(
        'sub-aisha',
        'missing-retry-key',
        beforeExpiry,
      ),
    ).toBeUndefined();
  });

  it.each<[string, number, boolean]>([
    ['well before expiry', completed.expiresAt - 86_399, true],
    ['one second before expiry', completed.expiresAt - 1, true],
    ['exactly at expiry', completed.expiresAt, true],
    ['one second after expiry', completed.expiresAt + 1, false],
    ['long after expiry', completed.expiresAt + 86_400, false],
  ])(
    'treats a record read %s as present: %s',
    async (_name, nowEpoch, present) => {
      client.put(encodeIdempotencyItem(completed));

      const found = await idempotencyReader.find(
        completed.actorId,
        completed.key,
        nowEpoch,
      );

      expect(found).toEqual(present ? completed : undefined);
    },
  );

  it('propagates the integrity error for a malformed item, even if expired', async () => {
    client.put({ ...encodeIdempotencyItem(completed), outcome: 'IN_PROGRESS' });

    await expect(
      idempotencyReader.find(completed.actorId, completed.key, beforeExpiry),
    ).rejects.toBeInstanceOf(ItemIntegrityError);
    await expect(
      idempotencyReader.find(
        completed.actorId,
        completed.key,
        completed.expiresAt + 1,
      ),
    ).rejects.toBeInstanceOf(ItemIntegrityError);
  });

  it.each([-1, 1.5, Number.NaN])(
    'rejects a current time of %s without reading',
    async (nowEpoch) => {
      await expect(
        idempotencyReader.find('sub-aisha', '5b0d6a8e-retry-key', nowEpoch),
      ).rejects.toBeInstanceOf(RangeError);
      expect(client.commands).toEqual([]);
    },
  );
});

describe('AWS SDK failures', () => {
  it('propagate unchanged from both lookups', async () => {
    const failure = Object.assign(new Error('Rate exceeded'), {
      name: 'ProvisionedThroughputExceededException',
    });
    client.failure = failure;

    await expect(receiptReader.get('r-7731')).rejects.toBe(failure);
    await expect(
      idempotencyReader.find('sub-aisha', '5b0d6a8e-retry-key', beforeExpiry),
    ).rejects.toBe(failure);
  });
});

it('sends only GetCommand', async () => {
  client.put(encodeReceiptItem(receipts[0]!));
  client.put(encodeIdempotencyItem(completed));

  await receiptReader.get('r-7731');
  await receiptReader.get('r-missing');
  await idempotencyReader.find(completed.actorId, completed.key, beforeExpiry);
  await idempotencyReader.find(
    completed.actorId,
    completed.key,
    completed.expiresAt + 1,
  );

  expect(client.commands).toHaveLength(4);
  expect(
    client.commands.every((command) => command instanceof GetCommand),
  ).toBe(true);
});
