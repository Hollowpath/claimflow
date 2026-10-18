import type { DeleteObjectCommand } from '@aws-sdk/client-s3';
import {
  type CopyObjectCommand,
  type CopyObjectCommandOutput,
  type DeleteObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  encodeReceiptItem,
  pendingReceiptExpiresAt,
  retiredReceiptExpiresAt,
  type AttachedReceiptRecord,
  type PendingReceiptRecord,
} from '../src/adapters/aws/dynamodb-receipt-items.js';
import {
  createReceiptJanitorHandler,
  type ReceiptObjectCleanup,
} from '../src/adapters/aws/receipt-janitor-handler.js';
import {
  S3ReceiptObjects,
  type ObjectS3Client,
} from '../src/adapters/aws/s3-receipt-objects.js';

const uploadedAt = '2026-10-14T10:35:00.000Z';
const secretFileName = 'Payslip Aisha Rahman October.pdf';

function pendingReceipt(id: string): PendingReceiptRecord {
  return {
    receiptId: id,
    ownerId: 'sub-aisha',
    state: 'PENDING',
    fileName: secretFileName,
    declaredContentType: 'application/pdf',
    declaredSizeBytes: 52_144,
    declaredChecksumSha256: '9f2c'.repeat(16),
    uploadedAt,
    expiresAt: pendingReceiptExpiresAt(uploadedAt),
  };
}

const attached = (id: string): AttachedReceiptRecord => ({
  receiptId: id,
  ownerId: 'sub-aisha',
  state: 'ATTACHED',
  fileName: secretFileName,
  contentType: 'application/pdf',
  sizeBytes: 52_144,
  checksumSha256: 'a1b2'.repeat(16),
  uploadedAt,
  attachedClaimId: 'claim-1',
});

type Item = Record<string, unknown>;

/** A TTL deletion record, as DynamoDB Streams delivers it. */
function removal(
  item: Item | undefined,
  sequence: string | undefined,
  overrides: Partial<DynamoDBRecord> = {},
): DynamoDBRecord {
  return {
    eventID: `id-${String(sequence)}`,
    eventName: 'REMOVE',
    eventVersion: '1.1',
    eventSource: 'aws:dynamodb',
    awsRegion: 'ap-southeast-1',
    userIdentity: { type: 'Service', principalId: 'dynamodb.amazonaws.com' },
    dynamodb: {
      ApproximateCreationDateTime: 1_792_000_000,
      Keys: marshall({ PK: item?.PK ?? 'X', SK: item?.SK ?? 'Y' }) as never,
      ...(item === undefined
        ? {}
        : {
            OldImage: marshall(item, { removeUndefinedValues: true }) as never,
          }),
      ...(sequence === undefined ? {} : { SequenceNumber: sequence }),
      SizeBytes: 512,
      StreamViewType: 'NEW_AND_OLD_IMAGES',
    },
    ...overrides,
  };
}

const ttlRemoval = (id: string, sequence: string | undefined = `seq-${id}`) =>
  removal(encodeReceiptItem(pendingReceipt(id)), sequence);

const streamEvent = (...records: DynamoDBRecord[]): DynamoDBStreamEvent => ({
  Records: records,
});

/** A recording S3 where selected keys fail. */
class FakeS3 implements ObjectS3Client {
  public readonly deletes: string[] = [];
  public failing = new Map<string, Error>();

  public send(command: CopyObjectCommand): Promise<CopyObjectCommandOutput>;
  public send(command: DeleteObjectCommand): Promise<DeleteObjectCommandOutput>;
  public send(
    command: CopyObjectCommand | DeleteObjectCommand,
  ): Promise<CopyObjectCommandOutput | DeleteObjectCommandOutput> {
    const key = (command as DeleteObjectCommand).input.Key!;
    this.deletes.push(key);
    const failure = this.failing.get(key);
    return failure === undefined
      ? Promise.resolve({ $metadata: {} } as DeleteObjectCommandOutput)
      : Promise.reject(failure);
  }
}

let s3: FakeS3;
let handler: ReturnType<typeof createReceiptJanitorHandler>;

beforeEach(() => {
  s3 = new FakeS3();
  handler = createReceiptJanitorHandler(
    new S3ReceiptObjects({ client: s3, bucketName: 'claimflow-receipts-test' }),
  );
});

const none = { batchItemFailures: [] };
const failureAt = (sequence: string) => ({
  batchItemFailures: [{ itemIdentifier: sequence }],
});

describe('valid TTL deletions', () => {
  it('deletes both the final and the pending object', async () => {
    expect(await handler(streamEvent(ttlRemoval('r-7731')))).toEqual(none);

    expect(s3.deletes.sort()).toEqual([
      'receipts/r-7731',
      'uploads/pending/r-7731',
    ]);
  });

  it('cleans every record in a batch', async () => {
    await handler(
      streamEvent(ttlRemoval('r-1'), ttlRemoval('r-2'), ttlRemoval('r-3')),
    );

    expect(s3.deletes.sort()).toEqual(
      ['r-1', 'r-2', 'r-3']
        .flatMap((id) => [`receipts/${id}`, `uploads/pending/${id}`])
        .sort(),
    );
  });

  it('is idempotent: a retry of the same record succeeds again', async () => {
    const record = ttlRemoval('r-7731');

    expect(await handler(streamEvent(record))).toEqual(none);
    expect(await handler(streamEvent(record))).toEqual(none);
    expect(s3.deletes).toHaveLength(4);
  });

  it('uses the S3 receipt operations, not its own keys', async () => {
    const calls: string[] = [];
    const cleanup: ReceiptObjectCleanup = {
      deleteFinal: (id) => Promise.resolve(void calls.push(`final:${id}`)),
      deletePending: (id) => Promise.resolve(void calls.push(`pending:${id}`)),
    };

    await createReceiptJanitorHandler(cleanup)(
      streamEvent(ttlRemoval('r-7731')),
    );

    expect(calls.sort()).toEqual(['final:r-7731', 'pending:r-7731']);
  });
});

describe('records outside the filter', () => {
  const item = encodeReceiptItem(pendingReceipt('r-7731'));

  it.each<[string, DynamoDBRecord]>([
    ['an insert', removal(item, 'seq-1', { eventName: 'INSERT' })],
    ['a modify', removal(item, 'seq-1', { eventName: 'MODIFY' })],
    [
      'a removal by a user',
      removal(item, 'seq-1', { userIdentity: undefined }),
    ],
    [
      'a removal by another service type',
      removal(item, 'seq-1', {
        userIdentity: {
          type: 'Application',
          principalId: 'dynamodb.amazonaws.com',
        },
      }),
    ],
    [
      'a removal by another service principal',
      removal(item, 'seq-1', {
        userIdentity: { type: 'Service', principalId: 'lambda.amazonaws.com' },
      }),
    ],
    [
      'a removal with an empty identity',
      removal(item, 'seq-1', { userIdentity: {} }),
    ],
  ])('ignores %s, even without a sequence number', async (_name, record) => {
    const noSequence = {
      ...record,
      dynamodb: { ...record.dynamodb, SequenceNumber: undefined },
    };

    expect(await handler(streamEvent(record, noSequence))).toEqual(none);
    expect(s3.deletes).toEqual([]);
  });

  it('ignores removals of other entities and of receipts that are not pending', async () => {
    const records = [
      removal(
        { PK: 'CLAIM#c-1', SK: 'CLAIM', entityType: 'Claim', state: 'PENDING' },
        'seq-1',
      ),
      removal(
        {
          PK: 'IDEMPOTENCY#a#k',
          SK: 'IDEMPOTENCY',
          entityType: 'IdempotencyRecord',
        },
        'seq-2',
      ),
      removal(
        {
          PK: 'CLAIM#c-1',
          SK: 'OUTBOX#2026-10-14T10:41:00.000Z#e',
          entityType: 'OutboxEvent',
          state: 'PUBLISHED',
        },
        'seq-3',
      ),
      removal(encodeReceiptItem(attached('r-1')), 'seq-4'),
      removal(
        {
          ...encodeReceiptItem(attached('r-2')),
          state: 'REMOVED',
          expiresAt: retiredReceiptExpiresAt('2026-10-20T08:00:00.000Z'),
        },
        'seq-5',
      ),
    ];

    expect(await handler(streamEvent(...records))).toEqual(none);
    expect(s3.deletes).toEqual([]);
  });

  it('handles an empty event', async () => {
    expect(await handler(streamEvent())).toEqual(none);
    expect(await handler({} as DynamoDBStreamEvent)).toEqual(none);
  });
});

describe('malformed candidates', () => {
  const good = () => encodeReceiptItem(pendingReceipt('r-7731'));

  it.each<[string, Item]>([
    ['a wrong key', { ...good(), PK: 'RECEIPT#other' }],
    [
      'a pending object key of a final receipt',
      { ...good(), objectKey: 'receipts/r-7731' },
    ],
    ['a wrong TTL', { ...good(), expiresAt: 1 }],
    ['an unsanitized file name', { ...good(), fileName: '../x.pdf' }],
    ['a missing declaration', { ...good(), declaredSizeBytes: undefined }],
    ['an index attribute', { ...good(), GSI1PK: 'x' }],
    ['an unexpected attribute', { ...good(), extra: 1 }],
    [
      'a receipt ID with a path',
      { ...good(), receiptId: '../r-1', PK: 'RECEIPT#../r-1' },
    ],
  ])(
    'fails the record with %s and deletes nothing for it',
    async (_name, item) => {
      const response = await handler(
        streamEvent(removal(item, 'seq-1'), ttlRemoval('r-9', 'seq-2')),
      );

      expect(response).toEqual(failureAt('seq-1'));
      expect(s3.deletes.sort()).toEqual([
        'receipts/r-9',
        'uploads/pending/r-9',
      ]);
    },
  );

  it('fails a record whose old image is missing', async () => {
    expect(await handler(streamEvent(removal(undefined, 'seq-1')))).toEqual(
      failureAt('seq-1'),
    );
    expect(s3.deletes).toEqual([]);
  });

  it('fails a record whose old image cannot be unmarshalled', async () => {
    const record = removal(good(), 'seq-1');
    record.dynamodb!.OldImage = { PK: { Q: 'x' } } as never;

    expect(await handler(streamEvent(record))).toEqual(failureAt('seq-1'));
  });
});

describe('missing sequence numbers', () => {
  it.each([undefined, ''])(
    'throws for a candidate with sequence %j, deleting nothing',
    async (sequence) => {
      await expect(
        handler(
          streamEvent(
            ttlRemoval('r-1'),
            removal(encodeReceiptItem(pendingReceipt('r-2')), sequence),
          ),
        ),
      ).rejects.toThrow('no sequence number');
      expect(s3.deletes).toEqual([]);
    },
  );
});

describe('deletion failures', () => {
  const failure = Object.assign(new Error('Access denied for r-7731'), {
    name: 'AccessDenied',
  });

  it.each([
    ['the final object', 'receipts/r-7731'],
    ['the pending object', 'uploads/pending/r-7731'],
  ])(
    'still attempts both deletions when %s fails, and fails the record',
    async (_name, key) => {
      s3.failing.set(key, failure);

      expect(await handler(streamEvent(ttlRemoval('r-7731')))).toEqual(
        failureAt('seq-r-7731'),
      );
      expect(s3.deletes.sort()).toEqual([
        'receipts/r-7731',
        'uploads/pending/r-7731',
      ]);
    },
  );

  it('fails the record when both deletions fail', async () => {
    s3.failing.set('receipts/r-7731', failure);
    s3.failing.set('uploads/pending/r-7731', failure);

    expect(await handler(streamEvent(ttlRemoval('r-7731')))).toEqual(
      failureAt('seq-r-7731'),
    );
    expect(s3.deletes).toHaveLength(2);
  });

  it('attempts both deletions even if one throws synchronously', async () => {
    const calls: string[] = [];
    const cleanup: ReceiptObjectCleanup = {
      deleteFinal: () => {
        throw new Error('sync failure');
      },
      deletePending: (id) => Promise.resolve(void calls.push(id)),
    };

    expect(
      await createReceiptJanitorHandler(cleanup)(
        streamEvent(ttlRemoval('r-1')),
      ),
    ).toEqual(failureAt('seq-r-1'));
    expect(calls).toEqual(['r-1']);
  });

  it('keeps processing other records after one fails', async () => {
    s3.failing.set('receipts/r-2', failure);

    await handler(
      streamEvent(ttlRemoval('r-1'), ttlRemoval('r-2'), ttlRemoval('r-3')),
    );

    expect(s3.deletes.sort()).toEqual(
      ['r-1', 'r-2', 'r-3']
        .flatMap((id) => [`receipts/${id}`, `uploads/pending/${id}`])
        .sort(),
    );
  });

  it('reports the first failure in stream order', async () => {
    s3.failing.set('receipts/r-3', failure);
    s3.failing.set('uploads/pending/r-1', failure);
    const bad = removal(
      { ...encodeReceiptItem(pendingReceipt('r-2')), expiresAt: 1 },
      'seq-r-2',
    );

    const response = await handler(
      streamEvent(ttlRemoval('r-1'), bad, ttlRemoval('r-3')),
    );

    expect(response).toEqual(failureAt('seq-r-1'));
    expect(response.batchItemFailures).toHaveLength(1);
  });

  it('reports a later failure when earlier records succeed', async () => {
    s3.failing.set('receipts/r-3', failure);

    expect(
      await handler(
        streamEvent(ttlRemoval('r-1'), ttlRemoval('r-2'), ttlRemoval('r-3')),
      ),
    ).toEqual(failureAt('seq-r-3'));
  });
});

describe('safety', () => {
  it('uses a fixed message for the only thrown error, naming no values', async () => {
    const error = await handler(
      streamEvent(
        removal(encodeReceiptItem(pendingReceipt('r-secret')), undefined),
      ),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).not.toContain('secret');
    expect(String(error)).not.toContain('receipts/');
  });

  it('puts only the sequence number in the response', async () => {
    s3.failing.set('receipts/r-secret', new Error('Payslip r-secret'));

    const response = await handler(streamEvent(ttlRemoval('r-secret')));

    expect(JSON.stringify(response)).toBe(
      '{"batchItemFailures":[{"itemIdentifier":"seq-r-secret"}]}',
    );
  });
});
