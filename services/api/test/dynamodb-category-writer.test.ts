import {
  TransactWriteCommand,
  type TransactWriteCommandInput,
  type TransactWriteCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import type { Category } from '@claimflow/domain';
import { describe, expect, it } from 'vitest';

import {
  createCategoryOperation,
  deleteCategoryOperation,
  updateCategoryOperation,
} from '../src/adapters/aws/dynamodb-category-operations.js';
import {
  DynamoDbCategoryWriter,
  type CategoryTransactionExecutor,
} from '../src/adapters/aws/dynamodb-category-writer.js';
import {
  DynamoDbTransactionExecutor,
  type TransactDocumentClient,
} from '../src/adapters/aws/dynamodb-transaction-executor.js';
import { composeBusinessTransaction } from '../src/adapters/aws/dynamodb-transaction.js';
import type {
  CommitOptions,
  CompletedRequest,
} from '../src/application/commit.js';
import {
  buildCategoryCreatedEvent,
  buildCategoryDeletedEvent,
  buildCategoryUpdateEvents,
  type CategoryEventContext,
} from '../src/application/category-events.js';

const tableName = 'ClaimFlow';

const created: Category = {
  categoryId: 'travel',
  name: 'Travel',
  active: true,
  currency: 'MYR',
  maxAmountMinor: 200_000,
  receiptRequiredAboveMinor: 20_000,
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedBy: 'sub-dan',
};
const policyChanged: Category = {
  ...created,
  maxAmountMinor: 250_000,
  version: 2,
  updatedAt: '2026-01-02T00:00:00.000Z',
  updatedBy: 'sub-erin',
};
const renamed: Category = {
  ...created,
  name: 'Travel and lodging',
  version: 2,
  updatedAt: '2026-01-02T00:00:00.000Z',
  updatedBy: 'sub-erin',
};

const context: CategoryEventContext = {
  correlationId: 'trace-1',
  causationId: 'request-1',
  actorId: 'sub-dan',
  occurredAt: '2026-01-02T00:00:00.000Z',
  storedLastEventVersion: 1,
};

const createdEvent = buildCategoryCreatedEvent(created, {
  ...context,
  storedLastEventVersion: undefined,
  eventId: 'event-created-1',
});
const updateEvents = buildCategoryUpdateEvents(created, policyChanged, {
  ...context,
  policyEventId: 'event-policy-1',
  activationEventId: 'event-activation-1',
});
const nameOnlyEvents = buildCategoryUpdateEvents(created, renamed, {
  ...context,
  policyEventId: 'event-policy-2',
  activationEventId: 'event-activation-2',
});
const deletedEvent = buildCategoryDeletedEvent(created, {
  ...context,
  eventId: 'event-deleted-1',
});

const completed: CompletedRequest = {
  actorId: 'sub-dan',
  key: 'category-key-0001',
  fingerprint: 'cd'.repeat(32),
  response: { status: 200, body: { categoryId: 'travel' } },
  createdAt: '2026-01-02T00:00:00.000Z',
  expiresAt: 1_767_398_400,
};

/** Records every composed transaction it is asked to send. */
class RecordingExecutor implements CategoryTransactionExecutor {
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
  const writer = new DynamoDbCategoryWriter({ executor, tableName });
  return { executor, writer };
}

const keysOf = (input: TransactWriteCommandInput) =>
  (input.TransactItems ?? []).map((item) => {
    const operation = Object.values(item)[0] as {
      Item?: Record<string, unknown>;
      Key?: Record<string, unknown>;
    };
    const key = operation.Item ?? operation.Key!;
    return `${Object.keys(item)[0]} ${String(key.PK)} ${String(key.SK)}`;
  });

describe('construction', () => {
  it.each([undefined, null, {}, { execute: 'send' }])(
    'rejects the executor %j',
    (executor) => {
      expect(
        () =>
          new DynamoDbCategoryWriter({
            executor: executor as unknown as CategoryTransactionExecutor,
            tableName,
          }),
      ).toThrow(new TypeError('The transaction executor is missing.'));
    },
  );

  it.each(['', undefined, 5])('rejects the table name %j', (name) => {
    expect(
      () =>
        new DynamoDbCategoryWriter({
          executor: new RecordingExecutor(),
          tableName: name as unknown as string,
        }),
    ).toThrow(new TypeError('The table name is missing.'));
  });
});

describe('create', () => {
  it('sends the composed creation transaction', async () => {
    const { executor, writer } = setup();
    const options: CommitOptions = {
      events: [createdEvent],
      idempotency: completed,
    };

    await writer.create(created, options);

    expect(executor.inputs).toEqual([
      composeBusinessTransaction({
        tableName,
        businessItems: [createCategoryOperation(tableName, created)],
        events: [createdEvent],
        completed,
      }),
    ]);
  });

  it('orders the category, then its outbox items, then the idempotency record', async () => {
    const { executor, writer } = setup();
    await writer.create(created, {
      events: [createdEvent],
      idempotency: completed,
    });

    const [input] = executor.inputs;
    expect(keysOf(input!)).toHaveLength(3);
    expect(keysOf(input!)).toEqual([
      'Put CATEGORIES CATEGORY#travel',
      `Put CATEGORIES OUTBOX#${createdEvent.occurredAt}#event-created-1`,
      expect.stringMatching(/^Put IDEMPOTENCY#/),
    ]);
  });
});

describe('update', () => {
  it('records the event version when the change publishes events', async () => {
    const { executor, writer } = setup();
    expect(updateEvents.length).toBeGreaterThan(0);

    await writer.update(policyChanged, 1, {
      events: updateEvents,
      idempotency: completed,
    });

    expect(executor.inputs).toEqual([
      composeBusinessTransaction({
        tableName,
        businessItems: [
          updateCategoryOperation(tableName, policyChanged, 1, true),
        ],
        events: updateEvents,
        completed,
      }),
    ]);
    const update = executor.inputs[0]!.TransactItems![0]!.Update!;
    expect(update.UpdateExpression).toContain('#lastEventVersion');
    expect(keysOf(executor.inputs[0]!)).toEqual([
      'Update CATEGORIES CATEGORY#travel',
      ...updateEvents.map(
        (event) => `Put CATEGORIES OUTBOX#${event.occurredAt}#${event.eventId}`,
      ),
      expect.stringMatching(/^Put IDEMPOTENCY#/),
    ]);
  });

  it('preserves lastEventVersion for a name-only change', async () => {
    const { executor, writer } = setup();
    expect(nameOnlyEvents).toEqual([]);

    await writer.update(renamed, 1, { events: [], idempotency: completed });

    expect(executor.inputs).toEqual([
      composeBusinessTransaction({
        tableName,
        businessItems: [updateCategoryOperation(tableName, renamed, 1, false)],
        events: [],
        completed,
      }),
    ]);
    const update = executor.inputs[0]!.TransactItems![0]!.Update!;
    expect(update.UpdateExpression).not.toContain('lastEventVersion');
    expect(executor.inputs[0]!.TransactItems).toHaveLength(2);
  });
});

describe('delete', () => {
  it('sends the composed deletion transaction', async () => {
    const { executor, writer } = setup();

    await writer.delete('travel', 1, {
      events: [deletedEvent],
      idempotency: completed,
    });

    expect(executor.inputs).toEqual([
      composeBusinessTransaction({
        tableName,
        businessItems: [deleteCategoryOperation(tableName, 'travel', 1)],
        events: [deletedEvent],
        completed,
      }),
    ]);
    expect(keysOf(executor.inputs[0]!)).toEqual([
      'Delete CATEGORIES CATEGORY#travel',
      `Put CATEGORIES OUTBOX#${deletedEvent.occurredAt}#event-deleted-1`,
      expect.stringMatching(/^Put IDEMPOTENCY#/),
    ]);
  });
});

describe('request token', () => {
  it('is the composer token, stable across repeats and changed by the payload', async () => {
    const { executor, writer } = setup();
    const options = { events: [createdEvent], idempotency: completed };

    await writer.create(created, options);
    await writer.create(created, options);
    await writer.create(created, {
      ...options,
      events: [{ ...createdEvent, eventId: 'event-created-2' }],
    });

    const [first, second, third] = executor.inputs.map(
      (input) => input.ClientRequestToken,
    );
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(first).toBe(second);
    expect(third).not.toBe(first);
    expect(first).toBe(
      composeBusinessTransaction({
        tableName,
        businessItems: [createCategoryOperation(tableName, created)],
        events: [createdEvent],
        completed,
      }).ClientRequestToken,
    );
  });
});

describe('rejections before sending', () => {
  const options: CommitOptions = {
    events: [createdEvent],
    idempotency: completed,
  };

  it.each([
    [
      'a missing idempotency record',
      { events: [createdEvent] },
      'A category change requires an idempotency record.',
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
      'A category change cannot carry a category guard.',
    ],
    [
      'events that are not a list',
      { idempotency: completed },
      'The commit options must list their events.',
    ],
    ['missing options', undefined, 'The commit options are missing.'],
  ])('refuses %s', async (_name, bad, message) => {
    const { executor, writer } = setup();
    const badOptions = bad as unknown as CommitOptions;

    await expect(writer.create(created, badOptions)).rejects.toThrow(
      new TypeError(message),
    );
    await expect(writer.update(renamed, 1, badOptions)).rejects.toThrow(
      new TypeError(message),
    );
    await expect(writer.delete('travel', 1, badOptions)).rejects.toThrow(
      new TypeError(message),
    );
    expect(executor.inputs).toEqual([]);
  });

  it('refuses invalid categories, versions, events and idempotency data', async () => {
    const { executor, writer } = setup();
    const invalid: Promise<void>[] = [
      writer.create({ ...created, version: 2 }, options),
      writer.create({ ...created, currency: 'ringgit' }, options),
      writer.update(renamed, 0, options),
      writer.update(renamed, 1.5, options),
      writer.update({ ...renamed, version: 5 }, 1, options),
      writer.delete('not a valid id', 1, options),
      writer.delete('travel', 0, options),
      writer.create(created, {
        events: [{ ...createdEvent, eventType: 'unknown.event' } as never],
        idempotency: completed,
      }),
      writer.create(created, {
        events: [createdEvent],
        idempotency: { ...completed, fingerprint: 'short' },
      }),
      writer.create(created, {
        events: [createdEvent],
        idempotency: { ...completed, key: '' },
      }),
    ];

    for (const promise of invalid) {
      await expect(promise).rejects.toBeInstanceOf(Error);
    }
    expect(executor.inputs).toEqual([]);
  });

  it('echoes no supplied value in its own messages', async () => {
    const { writer } = setup();
    const secret = 'Secret Travel Budget';
    const failures = await Promise.allSettled([
      writer.delete(secret, 1, { events: [], idempotency: completed }),
      writer.create(
        { ...created, name: ` ${secret}` },
        {
          events: [],
          idempotency: completed,
        },
      ),
    ]);
    for (const failure of failures) {
      expect(failure.status).toBe('rejected');
      expect(String((failure as PromiseRejectedResult).reason)).not.toContain(
        'Secret',
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
    const writer = new DynamoDbCategoryWriter({
      executor: new DynamoDbTransactionExecutor({ client }),
      tableName,
    });
    return { client, writer };
  };

  it('sends exactly one TransactWriteCommand per valid write', async () => {
    const { client, writer } = build();

    await writer.create(created, {
      events: [createdEvent],
      idempotency: completed,
    });
    await writer.update(policyChanged, 1, {
      events: updateEvents,
      idempotency: completed,
    });
    await writer.delete('travel', 1, {
      events: [deletedEvent],
      idempotency: completed,
    });

    expect(client.commands).toHaveLength(3);
    for (const command of client.commands) {
      expect(command).toBeInstanceOf(TransactWriteCommand);
    }
  });

  it('propagates SDK errors unchanged, without a retry', async () => {
    const { client, writer } = build();
    const failure = Object.assign(new Error('TransactionCanceledException'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
    });
    client.failure = failure;

    await expect(
      writer.update(policyChanged, 1, {
        events: updateEvents,
        idempotency: completed,
      }),
    ).rejects.toBe(failure);
    expect(client.commands).toHaveLength(1);
  });

  it('propagates executor errors from a fake executor unchanged', async () => {
    const { executor, writer } = setup();
    const failure = new Error('IdempotentParameterMismatchException');
    executor.failure = failure;

    await expect(
      writer.delete('travel', 1, {
        events: [deletedEvent],
        idempotency: completed,
      }),
    ).rejects.toBe(failure);
    expect(executor.inputs).toHaveLength(1);
  });
});

describe('prepare methods', () => {
  it('build exactly the transactions the sending methods send, without sending', async () => {
    const { executor, writer } = setup();
    const create: CommitOptions = {
      events: [createdEvent],
      idempotency: completed,
    };
    const update: CommitOptions = {
      events: updateEvents,
      idempotency: completed,
    };
    const remove: CommitOptions = {
      events: [deletedEvent],
      idempotency: completed,
    };

    const prepared = [
      writer.prepareCreate(created, create),
      writer.prepareUpdate(policyChanged, 1, update),
      writer.prepareDelete('travel', 1, remove),
    ];
    expect(executor.inputs).toHaveLength(0);

    await writer.create(created, create);
    await writer.update(policyChanged, 1, update);
    await writer.delete('travel', 1, remove);
    expect(executor.inputs).toEqual(prepared);
  });

  it('validate synchronously, like the sending methods', () => {
    const { writer } = setup();
    expect(() => writer.prepareCreate(created, { events: [] })).toThrow(
      'requires an idempotency record',
    );
    expect(() =>
      writer.prepareDelete('travel', 1, {
        events: [],
        idempotency: completed,
        categoryGuard: {} as never,
      }),
    ).toThrow('category guard');
  });
});
