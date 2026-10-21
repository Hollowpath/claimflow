import {
  TransactWriteCommand,
  type TransactWriteCommandInput,
  type TransactWriteCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';

import {
  encodeReceiptItem,
  pendingReceiptExpiresAt,
  type PendingReceiptRecord,
} from '../src/adapters/aws/dynamodb-receipt-items.js';
import { createPendingReceiptOperation } from '../src/adapters/aws/dynamodb-receipt-operations.js';
import {
  DynamoDbReceiptUploadWriter,
  type ReceiptTransactionExecutor,
} from '../src/adapters/aws/dynamodb-receipt-upload-writer.js';
import {
  DynamoDbTransactionExecutor,
  type TransactDocumentClient,
} from '../src/adapters/aws/dynamodb-transaction-executor.js';
import { composeBusinessTransaction } from '../src/adapters/aws/dynamodb-transaction.js';
import {
  expiresAfter,
  type CommitOptions,
  type CompletedRequest,
} from '../src/application/commit.js';
import { eventSource, type OutboxEvent } from '../src/application/events.js';

const tableName = 'ClaimFlow';
const secretFileName = 'Payslip Aisha Rahman October.pdf';
const uploadedAt = '2026-10-14T10:35:00.000Z';

const pending: PendingReceiptRecord = {
  receiptId: 'r-7731',
  ownerId: 'sub-aisha',
  state: 'PENDING',
  fileName: secretFileName,
  declaredContentType: 'application/pdf',
  declaredSizeBytes: 52_144,
  declaredChecksumSha256: 'a1b2'.repeat(16),
  uploadedAt,
  expiresAt: pendingReceiptExpiresAt(uploadedAt),
};

const completed: CompletedRequest = {
  actorId: 'sub-aisha',
  key: 'upload-key-0001',
  fingerprint: 'ef'.repeat(32),
  response: { status: 201, body: { receiptId: 'r-7731' } },
  createdAt: uploadedAt,
  expiresAt: expiresAfter(new Date(uploadedAt), 24 * 60 * 60 * 1000),
};

const options: CommitOptions = { events: [], idempotency: completed };

/** Records every composed transaction it is asked to send. */
class RecordingExecutor implements ReceiptTransactionExecutor {
  public readonly inputs: TransactWriteCommandInput[] = [];
  public failure: Error | undefined;

  public execute(
    input: TransactWriteCommandInput,
  ): Promise<TransactWriteCommandOutput> {
    this.inputs.push(input);
    return this.failure === undefined
      ? Promise.resolve({ $metadata: {} })
      : Promise.reject(this.failure);
  }
}

function setup() {
  const executor = new RecordingExecutor();
  return {
    executor,
    writer: new DynamoDbReceiptUploadWriter({ executor, tableName }),
  };
}

describe('construction', () => {
  it.each([undefined, null, {}, { execute: 'send' }])(
    'rejects the executor %j',
    (executor) => {
      expect(
        () =>
          new DynamoDbReceiptUploadWriter({
            executor: executor as unknown as ReceiptTransactionExecutor,
            tableName,
          }),
      ).toThrow(new TypeError('The transaction executor is missing.'));
    },
  );

  it.each(['', undefined, 5])('rejects the table name %j', (name) => {
    expect(
      () =>
        new DynamoDbReceiptUploadWriter({
          executor: new RecordingExecutor(),
          tableName: name as unknown as string,
        }),
    ).toThrow(new TypeError('The table name is missing.'));
  });
});

describe('createPending', () => {
  it('sends the exact composed transaction', async () => {
    const { executor, writer } = setup();

    await writer.createPending(pending, options);

    expect(executor.inputs).toEqual([
      composeBusinessTransaction({
        tableName,
        businessItems: [createPendingReceiptOperation(tableName, pending)],
        events: [],
        completed,
      }),
    ]);
  });

  it('orders the pending receipt, then the idempotency record, with no outbox item', async () => {
    const { executor, writer } = setup();

    await writer.createPending(pending, options);

    const items = executor.inputs[0]!.TransactItems!;
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      Put: {
        TableName: 'ClaimFlow',
        Item: encodeReceiptItem(pending),
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    });
    expect(items[0]!.Put!.Item).toMatchObject({
      PK: 'RECEIPT#r-7731',
      SK: 'RECEIPT',
      state: 'PENDING',
    });
    expect(String(items[1]!.Put!.Item!.PK)).toMatch(/^IDEMPOTENCY#/);
    expect(JSON.stringify(items)).not.toContain('OUTBOX#');
  });

  it('keeps the deterministic request token of the composer', async () => {
    const { executor, writer } = setup();

    await writer.createPending(pending, options);
    await writer.createPending(pending, options);
    await writer.createPending({ ...pending, receiptId: 'r-7732' }, options);

    const [first, second, third] = executor.inputs.map(
      (input) => input.ClientRequestToken,
    );
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(second).toBe(first);
    expect(third).not.toBe(first);
    expect(first).toBe(
      composeBusinessTransaction({
        tableName,
        businessItems: [createPendingReceiptOperation(tableName, pending)],
        events: [],
        completed,
      }).ClientRequestToken,
    );
  });
});

describe('rejections before sending', () => {
  const event = {
    eventId: 'event-1',
    eventType: 'internal.receipt-object-deletion-requested',
    schemaVersion: 1,
    occurredAt: uploadedAt,
    source: eventSource,
  } as unknown as OutboxEvent;

  it.each([
    [
      'a missing idempotency record',
      { events: [] },
      'A receipt upload requires an idempotency record.',
    ],
    [
      'events',
      { events: [event], idempotency: completed },
      'A receipt upload publishes no events.',
    ],
    [
      'a category guard',
      {
        ...options,
        categoryGuard: {
          categoryId: 'travel',
          readVersion: 1,
          mustBeActive: true,
        },
      },
      'A receipt upload cannot carry a category guard.',
    ],
    [
      'events that are not a list',
      { idempotency: completed },
      'The commit options must list their events.',
    ],
    ['missing options', undefined, 'The commit options are missing.'],
    ['null options', null, 'The commit options are missing.'],
  ])('refuses %s', async (_name, bad, message) => {
    const { executor, writer } = setup();
    await expect(
      writer.createPending(pending, bad as unknown as CommitOptions),
    ).rejects.toThrow(new TypeError(message));
    expect(executor.inputs).toEqual([]);
  });

  it('refuses invalid pending records and idempotency data', async () => {
    const { executor, writer } = setup();
    const invalid: Promise<void>[] = [
      writer.createPending(
        { ...pending, state: 'ATTACHED' } as unknown as PendingReceiptRecord,
        options,
      ),
      writer.createPending({ ...pending, receiptId: 'not valid' }, options),
      writer.createPending({ ...pending, declaredSizeBytes: 0 }, options),
      writer.createPending(
        { ...pending, declaredContentType: 'text/html' as never },
        options,
      ),
      writer.createPending(
        { ...pending, declaredChecksumSha256: 'abc' },
        options,
      ),
      writer.createPending(
        { ...pending, expiresAt: pending.expiresAt + 1 },
        options,
      ),
      writer.createPending(pending, {
        events: [],
        idempotency: { ...completed, fingerprint: 'short' },
      }),
      writer.createPending(pending, {
        events: [],
        idempotency: { ...completed, key: '' },
      }),
    ];
    for (const promise of invalid) {
      await expect(promise).rejects.toBeInstanceOf(Error);
    }
    expect(executor.inputs).toEqual([]);
  });

  it('echoes no supplied or stored value in its own messages', async () => {
    const { writer } = setup();
    const failures = await Promise.allSettled([
      writer.createPending(pending, { events: [event] }),
      writer.createPending({ ...pending, state: 'ATTACHED' } as never, options),
    ]);
    for (const failure of failures) {
      expect(failure.status).toBe('rejected');
      expect(String((failure as PromiseRejectedResult).reason)).not.toContain(
        'Payslip',
      );
    }
  });
});

describe('through the real executor', () => {
  class FakeClient implements TransactDocumentClient {
    public readonly commands: TransactWriteCommand[] = [];
    public failure: Error | undefined;

    public send(
      command: TransactWriteCommand,
    ): Promise<TransactWriteCommandOutput> {
      this.commands.push(command);
      return this.failure === undefined
        ? Promise.resolve({ $metadata: {} })
        : Promise.reject(this.failure);
    }
  }

  const build = () => {
    const client = new FakeClient();
    return {
      client,
      writer: new DynamoDbReceiptUploadWriter({
        executor: new DynamoDbTransactionExecutor({ client }),
        tableName,
      }),
    };
  };

  it('sends exactly one TransactWriteCommand per valid write', async () => {
    const { client, writer } = build();

    await writer.createPending(pending, options);

    expect(client.commands).toHaveLength(1);
    expect(client.commands[0]).toBeInstanceOf(TransactWriteCommand);
  });

  it('propagates SDK errors unchanged, without a retry', async () => {
    const { client, writer } = build();
    const failure = Object.assign(new Error('TransactionCanceledException'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
    });
    client.failure = failure;

    await expect(writer.createPending(pending, options)).rejects.toBe(failure);
    expect(client.commands).toHaveLength(1);
  });

  it('propagates executor errors from a fake executor unchanged', async () => {
    const { executor, writer } = setup();
    const failure = new Error('IdempotentParameterMismatchException');
    executor.failure = failure;

    await expect(writer.createPending(pending, options)).rejects.toBe(failure);
    expect(executor.inputs).toHaveLength(1);
  });
});

it('exposes only the creation and preparation methods', () => {
  const { writer } = setup();
  expect(
    Object.getOwnPropertyNames(Object.getPrototypeOf(writer)).sort(),
  ).toEqual(['constructor', 'createPending', 'preparePending']);
});

describe('preparePending', () => {
  it('returns synchronously the exact transaction createPending sends, sending nothing', async () => {
    const { executor, writer } = setup();

    const prepared = writer.preparePending(pending, options);

    expect(executor.inputs).toEqual([]);
    expect(prepared).toEqual(
      composeBusinessTransaction({
        tableName,
        businessItems: [createPendingReceiptOperation(tableName, pending)],
        events: [],
        completed,
      }),
    );
    await writer.createPending(pending, options);
    expect(executor.inputs).toEqual([prepared]);
  });

  it('validates synchronously, before returning anything', () => {
    const { executor, writer } = setup();
    const bad: [PendingReceiptRecord, CommitOptions][] = [
      [{ ...pending, declaredSizeBytes: 0 }, options],
      [pending, { events: [] }],
      [pending, { ...options, events: [{} as never] }],
      [
        pending,
        {
          ...options,
          categoryGuard: {
            categoryId: 'travel',
            readVersion: 1,
            mustBeActive: true,
          },
        },
      ],
    ];
    for (const [record, commit] of bad) {
      expect(() => writer.preparePending(record, commit)).toThrow(Error);
    }
    expect(executor.inputs).toEqual([]);
  });
});

describe('result reference', () => {
  const reference: CompletedRequest = {
    ...completed,
    response: { status: 201, resultRef: { receiptId: 'r-7731' } },
  };
  const referenceOptions: CommitOptions = {
    events: [],
    idempotency: reference,
  };

  it('stores the reference with the pending receipt in one transaction', async () => {
    const { executor, writer } = setup();

    await writer.createPending(pending, referenceOptions);

    expect(executor.inputs).toEqual([
      composeBusinessTransaction({
        tableName,
        businessItems: [createPendingReceiptOperation(tableName, pending)],
        events: [],
        completed: reference,
      }),
    ]);
    const [receipt, idempotency] = executor.inputs[0]!.TransactItems!;
    expect(receipt!.Put!.Item).toEqual(encodeReceiptItem(pending));
    expect(idempotency!.Put!.Item!.response).toEqual({
      status: 201,
      resultRef: { receiptId: 'r-7731' },
    });
    expect(idempotency!.Put!.Item!.outcome).toBe('COMPLETED');
  });

  it('persists no upload URL or form field', async () => {
    const { executor, writer } = setup();

    await writer.createPending(pending, referenceOptions);

    const stored = JSON.stringify(executor.inputs[0]!.TransactItems![1]);
    for (const word of ['url', 'fields', 'policy', 'signature', 'https']) {
      expect(stored.toLowerCase()).not.toContain(word);
    }
  });

  it('has a deterministic token, different from the snapshot form', async () => {
    const { executor, writer } = setup();

    await writer.createPending(pending, referenceOptions);
    await writer.createPending(pending, referenceOptions);
    await writer.createPending(pending, options);

    const [first, second, snapshot] = executor.inputs.map(
      (input) => input.ClientRequestToken,
    );
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(first).toBe(second);
    expect(snapshot).not.toBe(first);
  });

  it.each([
    [
      'a body with the reference',
      { status: 201, resultRef: { receiptId: 'r-7731' }, body: {} },
    ],
    [
      'an unknown reference field',
      { status: 201, resultRef: { receiptId: 'r-7731', url: 'x' } },
    ],
    ['a reference without a receipt ID', { status: 201, resultRef: {} }],
    [
      'a reference with a 200 status',
      { status: 200, resultRef: { receiptId: 'r-7731' } },
    ],
  ])('refuses %s before any command', async (_name, response) => {
    const { executor, writer } = setup();

    await expect(
      writer.createPending(pending, {
        events: [],
        idempotency: { ...completed, response } as unknown as CompletedRequest,
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(executor.inputs).toEqual([]);
  });
});
