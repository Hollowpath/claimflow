import {
  TransactWriteCommand,
  type TransactWriteCommandInput,
  type TransactWriteCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import type { Claim, ClaimChange } from '@claimflow/domain';
import { describe, expect, it } from 'vitest';

import {
  categoryGuardCheckOperation,
  claimCountDecrementCondition,
  decrementClaimCountOperation,
  incrementClaimCountOperation,
} from '../src/adapters/aws/dynamodb-category-operations.js';
import {
  claimManagerCondition,
  claimOwnerCondition,
  claimVersionCondition,
  createClaimOperations,
  deleteDraftOperation,
  draftDeleteCondition,
  updateClaimOperations,
} from '../src/adapters/aws/dynamodb-claim-operations.js';
import {
  DynamoDbClaimWriter,
  type ClaimTransactionExecutor,
  type DeleteDraftInput,
  type RemoveReceiptInput,
  type ReplaceReceiptInput,
} from '../src/adapters/aws/dynamodb-claim-writer.js';
import {
  DynamoDbTransactionExecutor,
  type TransactDocumentClient,
} from '../src/adapters/aws/dynamodb-transaction-executor.js';
import { composeBusinessTransaction } from '../src/adapters/aws/dynamodb-transaction.js';
import {
  pendingReceiptExpiresAt,
  retiredReceiptExpiresAt,
  type AttachedReceiptRecord,
  type PendingReceiptRecord,
  type RetiredReceiptRecord,
} from '../src/adapters/aws/dynamodb-receipt-items.js';
import {
  attachReceiptOperation,
  receiptAttachCondition,
  receiptRetireCondition,
  retireReceiptOperation,
} from '../src/adapters/aws/dynamodb-receipt-operations.js';
import {
  buildHistoryPurgeEvent,
  buildReceiptDeletionEvent,
} from '../src/application/cleanup-events.js';
import {
  buildClaimLifecycleEvent,
  type ClaimEventIds,
} from '../src/application/claim-events.js';
import type {
  CategoryGuard,
  CommitOptions,
  CompletedRequest,
} from '../src/application/commit.js';

const tableName = 'ClaimFlow';
const claimId = '4ce0c74b-9c64-46d6-87ba-07fb71b0628c';
const createdAt = '2026-10-14T10:30:00.000Z';

const categorized: ClaimChange = {
  claim: {
    claimId,
    employeeId: 'sub-aisha',
    categoryId: 'travel',
    amount: { amountMinor: 45_000, currency: 'MYR' },
    merchant: 'Confidential Supplier Sdn Bhd',
    status: 'DRAFT',
    version: 1,
    createdAt,
    updatedAt: createdAt,
  },
  history: {
    claimId,
    version: 1,
    action: 'CREATE',
    toStatus: 'DRAFT',
    actorId: 'sub-aisha',
    occurredAt: createdAt,
  },
};
const { categoryId: _omitted, ...uncategorizedClaim } = categorized.claim;
const uncategorized: ClaimChange = {
  ...categorized,
  claim: uncategorizedClaim,
};

const guard: CategoryGuard = {
  categoryId: 'travel',
  readVersion: 3,
  mustBeActive: true,
};
const completed: CompletedRequest = {
  actorId: 'sub-aisha',
  key: 'claim-key-0001',
  fingerprint: 'ab'.repeat(32),
  response: { status: 201, body: { claimId } },
  createdAt,
  expiresAt: 1_792_060_200,
};
const withGuard: CommitOptions = {
  events: [],
  idempotency: completed,
  categoryGuard: guard,
};
const withoutGuard: CommitOptions = { events: [], idempotency: completed };

/** Records every composed transaction it is asked to send. */
class RecordingExecutor implements ClaimTransactionExecutor {
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
  const writer = new DynamoDbClaimWriter({ executor, tableName });
  return { executor, writer };
}

/**
 * Preparation builds the transaction the write method sends, deterministically
 * and without executing anything, and refuses invalid input synchronously.
 */
async function expectPreparation(
  executor: RecordingExecutor,
  prepare: () => TransactWriteCommandInput,
  write: () => Promise<void>,
  invalid: () => TransactWriteCommandInput,
): Promise<void> {
  const prepared = prepare();
  expect(executor.inputs).toEqual([]);
  expect(prepare()).toEqual(prepared);
  expect(prepared.ClientRequestToken).toMatch(/^[0-9a-f]{32}$/);

  await write();
  expect(executor.inputs).toEqual([prepared]);

  expect(invalid).toThrow(TypeError);
  expect(executor.inputs).toHaveLength(1);
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
          new DynamoDbClaimWriter({
            executor: executor as unknown as ClaimTransactionExecutor,
            tableName,
          }),
      ).toThrow(new TypeError('The transaction executor is missing.'));
    },
  );

  it.each(['', undefined, 5])('rejects the table name %j', (name) => {
    expect(
      () =>
        new DynamoDbClaimWriter({
          executor: new RecordingExecutor(),
          tableName: name as unknown as string,
        }),
    ).toThrow(new TypeError('The table name is missing.'));
  });

  it('exposes only the creation, draft-edit, lifecycle, submission, receipt, and deletion methods', () => {
    const { writer } = setup();
    expect(Object.getOwnPropertyNames(DynamoDbClaimWriter.prototype)).toEqual([
      'constructor',
      'create',
      'prepareCreate',
      'updateDraft',
      'prepareUpdateDraft',
      'updateLifecycle',
      'prepareUpdateLifecycle',
      'submit',
      'prepareSubmit',
      'attachReceipt',
      'prepareAttachReceipt',
      'replaceReceipt',
      'prepareReplaceReceipt',
      'removeReceipt',
      'prepareRemoveReceipt',
      'deleteDraft',
      'prepareDeleteDraft',
    ]);
    expect(typeof writer.create).toBe('function');
    expect(typeof writer.updateDraft).toBe('function');
    expect(typeof writer.updateLifecycle).toBe('function');
    expect(typeof writer.submit).toBe('function');
    expect(typeof writer.attachReceipt).toBe('function');
    expect(typeof writer.replaceReceipt).toBe('function');
    expect(typeof writer.removeReceipt).toBe('function');
    expect(typeof writer.deleteDraft).toBe('function');
  });
});

describe('create', () => {
  it('prepares the transaction it sends, without executing', async () => {
    const { executor, writer } = setup();
    await expectPreparation(
      executor,
      () => writer.prepareCreate(categorized, withGuard),
      () => writer.create(categorized, withGuard),
      () => writer.prepareCreate(categorized, undefined as never),
    );
  });

  it('commits a categorized claim with the guarded counter increment', async () => {
    const { executor, writer } = setup();

    await writer.create(categorized, withGuard);

    expect(executor.inputs).toEqual([
      composeBusinessTransaction({
        tableName,
        businessItems: [
          ...createClaimOperations(tableName, categorized),
          incrementClaimCountOperation(tableName, guard),
        ],
        events: [],
        completed,
      }),
    ]);
    expect(keysOf(executor.inputs[0]!)).toEqual([
      `Put CLAIM#${claimId} CLAIM`,
      `Put CLAIM#${claimId} HISTORY#0000000001`,
      'Update CATEGORIES CATEGORY#travel',
      expect.stringMatching(/^Put IDEMPOTENCY#/),
    ]);
    const items = executor.inputs[0]!.TransactItems!;
    expect(items.some((item) => item.ConditionCheck !== undefined)).toBe(false);
    expect(items[2]!.Update!.ExpressionAttributeValues).toMatchObject({
      ':readVersion': 3,
      ':true': true,
    });
  });

  it('commits an uncategorized claim without a counter operation', async () => {
    const { executor, writer } = setup();

    await writer.create(uncategorized, withoutGuard);

    expect(executor.inputs).toEqual([
      composeBusinessTransaction({
        tableName,
        businessItems: createClaimOperations(tableName, uncategorized),
        events: [],
        completed,
      }),
    ]);
    expect(keysOf(executor.inputs[0]!)).toEqual([
      `Put CLAIM#${claimId} CLAIM`,
      `Put CLAIM#${claimId} HISTORY#0000000001`,
      expect.stringMatching(/^Put IDEMPOTENCY#/),
    ]);
  });
});

describe('request token', () => {
  it('is the composer token, stable across repeats and changed by the payload', async () => {
    const { executor, writer } = setup();

    await writer.create(categorized, withGuard);
    await writer.create(categorized, withGuard);
    await writer.create(categorized, {
      ...withGuard,
      categoryGuard: { ...guard, readVersion: 4 },
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
        businessItems: [
          ...createClaimOperations(tableName, categorized),
          incrementClaimCountOperation(tableName, guard),
        ],
        events: [],
        completed,
      }).ClientRequestToken,
    );
  });
});

describe('rejections before sending', () => {
  it.each([
    [
      'missing options',
      categorized,
      undefined,
      'The commit options are missing.',
    ],
    [
      'events that are not a list',
      categorized,
      { idempotency: completed, categoryGuard: guard },
      'The commit options must list their events.',
    ],
    [
      'an event',
      categorized,
      { ...withGuard, events: [{}] },
      'Creating a claim publishes no events.',
    ],
    [
      'a missing idempotency record',
      categorized,
      { events: [], categoryGuard: guard },
      'Creating a claim requires an idempotency record.',
    ],
    [
      'a categorized claim without a guard',
      categorized,
      withoutGuard,
      'A categorized claim requires a category guard.',
    ],
    [
      'an uncategorized claim with a guard',
      uncategorized,
      withGuard,
      'An uncategorized claim cannot carry a category guard.',
    ],
    [
      'a guard for another category',
      categorized,
      { ...withGuard, categoryGuard: { ...guard, categoryId: 'meals' } },
      'The category guard does not match the claim.',
    ],
    [
      'a guard that allows an inactive category',
      categorized,
      { ...withGuard, categoryGuard: { ...guard, mustBeActive: false } },
      'The category guard must require an active category.',
    ],
    ['a missing change', undefined, withGuard, 'The claim change is missing.'],
  ])('refuses %s', async (_name, change, options, message) => {
    const { executor, writer } = setup();

    await expect(
      writer.create(
        change as unknown as ClaimChange,
        options as unknown as CommitOptions,
      ),
    ).rejects.toThrow(new TypeError(message));
    expect(executor.inputs).toEqual([]);
  });

  it('refuses invalid claims, history, guards and idempotency data', async () => {
    const { executor, writer } = setup();
    const invalid: Promise<void>[] = [
      writer.create(
        { ...categorized, claim: { ...categorized.claim, version: 2 } },
        withGuard,
      ),
      writer.create(
        {
          ...categorized,
          claim: { ...categorized.claim, status: 'SUBMITTED' },
        },
        withGuard,
      ),
      writer.create(
        {
          ...categorized,
          history: { ...categorized.history, action: 'UPDATE' },
        },
        withGuard,
      ),
      writer.create(
        {
          ...categorized,
          history: { ...categorized.history, claimId: 'other' },
        },
        withGuard,
      ),
      writer.create(categorized, {
        ...withGuard,
        categoryGuard: { ...guard, readVersion: 0 },
      }),
      writer.create(categorized, {
        ...withGuard,
        idempotency: { ...completed, fingerprint: 'short' },
      }),
      writer.create(categorized, {
        ...withGuard,
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
      writer.create(categorized, {
        ...withGuard,
        categoryGuard: { ...guard, categoryId: secret },
      }),
      writer.create(
        {
          ...categorized,
          claim: { ...categorized.claim, merchant: secret, version: 2 },
        },
        withGuard,
      ),
    ]);
    for (const failure of failures) {
      expect(failure.status).toBe('rejected');
      const message = String((failure as PromiseRejectedResult).reason);
      expect(message).not.toContain('Secret');
      expect(message).not.toContain('Confidential');
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
    const writer = new DynamoDbClaimWriter({
      executor: new DynamoDbTransactionExecutor({ client }),
      tableName,
    });
    return { client, writer };
  };

  it('sends exactly one TransactWriteCommand per valid write', async () => {
    const { client, writer } = build();

    await writer.create(categorized, withGuard);
    await writer.create(uncategorized, withoutGuard);

    expect(client.commands).toHaveLength(2);
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

    await expect(writer.create(categorized, withGuard)).rejects.toBe(failure);
    expect(client.commands).toHaveLength(1);
  });

  it('propagates executor errors from a fake executor unchanged', async () => {
    const { executor, writer } = setup();
    const failure = new Error('IdempotentParameterMismatchException');
    executor.failure = failure;

    await expect(writer.create(uncategorized, withoutGuard)).rejects.toBe(
      failure,
    );
    expect(executor.inputs).toHaveLength(1);
  });
});

describe('updateDraft', () => {
  const editedAt = '2026-10-14T11:00:00.000Z';
  const base = categorized.claim;
  const previous: Claim = { ...base };
  const uncategorizedPrevious: Claim = uncategorized.claim;
  const edited = (patch: Partial<Claim>): Claim => ({
    ...base,
    merchant: 'Regional Airline',
    version: 2,
    updatedAt: editedAt,
    ...patch,
  });
  const withoutCategory = (claim: Claim): Claim => {
    const { categoryId: _c, ...rest } = claim;
    return rest;
  };
  const changeOf = (claim: Claim): ClaimChange => ({
    claim,
    history: {
      claimId,
      version: 2,
      action: 'UPDATE',
      fromStatus: 'DRAFT',
      toStatus: 'DRAFT',
      actorId: 'sub-aisha',
      occurredAt: editedAt,
    },
  });
  const mealsGuard: CategoryGuard = {
    categoryId: 'meals',
    readVersion: 5,
    mustBeActive: true,
  };
  const keep = changeOf(edited({}));
  const removing = changeOf(withoutCategory(edited({})));
  const adding = changeOf(
    edited({ categoryId: 'meals', employeeId: 'sub-aisha' }),
  );
  const switching = adding;

  it('leaves the counters alone when the category is unchanged', async () => {
    const { executor, writer } = setup();

    await writer.updateDraft(previous, keep, undefined, withoutGuard);

    expect(executor.inputs).toEqual([
      composeBusinessTransaction({
        tableName,
        businessItems: updateClaimOperations(tableName, keep, 1, undefined),
        events: [],
        completed,
      }),
    ]);
    expect(keysOf(executor.inputs[0]!)).toEqual([
      `Update CLAIM#${claimId} CLAIM`,
      `Put CLAIM#${claimId} HISTORY#0000000002`,
      expect.stringMatching(/^Put IDEMPOTENCY#/),
    ]);
  });

  it('leaves an uncategorized draft uncategorized without counters', async () => {
    const { executor, writer } = setup();
    const change = changeOf(withoutCategory(edited({})));

    await writer.updateDraft(
      uncategorizedPrevious,
      change,
      undefined,
      withoutGuard,
    );

    expect(keysOf(executor.inputs[0]!)).toHaveLength(3);
  });

  it('adds a category with a guarded increment', async () => {
    const { executor, writer } = setup();

    await writer.updateDraft(uncategorizedPrevious, adding, undefined, {
      ...withoutGuard,
      categoryGuard: mealsGuard,
    });

    expect(executor.inputs).toEqual([
      composeBusinessTransaction({
        tableName,
        businessItems: [
          ...updateClaimOperations(tableName, adding, 1, undefined),
          incrementClaimCountOperation(tableName, mealsGuard),
        ],
        events: [],
        completed,
      }),
    ]);
    expect(keysOf(executor.inputs[0]!)).toEqual([
      `Update CLAIM#${claimId} CLAIM`,
      `Put CLAIM#${claimId} HISTORY#0000000002`,
      'Update CATEGORIES CATEGORY#meals',
      expect.stringMatching(/^Put IDEMPOTENCY#/),
    ]);
  });

  it('removes a category with an unguarded decrement', async () => {
    const { executor, writer } = setup();

    await writer.updateDraft(previous, removing, undefined, withoutGuard);

    expect(executor.inputs).toEqual([
      composeBusinessTransaction({
        tableName,
        businessItems: [
          ...updateClaimOperations(tableName, removing, 1, undefined),
          decrementClaimCountOperation(tableName, 'travel'),
        ],
        events: [],
        completed,
      }),
    ]);
    expect(keysOf(executor.inputs[0]!)[2]).toBe(
      'Update CATEGORIES CATEGORY#travel',
    );
  });

  it('switches categories: decrement the old, then guarded increment the new', async () => {
    const { executor, writer } = setup();

    await writer.updateDraft(previous, switching, undefined, {
      ...withoutGuard,
      categoryGuard: mealsGuard,
    });

    expect(executor.inputs).toEqual([
      composeBusinessTransaction({
        tableName,
        businessItems: [
          ...updateClaimOperations(tableName, switching, 1, undefined),
          decrementClaimCountOperation(tableName, 'travel'),
          incrementClaimCountOperation(tableName, mealsGuard),
        ],
        events: [],
        completed,
      }),
    ]);
    const items = executor.inputs[0]!.TransactItems!;
    expect(keysOf(executor.inputs[0]!)).toEqual([
      `Update CLAIM#${claimId} CLAIM`,
      `Put CLAIM#${claimId} HISTORY#0000000002`,
      'Update CATEGORIES CATEGORY#travel',
      'Update CATEGORIES CATEGORY#meals',
      expect.stringMatching(/^Put IDEMPOTENCY#/),
    ]);
    expect(items.some((item) => item.ConditionCheck !== undefined)).toBe(false);
    expect(items[2]!.Update!.ExpressionAttributeValues).toMatchObject({
      ':minusOne': -1,
    });
    expect(items[3]!.Update!.ExpressionAttributeValues).toMatchObject({
      ':readVersion': 5,
      ':true': true,
    });
  });

  it('expects the previous version and keeps the stored event version', async () => {
    const { executor, writer } = setup();
    const later: Claim = { ...previous, version: 4 };
    const change: ClaimChange = {
      claim: edited({ version: 5 }),
      history: { ...keep.history, version: 5 },
    };

    await writer.updateDraft(later, change, 3, withoutGuard);

    const update = executor.inputs[0]!.TransactItems![0]!.Update!;
    expect(update.ExpressionAttributeValues).toMatchObject({
      ':expectedVersion': 4,
      ':lastEventVersion': 3,
    });
    expect(executor.inputs[0]).toEqual(
      composeBusinessTransaction({
        tableName,
        businessItems: updateClaimOperations(tableName, change, 4, 3),
        events: [],
        completed,
      }),
    );
  });

  it('has a deterministic token changed by the payload', async () => {
    const { executor, writer } = setup();
    const options = { ...withoutGuard, categoryGuard: mealsGuard };

    await writer.updateDraft(previous, switching, undefined, options);
    await writer.updateDraft(previous, switching, undefined, options);
    await writer.updateDraft(previous, switching, undefined, {
      ...options,
      categoryGuard: { ...mealsGuard, readVersion: 6 },
    });

    const [first, second, third] = executor.inputs.map(
      (input) => input.ClientRequestToken,
    );
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(first).toBe(second);
    expect(third).not.toBe(first);
  });

  it.each([
    [
      'missing options',
      previous,
      keep,
      undefined,
      'The commit options are missing.',
    ],
    [
      'events that are not a list',
      previous,
      keep,
      { idempotency: completed },
      'The commit options must list their events.',
    ],
    [
      'an event',
      previous,
      keep,
      { ...withoutGuard, events: [{}] },
      'Editing a draft publishes no events.',
    ],
    [
      'a missing idempotency record',
      previous,
      keep,
      { events: [] },
      'Editing a draft requires an idempotency record.',
    ],
    [
      'a missing previous claim',
      undefined,
      keep,
      withoutGuard,
      'The previous claim is missing.',
    ],
    [
      'a missing change',
      previous,
      undefined,
      withoutGuard,
      'The claim change is missing.',
    ],
    [
      'a non-UPDATE action',
      previous,
      { ...keep, history: { ...keep.history, action: 'ATTACH_RECEIPT' } },
      withoutGuard,
      'Only a draft edit can be written.',
    ],
    [
      'a submitted new claim',
      previous,
      { ...keep, claim: { ...keep.claim, status: 'SUBMITTED' } },
      withoutGuard,
      'Only a draft can be edited.',
    ],
    [
      'a submitted previous claim',
      { ...previous, status: 'SUBMITTED' },
      keep,
      withoutGuard,
      'Only a draft can be edited.',
    ],
    [
      'another claim ID',
      previous,
      {
        claim: { ...keep.claim, claimId: 'other-claim' },
        history: { ...keep.history, claimId: 'other-claim' },
      },
      withoutGuard,
      'The edited claim does not match the previous claim.',
    ],
    [
      'another owner',
      previous,
      { ...keep, claim: { ...keep.claim, employeeId: 'sub-ben' } },
      withoutGuard,
      'The edited claim does not match the previous claim.',
    ],
    [
      'a guard for an unchanged category',
      previous,
      keep,
      { ...withoutGuard, categoryGuard: guard },
      'A category guard is only allowed when entering a different category.',
    ],
    [
      'a guard when removing a category',
      previous,
      removing,
      { ...withoutGuard, categoryGuard: guard },
      'A category guard is only allowed when entering a different category.',
    ],
    [
      'a missing guard when entering a category',
      previous,
      switching,
      withoutGuard,
      'Entering a different category requires a category guard.',
    ],
    [
      'a guard for another category',
      previous,
      switching,
      { ...withoutGuard, categoryGuard: guard },
      'The category guard does not match the claim.',
    ],
    [
      'a guard that allows an inactive category',
      previous,
      switching,
      {
        ...withoutGuard,
        categoryGuard: { ...mealsGuard, mustBeActive: false },
      },
      'The category guard must require an active category.',
    ],
  ])('refuses %s', async (_name, prior, change, options, message) => {
    const { executor, writer } = setup();

    await expect(
      writer.updateDraft(
        prior as unknown as Claim,
        change as unknown as ClaimChange,
        undefined,
        options as unknown as CommitOptions,
      ),
    ).rejects.toThrow(new TypeError(message));
    expect(executor.inputs).toEqual([]);
  });

  it('refuses invalid claims, versions, history and idempotency data', async () => {
    const { executor, writer } = setup();
    const invalid: Promise<void>[] = [
      writer.updateDraft(
        { ...previous, version: 0 },
        keep,
        undefined,
        withoutGuard,
      ),
      writer.updateDraft(previous, keep, 5, withoutGuard),
      writer.updateDraft(previous, keep, -1, withoutGuard),
      writer.updateDraft(
        previous,
        { ...keep, claim: { ...keep.claim, version: 3 } },
        undefined,
        withoutGuard,
      ),
      writer.updateDraft(
        previous,
        { ...keep, history: { ...keep.history, version: 3 } },
        undefined,
        withoutGuard,
      ),
      writer.updateDraft(
        previous,
        { ...keep, history: { ...keep.history, toStatus: 'SUBMITTED' } },
        undefined,
        withoutGuard,
      ),
      writer.updateDraft(previous, switching, undefined, {
        ...withoutGuard,
        categoryGuard: { ...mealsGuard, readVersion: 0 },
      }),
      writer.updateDraft(previous, keep, undefined, {
        ...withoutGuard,
        idempotency: { ...completed, fingerprint: 'short' },
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
      writer.updateDraft(previous, switching, undefined, {
        ...withoutGuard,
        categoryGuard: { ...mealsGuard, categoryId: secret },
      }),
      writer.updateDraft(
        { ...previous, merchant: secret, version: 0 },
        keep,
        undefined,
        withoutGuard,
      ),
    ]);
    for (const failure of failures) {
      expect(failure.status).toBe('rejected');
      const message = String((failure as PromiseRejectedResult).reason);
      expect(message).not.toContain('Secret');
      expect(message).not.toContain('Confidential');
    }
  });

  it('prepares the transaction it sends, without executing', async () => {
    const { executor, writer } = setup();
    const options = { ...withoutGuard, categoryGuard: mealsGuard };
    await expectPreparation(
      executor,
      () => writer.prepareUpdateDraft(previous, switching, undefined, options),
      () => writer.updateDraft(previous, switching, undefined, options),
      () =>
        writer.prepareUpdateDraft(
          previous,
          switching,
          undefined,
          undefined as never,
        ),
    );
  });

  it('sends one command and propagates errors unchanged', async () => {
    const client = {
      commands: [] as TransactWriteCommand[],
      failure: undefined as Error | undefined,
      send(command: TransactWriteCommand) {
        this.commands.push(command);
        return this.failure === undefined
          ? Promise.resolve({ $metadata: {} } as TransactWriteCommandOutput)
          : Promise.reject(this.failure);
      },
    };
    const writer = new DynamoDbClaimWriter({
      executor: new DynamoDbTransactionExecutor({ client }),
      tableName,
    });

    await writer.updateDraft(previous, keep, undefined, withoutGuard);
    expect(client.commands).toHaveLength(1);
    expect(client.commands[0]).toBeInstanceOf(TransactWriteCommand);

    const failure = Object.assign(new Error('TransactionCanceledException'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
    });
    client.failure = failure;
    await expect(
      writer.updateDraft(previous, switching, undefined, {
        ...withoutGuard,
        categoryGuard: mealsGuard,
      }),
    ).rejects.toBe(failure);
    expect(client.commands).toHaveLength(2);

    const { executor, writer: fake } = setup();
    const executorFailure = new Error('IdempotentParameterMismatchException');
    executor.failure = executorFailure;
    await expect(
      fake.updateDraft(previous, keep, undefined, withoutGuard),
    ).rejects.toBe(executorFailure);
    expect(executor.inputs).toHaveLength(1);
  });
});

describe('updateLifecycle', () => {
  type Action = 'START_REVIEW' | 'APPROVE' | 'REJECT' | 'REOPEN' | 'MARK_PAID';
  const transitions: Record<Action, [Claim['status'], Claim['status']]> = {
    START_REVIEW: ['SUBMITTED', 'UNDER_REVIEW'],
    APPROVE: ['UNDER_REVIEW', 'APPROVED'],
    REJECT: ['UNDER_REVIEW', 'REJECTED'],
    REOPEN: ['REJECTED', 'DRAFT'],
    MARK_PAID: ['APPROVED', 'PAID'],
  };
  const actors: Record<Action, string> = {
    START_REVIEW: 'sub-ben',
    APPROVE: 'sub-ben',
    REJECT: 'sub-ben',
    REOPEN: 'sub-aisha',
    MARK_PAID: 'sub-dan',
  };
  const conditions: Record<Action, string> = {
    START_REVIEW: claimManagerCondition,
    APPROVE: claimManagerCondition,
    REJECT: claimManagerCondition,
    REOPEN: claimOwnerCondition,
    MARK_PAID: claimVersionCondition,
  };
  const actions = Object.keys(transitions) as Action[];
  const at = (minute: number) =>
    new Date(
      Date.parse('2026-10-14T10:00:00.000Z') + minute * 60_000,
    ).toISOString();
  const ids: ClaimEventIds = {
    eventId: '8f3d2c1e-5a7b-4c1d-9e2f-0a1b2c3d4e5f',
    correlationId: 'c0ffee00-1111-2222-3333-444455556666',
    causationId: 'request-7d3e',
  };
  const open: Claim = {
    ...categorized.claim,
    assignedManagerId: 'sub-ben',
    expenseDate: '2026-10-08',
    businessPurpose: 'Client workshop',
    version: 3,
    updatedAt: at(5),
    submittedAt: at(4),
  };

  /** The claim before and after one action, at versions 3 → 4. */
  function scenario(action: Action) {
    const [from, to] = transitions[action];
    const decided = from === 'REJECTED' || from === 'APPROVED';
    const previous: Claim = {
      ...open,
      status: from,
      ...(decided ? { reviewedAt: at(6) } : {}),
    };
    const reviewed =
      action === 'APPROVE' || action === 'REJECT' || action === 'MARK_PAID';
    const claim: Claim = {
      ...open,
      status: to,
      version: 4,
      updatedAt: at(7),
      ...(reviewed || action === 'REOPEN' ? { reviewedAt: at(6) } : {}),
    };
    const change: ClaimChange = {
      claim,
      history: {
        claimId,
        version: 4,
        action,
        fromStatus: from,
        toStatus: to,
        actorId: actors[action],
        occurredAt: at(7),
        ...(action === 'APPROVE' || action === 'REJECT'
          ? { comment: 'Reviewed.' }
          : {}),
      },
    };
    return { previous, change };
  }
  const eventFor = (change: ClaimChange, stored?: number) =>
    buildClaimLifecycleEvent(change, ids, stored)!;
  const optionsFor = (change: ClaimChange, stored?: number): CommitOptions => ({
    events: [eventFor(change, stored)],
    idempotency: completed,
  });

  it.each(actions)(
    'commits %s as update, history, event, then idempotency',
    async (action) => {
      const { executor, writer } = setup();
      const { previous, change } = scenario(action);

      await writer.updateLifecycle(previous, change, 2, optionsFor(change, 2));

      expect(executor.inputs).toEqual([
        composeBusinessTransaction({
          tableName,
          businessItems: updateClaimOperations(tableName, change, 3, 2),
          events: [eventFor(change, 2)],
          completed,
        }),
      ]);
      expect(keysOf(executor.inputs[0]!)).toEqual([
        `Update CLAIM#${claimId} CLAIM`,
        `Put CLAIM#${claimId} HISTORY#0000000004`,
        `Put CLAIM#${claimId} OUTBOX#${at(7)}#${ids.eventId}`,
        expect.stringMatching(/^Put IDEMPOTENCY#/),
      ]);
      const update = executor.inputs[0]!.TransactItems![0]!.Update!;
      expect(update.ConditionExpression).toBe(conditions[action]);
      expect(update.ExpressionAttributeValues).toMatchObject({
        ':expectedVersion': 3,
        ':lastEventVersion': 4,
      });
    },
  );

  it('chains the event to the stored event version', async () => {
    const { executor, writer } = setup();
    const { previous, change } = scenario('APPROVE');

    await writer.updateLifecycle(
      previous,
      change,
      undefined,
      optionsFor(change),
    );
    await writer.updateLifecycle(previous, change, 2, optionsFor(change, 2));
    await writer.updateLifecycle(previous, change, 3, optionsFor(change, 3));

    const chain = executor.inputs.map((input) => {
      const event = input.TransactItems![2]!.Put!.Item!;
      return (event.aggregate as { previousEventVersion: number | null })
        .previousEventVersion;
    });
    expect(chain).toEqual([null, 2, 3]);
  });

  it('has a deterministic token changed by the payload', async () => {
    const { executor, writer } = setup();
    const { previous, change } = scenario('START_REVIEW');
    const other = {
      ...optionsFor(change),
      events: [
        buildClaimLifecycleEvent(
          change,
          { ...ids, eventId: 'event-other-0001' },
          undefined,
        )!,
      ],
    };

    await writer.updateLifecycle(
      previous,
      change,
      undefined,
      optionsFor(change),
    );
    await writer.updateLifecycle(
      previous,
      change,
      undefined,
      optionsFor(change),
    );
    await writer.updateLifecycle(previous, change, undefined, other);

    const [first, second, third] = executor.inputs.map(
      (input) => input.ClientRequestToken,
    );
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(first).toBe(second);
    expect(third).not.toBe(first);
  });

  describe('refuses before sending', () => {
    const { previous, change } = scenario('APPROVE');
    const good = optionsFor(change);
    const event = good.events[0]!;

    it.each([
      [
        'missing options',
        previous,
        change,
        undefined,
        'The commit options are missing.',
      ],
      [
        'a missing previous claim',
        undefined,
        change,
        good,
        'The previous claim is missing.',
      ],
      [
        'a missing change',
        previous,
        undefined,
        good,
        'The claim change is missing.',
      ],
      [
        'SUBMIT',
        previous,
        { ...change, history: { ...change.history, action: 'SUBMIT' } },
        good,
        'Only a review, reopen, or payment can be written.',
      ],
      [
        'a draft edit',
        previous,
        { ...change, history: { ...change.history, action: 'UPDATE' } },
        good,
        'Only a review, reopen, or payment can be written.',
      ],
      [
        'a receipt action',
        previous,
        {
          ...change,
          history: { ...change.history, action: 'ATTACH_RECEIPT' },
        },
        good,
        'Only a review, reopen, or payment can be written.',
      ],
      [
        'another claim ID',
        previous,
        { ...change, claim: { ...change.claim, claimId: 'other-claim' } },
        good,
        'The changed claim does not match the previous claim.',
      ],
      [
        'another owner',
        previous,
        { ...change, claim: { ...change.claim, employeeId: 'sub-ben' } },
        good,
        'The changed claim does not match the previous claim.',
      ],
      [
        'another category',
        previous,
        { ...change, claim: { ...change.claim, categoryId: 'meals' } },
        good,
        'The changed claim does not match the previous claim.',
      ],
      [
        'a previous status that differs from the history',
        { ...previous, status: 'SUBMITTED' },
        change,
        good,
        'The previous claim is not in the expected status.',
      ],
      [
        'a category guard',
        previous,
        change,
        {
          ...good,
          categoryGuard: {
            categoryId: 'travel',
            readVersion: 1,
            mustBeActive: true,
          },
        },
        'A lifecycle change cannot carry a category guard.',
      ],
      [
        'a missing idempotency record',
        previous,
        change,
        { events: good.events },
        'A lifecycle change requires an idempotency record.',
      ],
      [
        'events that are not a list',
        previous,
        change,
        { idempotency: completed },
        'The commit options must list their events.',
      ],
      [
        'no event',
        previous,
        change,
        { ...good, events: [] },
        'A lifecycle change publishes exactly one event.',
      ],
      [
        'an extra event',
        previous,
        change,
        { ...good, events: [event, event] },
        'A lifecycle change publishes exactly one event.',
      ],
      [
        'a non-object event',
        previous,
        change,
        { ...good, events: ['event'] },
        'The lifecycle event does not match the change.',
      ],
      [
        'an event of another type',
        previous,
        change,
        { ...good, events: [{ ...event, eventType: 'claim.rejected' }] },
        'The lifecycle event does not match the change.',
      ],
      [
        'an event for another actor',
        previous,
        change,
        { ...good, events: [{ ...event, actorId: 'sub-zed' }] },
        'The lifecycle event does not match the change.',
      ],
      [
        'an event at another time',
        previous,
        change,
        { ...good, events: [{ ...event, occurredAt: at(9) }] },
        'The lifecycle event does not match the change.',
      ],
      [
        'an event with another aggregate version',
        previous,
        change,
        {
          ...good,
          events: [{ ...event, aggregate: { ...event.aggregate, version: 9 } }],
        },
        'The lifecycle event does not match the change.',
      ],
      [
        'an event with a broken version chain',
        previous,
        change,
        {
          ...good,
          events: [
            {
              ...event,
              aggregate: { ...event.aggregate, previousEventVersion: 2 },
            },
          ],
        },
        'The lifecycle event does not match the change.',
      ],
      [
        'an event with another payload',
        previous,
        change,
        {
          ...good,
          events: [
            {
              ...event,
              payload: { ...event.payload, categoryId: 'meals' },
            },
          ],
        },
        'The lifecycle event does not match the change.',
      ],
      [
        'an event with an extra field',
        previous,
        change,
        { ...good, events: [{ ...event, note: 'extra' }] },
        'The lifecycle event does not match the change.',
      ],
      [
        'an event with a non-canonical value',
        previous,
        change,
        { ...good, events: [{ ...event, causationId: undefined }] },
        'The lifecycle event does not match the change.',
      ],
    ])('%s', async (_name, prior, changed, options, message) => {
      const { executor, writer } = setup();

      await expect(
        writer.updateLifecycle(
          prior as unknown as Claim,
          changed as unknown as ClaimChange,
          undefined,
          options as unknown as CommitOptions,
        ),
      ).rejects.toThrow(new TypeError(message));
      expect(executor.inputs).toEqual([]);
    });

    it('refuses a stored event version that breaks the chain', async () => {
      const { executor, writer } = setup();

      for (const stored of [4, -1, 1.5]) {
        await expect(
          writer.updateLifecycle(previous, change, stored, good),
        ).rejects.toBeInstanceOf(Error);
      }
      expect(executor.inputs).toEqual([]);
    });

    it('refuses invalid previous claims, versions and idempotency data', async () => {
      const { executor, writer } = setup();
      const bad = scenario('START_REVIEW');
      const { assignedManagerId: _m, ...unassigned } = bad.previous;
      const invalid: Promise<void>[] = [
        writer.updateLifecycle(
          unassigned,
          bad.change,
          undefined,
          optionsFor(bad.change),
        ),
        writer.updateLifecycle(
          { ...bad.previous, version: 0 },
          bad.change,
          undefined,
          optionsFor(bad.change),
        ),
        writer.updateLifecycle(
          { ...bad.previous, version: 2 },
          bad.change,
          undefined,
          optionsFor(bad.change),
        ),
        writer.updateLifecycle(bad.previous, bad.change, undefined, {
          ...optionsFor(bad.change),
          idempotency: { ...completed, fingerprint: 'short' },
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
        writer.updateLifecycle(previous, change, undefined, {
          ...good,
          events: [{ ...event, actorId: secret }],
        }),
        writer.updateLifecycle(
          previous,
          { ...change, claim: { ...change.claim, employeeId: secret } },
          undefined,
          good,
        ),
        writer.updateLifecycle(previous, change, undefined, {
          ...good,
          events: [{ ...event, payload: { claimId: secret } } as never],
        }),
      ]);
      for (const failure of failures) {
        expect(failure.status).toBe('rejected');
        const message = String((failure as PromiseRejectedResult).reason);
        expect(message).not.toContain('Secret');
        expect(message).not.toContain('Confidential');
      }
    });
  });

  it('prepares the transaction it sends, without executing', async () => {
    const { executor, writer } = setup();
    const { previous, change } = scenario('APPROVE');
    const options = optionsFor(change, 2);
    await expectPreparation(
      executor,
      () => writer.prepareUpdateLifecycle(previous, change, 2, options),
      () => writer.updateLifecycle(previous, change, 2, options),
      () =>
        writer.prepareUpdateLifecycle(previous, change, 2, undefined as never),
    );
  });

  it('sends one command and propagates errors unchanged', async () => {
    const client = {
      commands: [] as TransactWriteCommand[],
      failure: undefined as Error | undefined,
      send(command: TransactWriteCommand) {
        this.commands.push(command);
        return this.failure === undefined
          ? Promise.resolve({ $metadata: {} } as TransactWriteCommandOutput)
          : Promise.reject(this.failure);
      },
    };
    const writer = new DynamoDbClaimWriter({
      executor: new DynamoDbTransactionExecutor({ client }),
      tableName,
    });
    const { previous, change } = scenario('MARK_PAID');

    await writer.updateLifecycle(
      previous,
      change,
      undefined,
      optionsFor(change),
    );
    expect(client.commands).toHaveLength(1);
    expect(client.commands[0]).toBeInstanceOf(TransactWriteCommand);

    const failure = Object.assign(new Error('TransactionCanceledException'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
    });
    client.failure = failure;
    await expect(
      writer.updateLifecycle(previous, change, undefined, optionsFor(change)),
    ).rejects.toBe(failure);
    expect(client.commands).toHaveLength(2);

    const { executor, writer: fake } = setup();
    const executorFailure = new Error('IdempotentParameterMismatchException');
    executor.failure = executorFailure;
    await expect(
      fake.updateLifecycle(previous, change, undefined, optionsFor(change)),
    ).rejects.toBe(executorFailure);
    expect(executor.inputs).toHaveLength(1);
  });
});

describe('submit', () => {
  const at = (minute: number) =>
    new Date(
      Date.parse('2026-10-14T10:00:00.000Z') + minute * 60_000,
    ).toISOString();
  const ids: ClaimEventIds = {
    eventId: '8f3d2c1e-5a7b-4c1d-9e2f-0a1b2c3d4e5f',
    correlationId: 'c0ffee00-1111-2222-3333-444455556666',
    causationId: 'request-7d3e',
  };
  const travelGuard: CategoryGuard = {
    categoryId: 'travel',
    readVersion: 3,
    mustBeActive: true,
  };

  /** A first submission at versions 1 → 2. */
  const firstDraft: Claim = {
    ...categorized.claim,
    expenseDate: '2026-10-08',
    businessPurpose: 'Client workshop',
  };
  /** A reopened draft at version 5, resubmitted at version 6. */
  const reopenedDraft: Claim = {
    ...firstDraft,
    assignedManagerId: 'sub-ben',
    version: 5,
    updatedAt: at(8),
    submittedAt: at(4),
    reviewedAt: at(6),
  };

  function submission(previous: Claim): ClaimChange {
    const version = previous.version + 1;
    return {
      claim: {
        ...previous,
        assignedManagerId: 'sub-ben',
        status: 'SUBMITTED',
        version,
        updatedAt: at(10),
        submittedAt: at(10),
      },
      history: {
        claimId,
        version,
        action: 'SUBMIT',
        fromStatus: 'DRAFT',
        toStatus: 'SUBMITTED',
        actorId: 'sub-aisha',
        occurredAt: at(10),
      },
    };
  }
  const eventFor = (change: ClaimChange, stored?: number) =>
    buildClaimLifecycleEvent(change, ids, stored)!;
  const optionsFor = (change: ClaimChange, stored?: number): CommitOptions => ({
    events: [eventFor(change, stored)],
    idempotency: completed,
    categoryGuard: travelGuard,
  });
  const first = submission(firstDraft);
  const again = submission(reopenedDraft);

  it.each([
    ['a first submission', firstDraft, first, undefined, 1, 2, null],
    ['a resubmission after reopening', reopenedDraft, again, 4, 5, 6, 4],
  ])(
    'commits %s as update, history, guard check, event, then idempotency',
    async (_name, previous, change, stored, expected, version, chained) => {
      const { executor, writer } = setup();

      await writer.submit(previous, change, stored, optionsFor(change, stored));

      expect(executor.inputs).toEqual([
        composeBusinessTransaction({
          tableName,
          businessItems: [
            ...updateClaimOperations(tableName, change, expected, stored),
            categoryGuardCheckOperation(tableName, travelGuard),
          ],
          events: [eventFor(change, stored)],
          completed,
        }),
      ]);
      expect(keysOf(executor.inputs[0]!)).toEqual([
        `Update CLAIM#${claimId} CLAIM`,
        `Put CLAIM#${claimId} HISTORY#${String(version).padStart(10, '0')}`,
        'ConditionCheck CATEGORIES CATEGORY#travel',
        `Put CLAIM#${claimId} OUTBOX#${at(10)}#${ids.eventId}`,
        expect.stringMatching(/^Put IDEMPOTENCY#/),
      ]);
      const items = executor.inputs[0]!.TransactItems!;
      expect(items[0]!.Update!.ConditionExpression).toBe(claimOwnerCondition);
      expect(items[0]!.Update!.ExpressionAttributeValues).toMatchObject({
        ':expectedVersion': expected,
        ':actorId': 'sub-aisha',
        ':lastEventVersion': version,
      });
      expect(items[2]!.ConditionCheck!.ExpressionAttributeValues).toEqual({
        ':readVersion': 3,
        ':true': true,
      });
      // The guard is a check only: no counter is written.
      expect(items.filter((item) => item.Update !== undefined)).toHaveLength(1);
      expect(
        (items[3]!.Put!.Item!.aggregate as { previousEventVersion: unknown })
          .previousEventVersion,
      ).toBe(chained);
    },
  );

  it('has a deterministic token changed by the guard or the event', async () => {
    const { executor, writer } = setup();
    const options = optionsFor(first);

    await writer.submit(firstDraft, first, undefined, options);
    await writer.submit(firstDraft, first, undefined, options);
    await writer.submit(firstDraft, first, undefined, {
      ...options,
      categoryGuard: { ...travelGuard, readVersion: 4 },
    });
    await writer.submit(firstDraft, first, undefined, {
      ...options,
      events: [
        buildClaimLifecycleEvent(
          first,
          { ...ids, eventId: 'event-other-0001' },
          undefined,
        )!,
      ],
    });

    const [a, b, c, d] = executor.inputs.map(
      (input) => input.ClientRequestToken,
    );
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(d).not.toBe(a);
  });

  describe('refuses before sending', () => {
    const good = optionsFor(first);
    const event = good.events[0]!;
    const mismatched = (patch: object): CommitOptions => ({
      ...good,
      events: [{ ...event, ...patch }],
    });
    const uncategorized = (claim: Claim): Claim => {
      const { categoryId: _c, ...rest } = claim;
      return rest;
    };

    it.each([
      [
        'missing options',
        firstDraft,
        first,
        undefined,
        'The commit options are missing.',
      ],
      [
        'a missing previous claim',
        undefined,
        first,
        good,
        'The previous claim is missing.',
      ],
      [
        'a missing change',
        firstDraft,
        undefined,
        good,
        'The claim change is missing.',
      ],
      [
        'a draft edit',
        firstDraft,
        { ...first, history: { ...first.history, action: 'UPDATE' } },
        good,
        'Only a submission can be written.',
      ],
      [
        'a lifecycle action',
        firstDraft,
        { ...first, history: { ...first.history, action: 'APPROVE' } },
        good,
        'Only a submission can be written.',
      ],
      [
        'another claim ID',
        firstDraft,
        { ...first, claim: { ...first.claim, claimId: 'other-claim' } },
        good,
        'The submitted claim does not match the previous claim.',
      ],
      [
        'another owner',
        firstDraft,
        { ...first, claim: { ...first.claim, employeeId: 'sub-ben' } },
        good,
        'The submitted claim does not match the previous claim.',
      ],
      [
        'another category',
        firstDraft,
        { ...first, claim: { ...first.claim, categoryId: 'meals' } },
        good,
        'The submitted claim does not match the previous claim.',
      ],
      [
        'an uncategorized claim',
        uncategorized(firstDraft),
        { ...first, claim: uncategorized(first.claim) },
        good,
        'A submitted claim requires a category.',
      ],
      [
        'a previous claim that is not a draft',
        { ...firstDraft, status: 'REJECTED' },
        first,
        good,
        'Only a draft can be submitted.',
      ],
      [
        'a history entry that does not start from a draft',
        firstDraft,
        { ...first, history: { ...first.history, fromStatus: 'REJECTED' } },
        good,
        'Only a draft can be submitted.',
      ],
      [
        'a claim that is not submitted',
        firstDraft,
        { ...first, claim: { ...first.claim, status: 'UNDER_REVIEW' } },
        good,
        'Only a draft can be submitted.',
      ],
      [
        'a missing category guard',
        firstDraft,
        first,
        { ...good, categoryGuard: undefined },
        'A submission requires a category guard.',
      ],
      [
        'a guard for another category',
        firstDraft,
        first,
        { ...good, categoryGuard: { ...travelGuard, categoryId: 'meals' } },
        'The category guard does not match the claim.',
      ],
      [
        'a guard that allows an inactive category',
        firstDraft,
        first,
        { ...good, categoryGuard: { ...travelGuard, mustBeActive: false } },
        'The category guard must require an active category.',
      ],
      [
        'a missing idempotency record',
        firstDraft,
        first,
        { ...good, idempotency: undefined },
        'A submission requires an idempotency record.',
      ],
      [
        'events that are not a list',
        firstDraft,
        first,
        { idempotency: completed, categoryGuard: travelGuard },
        'The commit options must list their events.',
      ],
      [
        'no event',
        firstDraft,
        first,
        { ...good, events: [] },
        'A lifecycle change publishes exactly one event.',
      ],
      [
        'an extra event',
        firstDraft,
        first,
        { ...good, events: [event, event] },
        'A lifecycle change publishes exactly one event.',
      ],
      [
        'an event of another type',
        firstDraft,
        first,
        mismatched({ eventType: 'claim.approved' }),
        'The lifecycle event does not match the change.',
      ],
      [
        'an event for another actor',
        firstDraft,
        first,
        mismatched({ actorId: 'sub-zed' }),
        'The lifecycle event does not match the change.',
      ],
      [
        'an event at another time',
        firstDraft,
        first,
        mismatched({ occurredAt: at(12) }),
        'The lifecycle event does not match the change.',
      ],
      [
        'an event with a broken version chain',
        firstDraft,
        first,
        mismatched({
          aggregate: { ...event.aggregate, previousEventVersion: 1 },
        }),
        'The lifecycle event does not match the change.',
      ],
      [
        'an event with another payload',
        firstDraft,
        first,
        mismatched({ payload: { ...event.payload, categoryId: 'meals' } }),
        'The lifecycle event does not match the change.',
      ],
      [
        'an event with an extra field',
        firstDraft,
        first,
        mismatched({ note: 'extra' }),
        'The lifecycle event does not match the change.',
      ],
    ])('%s', async (_name, prior, changed, options, message) => {
      const { executor, writer } = setup();

      await expect(
        writer.submit(
          prior as unknown as Claim,
          changed as unknown as ClaimChange,
          undefined,
          options as unknown as CommitOptions,
        ),
      ).rejects.toThrow(new TypeError(message));
      expect(executor.inputs).toEqual([]);
    });

    it('refuses a stored event version that breaks the chain', async () => {
      const { executor, writer } = setup();

      for (const stored of [2, -1, 1.5]) {
        await expect(
          writer.submit(firstDraft, first, stored, good),
        ).rejects.toBeInstanceOf(Error);
      }
      expect(executor.inputs).toEqual([]);
    });

    it('refuses invalid previous claims, versions and idempotency data', async () => {
      const { executor, writer } = setup();
      const invalid: Promise<void>[] = [
        writer.submit({ ...firstDraft, version: 0 }, first, undefined, good),
        writer.submit({ ...firstDraft, version: 3 }, first, undefined, good),
        writer.submit(
          { ...firstDraft, createdAt: 'yesterday' },
          first,
          undefined,
          good,
        ),
        writer.submit(firstDraft, first, undefined, {
          ...good,
          idempotency: { ...completed, fingerprint: 'short' },
        }),
        writer.submit(firstDraft, first, undefined, {
          ...good,
          categoryGuard: { ...travelGuard, readVersion: 0 },
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
        writer.submit(
          firstDraft,
          first,
          undefined,
          mismatched({ actorId: secret }),
        ),
        writer.submit(
          firstDraft,
          { ...first, claim: { ...first.claim, employeeId: secret } },
          undefined,
          good,
        ),
        writer.submit(firstDraft, first, undefined, {
          ...good,
          categoryGuard: { ...travelGuard, categoryId: secret },
        }),
      ]);
      for (const failure of failures) {
        expect(failure.status).toBe('rejected');
        const message = String((failure as PromiseRejectedResult).reason);
        expect(message).not.toContain('Secret');
        expect(message).not.toContain('Confidential');
      }
    });
  });

  it('prepares the transaction it sends, without executing', async () => {
    const { executor, writer } = setup();
    const options = optionsFor(first);
    await expectPreparation(
      executor,
      () => writer.prepareSubmit(firstDraft, first, undefined, options),
      () => writer.submit(firstDraft, first, undefined, options),
      () =>
        writer.prepareSubmit(firstDraft, first, undefined, undefined as never),
    );
  });

  it('sends one command and propagates errors unchanged', async () => {
    const client = {
      commands: [] as TransactWriteCommand[],
      failure: undefined as Error | undefined,
      send(command: TransactWriteCommand) {
        this.commands.push(command);
        return this.failure === undefined
          ? Promise.resolve({ $metadata: {} } as TransactWriteCommandOutput)
          : Promise.reject(this.failure);
      },
    };
    const writer = new DynamoDbClaimWriter({
      executor: new DynamoDbTransactionExecutor({ client }),
      tableName,
    });

    await writer.submit(firstDraft, first, undefined, optionsFor(first));
    expect(client.commands).toHaveLength(1);
    expect(client.commands[0]).toBeInstanceOf(TransactWriteCommand);

    const failure = Object.assign(new Error('TransactionCanceledException'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
    });
    client.failure = failure;
    await expect(
      writer.submit(firstDraft, first, undefined, optionsFor(first)),
    ).rejects.toBe(failure);
    expect(client.commands).toHaveLength(2);

    const { executor, writer: fake } = setup();
    const executorFailure = new Error('IdempotentParameterMismatchException');
    executor.failure = executorFailure;
    await expect(
      fake.submit(firstDraft, first, undefined, optionsFor(first)),
    ).rejects.toBe(executorFailure);
    expect(executor.inputs).toHaveLength(1);
  });
});

describe('attachReceipt', () => {
  const at = (minute: number) =>
    new Date(
      Date.parse('2026-10-14T10:00:00.000Z') + minute * 60_000,
    ).toISOString();
  const checksum = 'a1b2'.repeat(16);
  const fileName = 'flight.pdf';

  const pending: PendingReceiptRecord = {
    receiptId: 'r-7731',
    ownerId: 'sub-aisha',
    state: 'PENDING',
    fileName,
    declaredContentType: 'application/pdf',
    declaredSizeBytes: 52_144,
    declaredChecksumSha256: checksum,
    uploadedAt: at(5),
    expiresAt: pendingReceiptExpiresAt(at(5)),
  };
  const attached: AttachedReceiptRecord = {
    receiptId: 'r-7731',
    ownerId: 'sub-aisha',
    state: 'ATTACHED',
    fileName,
    contentType: 'application/pdf',
    sizeBytes: 52_144,
    checksumSha256: checksum,
    uploadedAt: at(5),
    attachedClaimId: claimId,
  };
  const previous: Claim = {
    ...categorized.claim,
    version: 3,
    updatedAt: at(6),
  };
  const change: ClaimChange = {
    claim: {
      ...previous,
      version: 4,
      updatedAt: at(8),
      receipt: {
        receiptId: 'r-7731',
        fileName,
        contentType: 'application/pdf',
        sizeBytes: 52_144,
        checksumSha256: checksum,
        attachedAt: at(8),
      },
    },
    history: {
      claimId,
      version: 4,
      action: 'ATTACH_RECEIPT',
      fromStatus: 'DRAFT',
      toStatus: 'DRAFT',
      actorId: 'sub-aisha',
      occurredAt: at(8),
    },
  };
  const attach = (
    writer: DynamoDbClaimWriter,
    stored: number | undefined = undefined,
    options: CommitOptions = withoutGuard,
  ) =>
    writer.attachReceipt(previous, change, pending, attached, stored, options);

  it('commits the claim update, history, receipt update, then idempotency', async () => {
    const { executor, writer } = setup();

    await attach(writer, 2);

    expect(executor.inputs).toEqual([
      composeBusinessTransaction({
        tableName,
        businessItems: [
          ...updateClaimOperations(tableName, change, 3, 2),
          attachReceiptOperation(tableName, pending, attached, 'sub-aisha'),
        ],
        events: [],
        completed,
      }),
    ]);
    expect(keysOf(executor.inputs[0]!)).toEqual([
      `Update CLAIM#${claimId} CLAIM`,
      `Put CLAIM#${claimId} HISTORY#0000000004`,
      'Update RECEIPT#r-7731 RECEIPT',
      expect.stringMatching(/^Put IDEMPOTENCY#/),
    ]);
  });

  it('links the claim and the receipt and keeps the stored event version', async () => {
    const { executor, writer } = setup();

    await attach(writer, 2);

    const [claimUpdate, , receiptUpdate] = executor.inputs[0]!.TransactItems!;
    expect(claimUpdate!.Update!.ConditionExpression).toBe(claimOwnerCondition);
    const values = claimUpdate!.Update!.ExpressionAttributeValues!;
    expect(values).toMatchObject({
      ':expectedVersion': 3,
      ':actorId': 'sub-aisha',
      ':lastEventVersion': 2,
      ':receipt': change.claim.receipt,
    });
    expect(receiptUpdate!.Update!.ConditionExpression).toBe(
      receiptAttachCondition,
    );
    expect(receiptUpdate!.Update!.ExpressionAttributeValues).toMatchObject({
      ':attachedClaimId': claimId,
      ':actorId': 'sub-aisha',
      ':pending': 'PENDING',
      ':objectKey': 'receipts/r-7731',
    });
    expect(receiptUpdate!.Update!.UpdateExpression).toContain(
      'REMOVE #declaredContentType, #declaredSizeBytes, ' +
        '#declaredChecksumSha256, #expiresAt',
    );
  });

  it('adds no category operation, event, or ConditionCheck', async () => {
    const { executor, writer } = setup();

    await attach(writer);

    const items = executor.inputs[0]!.TransactItems!;
    expect(items).toHaveLength(4);
    expect(items.some((item) => item.ConditionCheck !== undefined)).toBe(false);
    expect(JSON.stringify(items)).not.toContain('CATEGORIES');
    expect(JSON.stringify(items)).not.toContain('OUTBOX#');
  });

  it('commits an uncategorized draft the same way', async () => {
    const { executor, writer } = setup();
    const { categoryId: _p, ...bare } = previous;
    const { categoryId: _c, ...bareClaim } = change.claim;

    await writer.attachReceipt(
      bare,
      { ...change, claim: bareClaim },
      pending,
      attached,
      undefined,
      withoutGuard,
    );

    expect(keysOf(executor.inputs[0]!)).toHaveLength(4);
  });

  it('has a deterministic token changed by the payload', async () => {
    const { executor, writer } = setup();

    await attach(writer);
    await attach(writer);
    await attach(writer, 2);
    await writer.attachReceipt(previous, change, pending, attached, undefined, {
      ...withoutGuard,
      idempotency: { ...completed, key: 'claim-key-0002' },
    });

    const [a, b, c, d] = executor.inputs.map(
      (input) => input.ClientRequestToken,
    );
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(d).not.toBe(a);
  });

  describe('refuses before sending', () => {
    const fresh = (patch: Partial<Claim>): ClaimChange => ({
      ...change,
      claim: { ...change.claim, ...patch },
    });
    const withReceipt = (patch: object): ClaimChange =>
      fresh({ receipt: { ...change.claim.receipt!, ...patch } });

    it.each([
      [
        'missing options',
        previous,
        change,
        pending,
        attached,
        undefined,
        'The commit options are missing.',
      ],
      [
        'a missing previous claim',
        undefined,
        change,
        pending,
        attached,
        withoutGuard,
        'The previous claim is missing.',
      ],
      [
        'a missing change',
        previous,
        undefined,
        pending,
        attached,
        withoutGuard,
        'The claim change is missing.',
      ],
      [
        'a missing pending receipt',
        previous,
        change,
        undefined,
        attached,
        withoutGuard,
        'The pending receipt is missing.',
      ],
      [
        'a missing attached receipt',
        previous,
        change,
        pending,
        undefined,
        withoutGuard,
        'The attached receipt is missing.',
      ],
      [
        'a replacement',
        previous,
        {
          ...change,
          history: { ...change.history, action: 'REPLACE_RECEIPT' },
        },
        pending,
        attached,
        withoutGuard,
        'Only a first receipt attachment can be written.',
      ],
      [
        'a draft edit',
        previous,
        { ...change, history: { ...change.history, action: 'UPDATE' } },
        pending,
        attached,
        withoutGuard,
        'Only a first receipt attachment can be written.',
      ],
      [
        'a submitted previous claim',
        { ...previous, status: 'SUBMITTED' },
        change,
        pending,
        attached,
        withoutGuard,
        'Only a draft can have a receipt attached.',
      ],
      [
        'a submitted new claim',
        previous,
        fresh({ status: 'SUBMITTED' }),
        pending,
        attached,
        withoutGuard,
        'Only a draft can have a receipt attached.',
      ],
      [
        'another claim ID',
        previous,
        fresh({ claimId: 'other-claim' }),
        pending,
        attached,
        withoutGuard,
        'The changed claim does not match the previous claim.',
      ],
      [
        'another owner',
        previous,
        fresh({ employeeId: 'sub-ben' }),
        pending,
        attached,
        withoutGuard,
        'The changed claim does not match the previous claim.',
      ],
      [
        'another category',
        previous,
        fresh({ categoryId: 'meals' }),
        pending,
        attached,
        withoutGuard,
        'The changed claim does not match the previous claim.',
      ],
      [
        'a previous receipt',
        { ...previous, receipt: change.claim.receipt },
        change,
        pending,
        attached,
        withoutGuard,
        'The previous claim already has a receipt.',
      ],
      [
        'a claim without a receipt',
        previous,
        { ...change, claim: { ...previous, version: 4 } },
        pending,
        attached,
        withoutGuard,
        'The changed claim has no receipt.',
      ],
      [
        'a receipt attached to another claim',
        previous,
        change,
        pending,
        { ...attached, attachedClaimId: 'other-claim' },
        withoutGuard,
        'The attached receipt does not belong to the claim.',
      ],
      [
        'a receipt owned by someone else',
        previous,
        change,
        { ...pending, ownerId: 'sub-ben' },
        { ...attached, ownerId: 'sub-ben' },
        withoutGuard,
        'The attached receipt does not belong to the claim.',
      ],
      [
        'a history actor who is not the receipt owner',
        previous,
        { ...change, history: { ...change.history, actorId: 'sub-ben' } },
        pending,
        attached,
        withoutGuard,
        'The attached receipt does not belong to the claim.',
      ],
      [
        'another receipt ID on the claim',
        previous,
        withReceipt({ receiptId: 'r-9999' }),
        pending,
        attached,
        withoutGuard,
        'The claim receipt does not match the attached receipt.',
      ],
      [
        'another file name on the claim',
        previous,
        withReceipt({ fileName: 'other.pdf' }),
        pending,
        attached,
        withoutGuard,
        'The claim receipt does not match the attached receipt.',
      ],
      [
        'another content type on the claim',
        previous,
        withReceipt({ contentType: 'image/png' }),
        pending,
        attached,
        withoutGuard,
        'The claim receipt does not match the attached receipt.',
      ],
      [
        'another size on the claim',
        previous,
        withReceipt({ sizeBytes: 1 }),
        pending,
        attached,
        withoutGuard,
        'The claim receipt does not match the attached receipt.',
      ],
      [
        'another checksum on the claim',
        previous,
        withReceipt({ checksumSha256: 'b'.repeat(64) }),
        pending,
        attached,
        withoutGuard,
        'The claim receipt does not match the attached receipt.',
      ],
      [
        'an attachment time other than the history time',
        previous,
        withReceipt({ attachedAt: at(9) }),
        pending,
        attached,
        withoutGuard,
        'The claim receipt does not match the attached receipt.',
      ],
      [
        'a category guard',
        previous,
        change,
        pending,
        attached,
        {
          ...withoutGuard,
          categoryGuard: {
            categoryId: 'travel',
            readVersion: 1,
            mustBeActive: true,
          },
        },
        'A receipt attachment cannot carry a category guard.',
      ],
      [
        'a missing idempotency record',
        previous,
        change,
        pending,
        attached,
        { events: [] },
        'A receipt attachment requires an idempotency record.',
      ],
      [
        'events that are not a list',
        previous,
        change,
        pending,
        attached,
        { idempotency: completed },
        'The commit options must list their events.',
      ],
      [
        'an event',
        previous,
        change,
        pending,
        attached,
        { ...withoutGuard, events: [{}] },
        'A receipt attachment publishes no events.',
      ],
    ])('%s', async (_n, prior, changed, pend, attach_, options, message) => {
      const { executor, writer } = setup();

      await expect(
        writer.attachReceipt(
          prior as unknown as Claim,
          changed as unknown as ClaimChange,
          pend as unknown as PendingReceiptRecord,
          attach_ as unknown as AttachedReceiptRecord,
          undefined,
          options as unknown as CommitOptions,
        ),
      ).rejects.toThrow(new TypeError(message));
      expect(executor.inputs).toEqual([]);
    });

    it('refuses invalid records, versions and idempotency data', async () => {
      const { executor, writer } = setup();
      const invalid: Promise<void>[] = [
        writer.attachReceipt(
          { ...previous, version: 0 },
          change,
          pending,
          attached,
          undefined,
          withoutGuard,
        ),
        writer.attachReceipt(
          { ...previous, version: 2 },
          change,
          pending,
          attached,
          undefined,
          withoutGuard,
        ),
        writer.attachReceipt(
          previous,
          change,
          pending,
          attached,
          9,
          withoutGuard,
        ),
        writer.attachReceipt(
          previous,
          change,
          { ...pending, state: 'ATTACHED' } as never,
          attached,
          undefined,
          withoutGuard,
        ),
        writer.attachReceipt(
          previous,
          change,
          { ...pending, declaredSizeBytes: 1 },
          attached,
          undefined,
          withoutGuard,
        ),
        writer.attachReceipt(
          previous,
          change,
          { ...pending, expiresAt: 5 },
          attached,
          undefined,
          withoutGuard,
        ),
        writer.attachReceipt(
          previous,
          change,
          pending,
          { ...attached, state: 'PENDING' } as never,
          undefined,
          withoutGuard,
        ),
        writer.attachReceipt(previous, change, pending, attached, undefined, {
          ...withoutGuard,
          idempotency: { ...completed, fingerprint: 'short' },
        }),
      ];

      for (const promise of invalid) {
        await expect(promise).rejects.toBeInstanceOf(Error);
      }
      expect(executor.inputs).toEqual([]);
    });

    it('echoes no supplied value in its own messages', async () => {
      const { writer } = setup();
      const secret = 'Secret Payslip.pdf';
      const failures = await Promise.allSettled([
        writer.attachReceipt(
          previous,
          withReceipt({ fileName: secret }),
          pending,
          attached,
          undefined,
          withoutGuard,
        ),
        writer.attachReceipt(
          previous,
          change,
          pending,
          { ...attached, fileName: secret },
          undefined,
          withoutGuard,
        ),
        writer.attachReceipt(
          previous,
          fresh({ employeeId: secret }),
          pending,
          attached,
          undefined,
          withoutGuard,
        ),
      ]);
      for (const failure of failures) {
        expect(failure.status).toBe('rejected');
        const message = String((failure as PromiseRejectedResult).reason);
        expect(message).not.toContain('Secret');
        expect(message).not.toContain('Confidential');
      }
    });
  });

  it('prepares the transaction it sends, without executing', async () => {
    const { executor, writer } = setup();
    await expectPreparation(
      executor,
      () =>
        writer.prepareAttachReceipt(
          previous,
          change,
          pending,
          attached,
          2,
          withoutGuard,
        ),
      () => attach(writer, 2),
      () =>
        writer.prepareAttachReceipt(
          previous,
          change,
          pending,
          attached,
          2,
          undefined as never,
        ),
    );
  });

  it('sends one command and propagates errors unchanged', async () => {
    const client = {
      commands: [] as TransactWriteCommand[],
      failure: undefined as Error | undefined,
      send(command: TransactWriteCommand) {
        this.commands.push(command);
        return this.failure === undefined
          ? Promise.resolve({ $metadata: {} } as TransactWriteCommandOutput)
          : Promise.reject(this.failure);
      },
    };
    const writer = new DynamoDbClaimWriter({
      executor: new DynamoDbTransactionExecutor({ client }),
      tableName,
    });

    await attach(writer);
    expect(client.commands).toHaveLength(1);
    expect(client.commands[0]).toBeInstanceOf(TransactWriteCommand);

    const failure = Object.assign(new Error('TransactionCanceledException'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
    });
    client.failure = failure;
    await expect(attach(writer)).rejects.toBe(failure);
    expect(client.commands).toHaveLength(2);

    const { executor, writer: fake } = setup();
    const executorFailure = new Error('IdempotentParameterMismatchException');
    executor.failure = executorFailure;
    await expect(attach(fake)).rejects.toBe(executorFailure);
    expect(executor.inputs).toHaveLength(1);
  });
});

describe('replaceReceipt', () => {
  const at = (minute: number) =>
    new Date(
      Date.parse('2026-10-14T10:00:00.000Z') + minute * 60_000,
    ).toISOString();
  const oldChecksum = 'a1b2'.repeat(16);
  const newChecksum = 'c3d4'.repeat(16);

  const oldAttached: AttachedReceiptRecord = {
    receiptId: 'r-7731',
    ownerId: 'sub-aisha',
    state: 'ATTACHED',
    fileName: 'flight.pdf',
    contentType: 'application/pdf',
    sizeBytes: 52_144,
    checksumSha256: oldChecksum,
    uploadedAt: at(5),
    attachedClaimId: claimId,
  };
  const oldRetired: RetiredReceiptRecord = {
    ...oldAttached,
    state: 'REPLACED',
    expiresAt: retiredReceiptExpiresAt(at(12)),
  };
  const newPending: PendingReceiptRecord = {
    receiptId: 'r-8000',
    ownerId: 'sub-aisha',
    state: 'PENDING',
    fileName: 'ticket.png',
    declaredContentType: 'image/png',
    declaredSizeBytes: 9_000,
    declaredChecksumSha256: newChecksum,
    uploadedAt: at(10),
    expiresAt: pendingReceiptExpiresAt(at(10)),
  };
  const newAttached: AttachedReceiptRecord = {
    receiptId: 'r-8000',
    ownerId: 'sub-aisha',
    state: 'ATTACHED',
    fileName: 'ticket.png',
    contentType: 'image/png',
    sizeBytes: 9_000,
    checksumSha256: newChecksum,
    uploadedAt: at(10),
    attachedClaimId: claimId,
  };
  const previous: Claim = {
    ...categorized.claim,
    version: 4,
    updatedAt: at(8),
    receipt: {
      receiptId: 'r-7731',
      fileName: 'flight.pdf',
      contentType: 'application/pdf',
      sizeBytes: 52_144,
      checksumSha256: oldChecksum,
      attachedAt: at(8),
    },
  };
  const change: ClaimChange = {
    claim: {
      ...previous,
      version: 5,
      updatedAt: at(12),
      receipt: {
        receiptId: 'r-8000',
        fileName: 'ticket.png',
        contentType: 'image/png',
        sizeBytes: 9_000,
        checksumSha256: newChecksum,
        attachedAt: at(12),
      },
    },
    history: {
      claimId,
      version: 5,
      action: 'REPLACE_RECEIPT',
      fromStatus: 'DRAFT',
      toStatus: 'DRAFT',
      actorId: 'sub-aisha',
      occurredAt: at(12),
    },
  };
  const input: ReplaceReceiptInput = {
    previousClaim: previous,
    change,
    newPendingReceipt: newPending,
    newAttachedReceipt: newAttached,
    oldAttachedReceipt: oldAttached,
    oldRetiredReceipt: oldRetired,
    storedLastEventVersion: 2,
  };
  const ids: ClaimEventIds = {
    eventId: '1c9e7b2a-3d4f-4e5a-8b6c-7d8e9f0a1b2c',
    correlationId: 'c0ffee00-1111-2222-3333-444455556667',
    causationId: 'request-8a41',
  };
  const cleanup = buildReceiptDeletionEvent({
    ...ids,
    actorId: 'sub-aisha',
    occurredAt: at(12),
    claimVersion: 5,
    claimId,
    receiptId: 'r-7731',
    objectKey: 'receipts/r-7731',
  });
  const options: CommitOptions = {
    events: [cleanup],
    idempotency: completed,
  };

  it('commits update, history, attach, retire, cleanup event, then idempotency', async () => {
    const { executor, writer } = setup();

    await writer.replaceReceipt(input, options);

    expect(executor.inputs).toEqual([
      composeBusinessTransaction({
        tableName,
        businessItems: [
          ...updateClaimOperations(tableName, change, 4, 2),
          attachReceiptOperation(
            tableName,
            newPending,
            newAttached,
            'sub-aisha',
          ),
          retireReceiptOperation(tableName, oldAttached, oldRetired, at(12)),
        ],
        events: [cleanup],
        completed,
      }),
    ]);
    expect(keysOf(executor.inputs[0]!)).toEqual([
      `Update CLAIM#${claimId} CLAIM`,
      `Put CLAIM#${claimId} HISTORY#0000000005`,
      'Update RECEIPT#r-8000 RECEIPT',
      'Update RECEIPT#r-7731 RECEIPT',
      `Put CLAIM#${claimId} OUTBOX#${at(12)}#${ids.eventId}`,
      expect.stringMatching(/^Put IDEMPOTENCY#/),
    ]);
  });

  it('links the new and old receipts and targets the old object', async () => {
    const { executor, writer } = setup();

    await writer.replaceReceipt(input, options);

    const items = executor.inputs[0]!.TransactItems!;
    expect(items[0]!.Update!.ConditionExpression).toBe(claimOwnerCondition);
    expect(items[0]!.Update!.ExpressionAttributeValues).toMatchObject({
      ':expectedVersion': 4,
      ':lastEventVersion': 2,
      ':receipt': change.claim.receipt,
    });
    expect(items[2]!.Update!.ConditionExpression).toBe(receiptAttachCondition);
    expect(items[2]!.Update!.ExpressionAttributeValues).toMatchObject({
      ':attachedClaimId': claimId,
      ':objectKey': 'receipts/r-8000',
    });
    expect(items[3]!.Update!.ConditionExpression).toBe(receiptRetireCondition);
    expect(items[3]!.Update!.ExpressionAttributeValues).toEqual({
      ':state': 'REPLACED',
      ':expiresAt': retiredReceiptExpiresAt(at(12)),
      ':attached': 'ATTACHED',
      ':claimId': claimId,
    });
    const event = items[4]!.Put!.Item!;
    expect(event).toMatchObject({
      eventType: 'internal.receipt-object-deletion-requested',
      payload: {
        claimId,
        receiptId: 'r-7731',
        objectKey: 'receipts/r-7731',
      },
      aggregate: { version: 5, previousEventVersion: null },
    });
    expect(JSON.stringify(event)).not.toContain('r-8000');
    expect(JSON.stringify(items.slice(0, 2))).not.toContain('CATEGORIES');
  });

  it('keeps the stored event version, whether or not one exists', async () => {
    const { executor, writer } = setup();

    await writer.replaceReceipt(input, options);
    await writer.replaceReceipt(
      { ...input, storedLastEventVersion: undefined },
      options,
    );

    const [first, second] = executor.inputs.map(
      (item) => item.TransactItems![0]!.Update!.ExpressionAttributeValues!,
    );
    expect(first).toMatchObject({ ':lastEventVersion': 2 });
    expect(second).not.toHaveProperty(':lastEventVersion');
  });

  it('has a deterministic token changed by the payload', async () => {
    const { executor, writer } = setup();

    await writer.replaceReceipt(input, options);
    await writer.replaceReceipt(input, options);
    await writer.replaceReceipt(
      { ...input, storedLastEventVersion: 3 },
      options,
    );
    await writer.replaceReceipt(input, {
      ...options,
      events: [
        buildReceiptDeletionEvent({
          ...ids,
          eventId: 'event-other-0001',
          actorId: 'sub-aisha',
          occurredAt: at(12),
          claimVersion: 5,
          claimId,
          receiptId: 'r-7731',
          objectKey: 'receipts/r-7731',
        }),
      ],
    });

    const [a, b, c, d] = executor.inputs.map((item) => item.ClientRequestToken);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(d).not.toBe(a);
  });

  describe('refuses before sending', () => {
    const withClaim = (patch: Partial<Claim>): ReplaceReceiptInput => ({
      ...input,
      change: { ...change, claim: { ...change.claim, ...patch } },
    });
    const withNewReceipt = (patch: object): ReplaceReceiptInput =>
      withClaim({ receipt: { ...change.claim.receipt!, ...patch } });
    const withEvent = (patch: object): CommitOptions => ({
      ...options,
      events: [{ ...cleanup, ...patch }],
    });

    it.each([
      [
        'a missing input',
        undefined,
        options,
        'The receipt replacement is missing.',
      ],
      ['missing options', input, undefined, 'The commit options are missing.'],
      [
        'a missing previous claim',
        { ...input, previousClaim: undefined },
        options,
        'The previous claim is missing.',
      ],
      [
        'a missing change',
        { ...input, change: undefined },
        options,
        'The claim change is missing.',
      ],
      [
        'a missing receipt record',
        { ...input, oldRetiredReceipt: undefined },
        options,
        'A receipt record is missing.',
      ],
      [
        'a first attachment',
        {
          ...input,
          change: {
            ...change,
            history: { ...change.history, action: 'ATTACH_RECEIPT' },
          },
        },
        options,
        'Only a receipt replacement can be written.',
      ],
      [
        'a removal',
        {
          ...input,
          change: {
            ...change,
            history: { ...change.history, action: 'REMOVE_RECEIPT' },
          },
        },
        options,
        'Only a receipt replacement can be written.',
      ],
      [
        'a submitted previous claim',
        { ...input, previousClaim: { ...previous, status: 'SUBMITTED' } },
        options,
        'Only a draft can have its receipt replaced.',
      ],
      [
        'a submitted new claim',
        withClaim({ status: 'SUBMITTED' }),
        options,
        'Only a draft can have its receipt replaced.',
      ],
      [
        'another claim ID',
        withClaim({ claimId: 'other-claim' }),
        options,
        'The changed claim does not match the previous claim.',
      ],
      [
        'another owner',
        withClaim({ employeeId: 'sub-ben' }),
        options,
        'The changed claim does not match the previous claim.',
      ],
      [
        'another category',
        withClaim({ categoryId: 'meals' }),
        options,
        'The changed claim does not match the previous claim.',
      ],
      [
        'a previous claim without a receipt',
        { ...input, previousClaim: { ...previous, receipt: undefined } },
        options,
        'The previous claim has no receipt.',
      ],
      [
        'a changed claim without a receipt',
        {
          ...input,
          change: {
            ...change,
            claim: (({ receipt: _r, ...rest }) => ({ ...rest, version: 5 }))(
              previous,
            ),
          },
        },
        options,
        'The changed claim has no receipt.',
      ],
      [
        'the same receipt ID',
        withNewReceipt({ receiptId: 'r-7731' }),
        options,
        'The new receipt must differ from the previous one.',
      ],
      [
        'an old record for another claim',
        {
          ...input,
          oldAttachedReceipt: {
            ...oldAttached,
            attachedClaimId: 'other-claim',
          },
        },
        options,
        'The previous receipt record does not match the previous claim.',
      ],
      [
        'an old record with another owner',
        {
          ...input,
          oldAttachedReceipt: { ...oldAttached, ownerId: 'sub-ben' },
        },
        options,
        'The previous receipt record does not match the previous claim.',
      ],
      [
        'an old record with another receipt ID',
        {
          ...input,
          oldAttachedReceipt: { ...oldAttached, receiptId: 'r-0001' },
        },
        options,
        'The previous receipt record does not match the previous claim.',
      ],
      [
        'an old record with another checksum',
        {
          ...input,
          oldAttachedReceipt: {
            ...oldAttached,
            checksumSha256: 'b'.repeat(64),
          },
        },
        options,
        'The previous receipt record does not match the previous claim.',
      ],
      [
        'an old record retired as removed',
        { ...input, oldRetiredReceipt: { ...oldRetired, state: 'REMOVED' } },
        options,
        'The previous receipt must be marked as replaced.',
      ],
      [
        'a new record for another claim',
        {
          ...input,
          newAttachedReceipt: {
            ...newAttached,
            attachedClaimId: 'other-claim',
          },
        },
        options,
        'The attached receipt does not belong to the claim.',
      ],
      [
        'a new record with another owner',
        {
          ...input,
          newPendingReceipt: { ...newPending, ownerId: 'sub-ben' },
          newAttachedReceipt: { ...newAttached, ownerId: 'sub-ben' },
        },
        options,
        'The attached receipt does not belong to the claim.',
      ],
      [
        'an actor who is not the new receipt owner',
        {
          ...input,
          change: {
            ...change,
            history: { ...change.history, actorId: 'sub-ben' },
          },
        },
        options,
        'The attached receipt does not belong to the claim.',
      ],
      [
        'new claim receipt values that differ',
        withNewReceipt({ sizeBytes: 1 }),
        options,
        'The claim receipt does not match the attached receipt.',
      ],
      [
        'an attachment time other than the history time',
        withNewReceipt({ attachedAt: at(13) }),
        options,
        'The claim receipt does not match the attached receipt.',
      ],
      [
        'a category guard',
        input,
        {
          ...options,
          categoryGuard: {
            categoryId: 'travel',
            readVersion: 1,
            mustBeActive: true,
          },
        },
        'A receipt replacement cannot carry a category guard.',
      ],
      [
        'a missing idempotency record',
        input,
        { events: [cleanup] },
        'A receipt replacement requires an idempotency record.',
      ],
      [
        'events that are not a list',
        input,
        { idempotency: completed },
        'The commit options must list their events.',
      ],
      [
        'no event',
        input,
        { ...options, events: [] },
        'A receipt replacement publishes exactly one cleanup event.',
      ],
      [
        'an extra event',
        input,
        { ...options, events: [cleanup, cleanup] },
        'A receipt replacement publishes exactly one cleanup event.',
      ],
      [
        'a cleanup event for the new receipt',
        input,
        withEvent({
          payload: {
            claimId,
            receiptId: 'r-8000',
            objectKey: 'receipts/r-8000',
          },
        }),
        'The cleanup event does not match the change.',
      ],
      [
        'a cleanup event of another type',
        input,
        withEvent({ eventType: 'internal.claim-history-purge-requested' }),
        'The cleanup event does not match the change.',
      ],
      [
        'a cleanup event for another actor',
        input,
        withEvent({ actorId: 'sub-zed' }),
        'The cleanup event does not match the change.',
      ],
      [
        'a cleanup event at another time',
        input,
        withEvent({ occurredAt: at(13) }),
        'The cleanup event does not match the change.',
      ],
      [
        'a cleanup event with another aggregate version',
        input,
        withEvent({ aggregate: { ...cleanup.aggregate, version: 4 } }),
        'The cleanup event does not match the change.',
      ],
      [
        'a cleanup event that joins the published sequence',
        input,
        withEvent({
          aggregate: { ...cleanup.aggregate, previousEventVersion: 2 },
        }),
        'The cleanup event does not match the change.',
      ],
      [
        'a cleanup event with an extra field',
        input,
        withEvent({ note: 'extra' }),
        'The cleanup event does not match the change.',
      ],
      [
        'a non-object event',
        input,
        { ...options, events: ['event'] },
        'The cleanup event does not match the change.',
      ],
    ])('%s', async (_name, bad, commit, message) => {
      const { executor, writer } = setup();

      await expect(
        writer.replaceReceipt(
          bad as unknown as ReplaceReceiptInput,
          commit as unknown as CommitOptions,
        ),
      ).rejects.toThrow(new TypeError(message));
      expect(executor.inputs).toEqual([]);
    });

    it('refuses invalid records, TTLs, versions and idempotency data', async () => {
      const { executor, writer } = setup();
      const invalid: Promise<void>[] = [
        writer.replaceReceipt(
          { ...input, previousClaim: { ...previous, version: 0 } },
          options,
        ),
        writer.replaceReceipt(
          { ...input, previousClaim: { ...previous, version: 3 } },
          options,
        ),
        writer.replaceReceipt({ ...input, storedLastEventVersion: 9 }, options),
        writer.replaceReceipt(
          {
            ...input,
            oldRetiredReceipt: {
              ...oldRetired,
              expiresAt: retiredReceiptExpiresAt(at(13)),
            },
          },
          options,
        ),
        writer.replaceReceipt(
          { ...input, newPendingReceipt: { ...newPending, expiresAt: 5 } },
          options,
        ),
        writer.replaceReceipt(
          {
            ...input,
            newPendingReceipt: { ...newPending, declaredSizeBytes: 1 },
          },
          options,
        ),
        writer.replaceReceipt(input, {
          ...options,
          idempotency: { ...completed, fingerprint: 'short' },
        }),
      ];

      for (const promise of invalid) {
        await expect(promise).rejects.toBeInstanceOf(Error);
      }
      expect(executor.inputs).toEqual([]);
    });

    it('echoes no supplied value in its own messages', async () => {
      const { writer } = setup();
      const secret = 'Secret Payslip.pdf';
      const failures = await Promise.allSettled([
        writer.replaceReceipt(withNewReceipt({ fileName: secret }), options),
        writer.replaceReceipt(
          {
            ...input,
            oldAttachedReceipt: { ...oldAttached, fileName: secret },
          },
          options,
        ),
        writer.replaceReceipt(input, withEvent({ actorId: secret })),
        writer.replaceReceipt(withClaim({ employeeId: secret }), options),
      ]);
      for (const failure of failures) {
        expect(failure.status).toBe('rejected');
        const message = String((failure as PromiseRejectedResult).reason);
        expect(message).not.toContain('Secret');
        expect(message).not.toContain('Confidential');
      }
    });
  });

  it('prepares the transaction it sends, without executing', async () => {
    const { executor, writer } = setup();
    await expectPreparation(
      executor,
      () => writer.prepareReplaceReceipt(input, options),
      () => writer.replaceReceipt(input, options),
      () => writer.prepareReplaceReceipt(input, undefined as never),
    );
  });

  it('sends one command and propagates errors unchanged', async () => {
    const client = {
      commands: [] as TransactWriteCommand[],
      failure: undefined as Error | undefined,
      send(command: TransactWriteCommand) {
        this.commands.push(command);
        return this.failure === undefined
          ? Promise.resolve({ $metadata: {} } as TransactWriteCommandOutput)
          : Promise.reject(this.failure);
      },
    };
    const writer = new DynamoDbClaimWriter({
      executor: new DynamoDbTransactionExecutor({ client }),
      tableName,
    });

    await writer.replaceReceipt(input, options);
    expect(client.commands).toHaveLength(1);
    expect(client.commands[0]).toBeInstanceOf(TransactWriteCommand);

    const failure = Object.assign(new Error('TransactionCanceledException'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
    });
    client.failure = failure;
    await expect(writer.replaceReceipt(input, options)).rejects.toBe(failure);
    expect(client.commands).toHaveLength(2);

    const { executor, writer: fake } = setup();
    const executorFailure = new Error('IdempotentParameterMismatchException');
    executor.failure = executorFailure;
    await expect(fake.replaceReceipt(input, options)).rejects.toBe(
      executorFailure,
    );
    expect(executor.inputs).toHaveLength(1);
  });
});

describe('removeReceipt', () => {
  const at = (minute: number) =>
    new Date(
      Date.parse('2026-10-14T10:00:00.000Z') + minute * 60_000,
    ).toISOString();
  const checksum = 'a1b2'.repeat(16);

  const attached: AttachedReceiptRecord = {
    receiptId: 'r-7731',
    ownerId: 'sub-aisha',
    state: 'ATTACHED',
    fileName: 'flight.pdf',
    contentType: 'application/pdf',
    sizeBytes: 52_144,
    checksumSha256: checksum,
    uploadedAt: at(5),
    attachedClaimId: claimId,
  };
  const retired: RetiredReceiptRecord = {
    ...attached,
    state: 'REMOVED',
    expiresAt: retiredReceiptExpiresAt(at(12)),
  };
  const previous: Claim = {
    ...categorized.claim,
    version: 4,
    updatedAt: at(8),
    receipt: {
      receiptId: 'r-7731',
      fileName: 'flight.pdf',
      contentType: 'application/pdf',
      sizeBytes: 52_144,
      checksumSha256: checksum,
      attachedAt: at(8),
    },
  };
  const { receipt: _removed, ...withoutReceipt } = previous;
  const change: ClaimChange = {
    claim: { ...withoutReceipt, version: 5, updatedAt: at(12) },
    history: {
      claimId,
      version: 5,
      action: 'REMOVE_RECEIPT',
      fromStatus: 'DRAFT',
      toStatus: 'DRAFT',
      actorId: 'sub-aisha',
      occurredAt: at(12),
    },
  };
  const input: RemoveReceiptInput = {
    previousClaim: previous,
    change,
    attachedReceipt: attached,
    retiredReceipt: retired,
    storedLastEventVersion: 2,
  };
  const ids: ClaimEventIds = {
    eventId: '1c9e7b2a-3d4f-4e5a-8b6c-7d8e9f0a1b2c',
    correlationId: 'c0ffee00-1111-2222-3333-444455556667',
    causationId: 'request-8a41',
  };
  const deletion = (patch: object = {}) =>
    buildReceiptDeletionEvent({
      ...ids,
      actorId: 'sub-aisha',
      occurredAt: at(12),
      claimVersion: 5,
      claimId,
      receiptId: 'r-7731',
      objectKey: 'receipts/r-7731',
      ...patch,
    });
  const cleanup = deletion();
  const options: CommitOptions = {
    events: [cleanup],
    idempotency: completed,
  };

  it('commits update, history, retirement, cleanup event, then idempotency', async () => {
    const { executor, writer } = setup();

    await writer.removeReceipt(input, options);

    expect(executor.inputs).toEqual([
      composeBusinessTransaction({
        tableName,
        businessItems: [
          ...updateClaimOperations(tableName, change, 4, 2),
          retireReceiptOperation(tableName, attached, retired, at(12)),
        ],
        events: [cleanup],
        completed,
      }),
    ]);
    expect(keysOf(executor.inputs[0]!)).toEqual([
      `Update CLAIM#${claimId} CLAIM`,
      `Put CLAIM#${claimId} HISTORY#0000000005`,
      'Update RECEIPT#r-7731 RECEIPT',
      `Put CLAIM#${claimId} OUTBOX#${at(12)}#${ids.eventId}`,
      expect.stringMatching(/^Put IDEMPOTENCY#/),
    ]);
  });

  it('drops the claim receipt, retires the receipt, and targets its object', async () => {
    const { executor, writer } = setup();

    await writer.removeReceipt(input, options);

    const items = executor.inputs[0]!.TransactItems!;
    const claimUpdate = items[0]!.Update!;
    expect(claimUpdate.ConditionExpression).toBe(claimOwnerCondition);
    expect(claimUpdate.UpdateExpression).toMatch(/REMOVE .*#receipt/);
    expect(claimUpdate.ExpressionAttributeValues).toMatchObject({
      ':expectedVersion': 4,
      ':lastEventVersion': 2,
    });
    expect(claimUpdate.ExpressionAttributeValues).not.toHaveProperty(
      ':receipt',
    );
    expect(items[2]!.Update!.ConditionExpression).toBe(receiptRetireCondition);
    expect(items[2]!.Update!.ExpressionAttributeValues).toEqual({
      ':state': 'REMOVED',
      ':expiresAt': retiredReceiptExpiresAt(at(12)),
      ':attached': 'ATTACHED',
      ':claimId': claimId,
    });
    expect(items[3]!.Put!.Item).toMatchObject({
      eventType: 'internal.receipt-object-deletion-requested',
      payload: {
        claimId,
        receiptId: 'r-7731',
        objectKey: 'receipts/r-7731',
      },
      aggregate: { version: 5, previousEventVersion: null },
    });
    expect(items).toHaveLength(5);
    expect(JSON.stringify(items)).not.toContain('CATEGORIES');
  });

  it('keeps the stored event version, whether or not one exists', async () => {
    const { executor, writer } = setup();

    await writer.removeReceipt(input, options);
    await writer.removeReceipt(
      { ...input, storedLastEventVersion: undefined },
      options,
    );

    const [first, second] = executor.inputs.map(
      (item) => item.TransactItems![0]!.Update!.ExpressionAttributeValues!,
    );
    expect(first).toMatchObject({ ':lastEventVersion': 2 });
    expect(second).not.toHaveProperty(':lastEventVersion');
  });

  it('has a deterministic token changed by the payload', async () => {
    const { executor, writer } = setup();

    await writer.removeReceipt(input, options);
    await writer.removeReceipt(input, options);
    await writer.removeReceipt(
      { ...input, storedLastEventVersion: 3 },
      options,
    );
    await writer.removeReceipt(input, {
      ...options,
      events: [deletion({ eventId: 'event-other-0001' })],
    });

    const [a, b, c, d] = executor.inputs.map((item) => item.ClientRequestToken);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(d).not.toBe(a);
  });

  describe('refuses before sending', () => {
    const withClaim = (patch: Partial<Claim>): RemoveReceiptInput => ({
      ...input,
      change: { ...change, claim: { ...change.claim, ...patch } },
    });
    const withEvent = (patch: object): CommitOptions => ({
      ...options,
      events: [{ ...cleanup, ...patch }],
    });
    const withHistory = (patch: object): RemoveReceiptInput => ({
      ...input,
      change: { ...change, history: { ...change.history, ...patch } },
    });

    it.each([
      [
        'a missing input',
        undefined,
        options,
        'The receipt removal is missing.',
      ],
      ['missing options', input, undefined, 'The commit options are missing.'],
      [
        'a missing previous claim',
        { ...input, previousClaim: undefined },
        options,
        'The previous claim is missing.',
      ],
      [
        'a missing change',
        { ...input, change: undefined },
        options,
        'The claim change is missing.',
      ],
      [
        'a missing receipt record',
        { ...input, retiredReceipt: undefined },
        options,
        'A receipt record is missing.',
      ],
      [
        'a replacement',
        withHistory({ action: 'REPLACE_RECEIPT' }),
        options,
        'Only a receipt removal can be written.',
      ],
      [
        'a draft edit',
        withHistory({ action: 'UPDATE' }),
        options,
        'Only a receipt removal can be written.',
      ],
      [
        'a submitted previous claim',
        { ...input, previousClaim: { ...previous, status: 'SUBMITTED' } },
        options,
        'Only a draft can have its receipt removed.',
      ],
      [
        'a submitted new claim',
        withClaim({ status: 'SUBMITTED' }),
        options,
        'Only a draft can have its receipt removed.',
      ],
      [
        'another claim ID',
        withClaim({ claimId: 'other-claim' }),
        options,
        'The changed claim does not match the previous claim.',
      ],
      [
        'another owner',
        withClaim({ employeeId: 'sub-ben' }),
        options,
        'The changed claim does not match the previous claim.',
      ],
      [
        'another category',
        withClaim({ categoryId: 'meals' }),
        options,
        'The changed claim does not match the previous claim.',
      ],
      [
        'a previous claim without a receipt',
        { ...input, previousClaim: withoutReceipt },
        options,
        'The previous claim has no receipt.',
      ],
      [
        'a changed claim that keeps a receipt',
        withClaim({ receipt: previous.receipt! }),
        options,
        'The changed claim still has a receipt.',
      ],
      [
        'a record for another claim',
        {
          ...input,
          attachedReceipt: { ...attached, attachedClaimId: 'other' },
        },
        options,
        'The previous receipt record does not match the previous claim.',
      ],
      [
        'a record with another owner',
        { ...input, attachedReceipt: { ...attached, ownerId: 'sub-ben' } },
        options,
        'The previous receipt record does not match the previous claim.',
      ],
      [
        'a record with another receipt ID',
        { ...input, attachedReceipt: { ...attached, receiptId: 'r-0001' } },
        options,
        'The previous receipt record does not match the previous claim.',
      ],
      [
        'a record with another file name',
        { ...input, attachedReceipt: { ...attached, fileName: 'other.pdf' } },
        options,
        'The previous receipt record does not match the previous claim.',
      ],
      [
        'a record with another content type',
        {
          ...input,
          attachedReceipt: { ...attached, contentType: 'image/png' },
        },
        options,
        'The previous receipt record does not match the previous claim.',
      ],
      [
        'a record with another size',
        { ...input, attachedReceipt: { ...attached, sizeBytes: 1 } },
        options,
        'The previous receipt record does not match the previous claim.',
      ],
      [
        'a record with another checksum',
        {
          ...input,
          attachedReceipt: { ...attached, checksumSha256: 'b'.repeat(64) },
        },
        options,
        'The previous receipt record does not match the previous claim.',
      ],
      [
        'an actor who is not the receipt owner',
        withHistory({ actorId: 'sub-ben' }),
        options,
        'The attached receipt does not belong to the actor.',
      ],
      [
        'a record retired as replaced',
        { ...input, retiredReceipt: { ...retired, state: 'REPLACED' } },
        options,
        'The removed receipt must be marked as removed.',
      ],
      [
        'a category guard',
        input,
        {
          ...options,
          categoryGuard: {
            categoryId: 'travel',
            readVersion: 1,
            mustBeActive: true,
          },
        },
        'A receipt removal cannot carry a category guard.',
      ],
      [
        'a missing idempotency record',
        input,
        { events: [cleanup] },
        'A receipt removal requires an idempotency record.',
      ],
      [
        'events that are not a list',
        input,
        { idempotency: completed },
        'The commit options must list their events.',
      ],
      [
        'no event',
        input,
        { ...options, events: [] },
        'A receipt removal publishes exactly one cleanup event.',
      ],
      [
        'an extra event',
        input,
        { ...options, events: [cleanup, cleanup] },
        'A receipt removal publishes exactly one cleanup event.',
      ],
      [
        'a cleanup event for another receipt',
        input,
        withEvent({
          payload: {
            claimId,
            receiptId: 'r-8000',
            objectKey: 'receipts/r-8000',
          },
        }),
        'The cleanup event does not match the change.',
      ],
      [
        'a cleanup event of another type',
        input,
        withEvent({ eventType: 'internal.claim-history-purge-requested' }),
        'The cleanup event does not match the change.',
      ],
      [
        'a cleanup event for another actor',
        input,
        withEvent({ actorId: 'sub-zed' }),
        'The cleanup event does not match the change.',
      ],
      [
        'a cleanup event at another time',
        input,
        withEvent({ occurredAt: at(13) }),
        'The cleanup event does not match the change.',
      ],
      [
        'a cleanup event with another aggregate version',
        input,
        withEvent({ aggregate: { ...cleanup.aggregate, version: 4 } }),
        'The cleanup event does not match the change.',
      ],
      [
        'a cleanup event that joins the published sequence',
        input,
        withEvent({
          aggregate: { ...cleanup.aggregate, previousEventVersion: 2 },
        }),
        'The cleanup event does not match the change.',
      ],
      [
        'a cleanup event with an extra field',
        input,
        withEvent({ note: 'extra' }),
        'The cleanup event does not match the change.',
      ],
      [
        'a non-object event',
        input,
        { ...options, events: ['event'] },
        'The cleanup event does not match the change.',
      ],
    ])('%s', async (_name, bad, commit, message) => {
      const { executor, writer } = setup();

      await expect(
        writer.removeReceipt(
          bad as unknown as RemoveReceiptInput,
          commit as unknown as CommitOptions,
        ),
      ).rejects.toThrow(new TypeError(message));
      expect(executor.inputs).toEqual([]);
    });

    it('refuses invalid records, TTLs, versions and idempotency data', async () => {
      const { executor, writer } = setup();
      const invalid: Promise<void>[] = [
        writer.removeReceipt(
          { ...input, previousClaim: { ...previous, version: 0 } },
          options,
        ),
        writer.removeReceipt(
          { ...input, previousClaim: { ...previous, version: 3 } },
          options,
        ),
        writer.removeReceipt({ ...input, storedLastEventVersion: 9 }, options),
        writer.removeReceipt(
          {
            ...input,
            retiredReceipt: {
              ...retired,
              expiresAt: retiredReceiptExpiresAt(at(13)),
            },
          },
          options,
        ),
        writer.removeReceipt(input, {
          ...options,
          idempotency: { ...completed, fingerprint: 'short' },
        }),
      ];

      for (const promise of invalid) {
        await expect(promise).rejects.toBeInstanceOf(Error);
      }
      expect(executor.inputs).toEqual([]);
    });

    it('echoes no supplied value in its own messages', async () => {
      const { writer } = setup();
      const secret = 'Secret Payslip.pdf';
      const failures = await Promise.allSettled([
        writer.removeReceipt(
          { ...input, attachedReceipt: { ...attached, fileName: secret } },
          options,
        ),
        writer.removeReceipt(input, withEvent({ actorId: secret })),
        writer.removeReceipt(withClaim({ employeeId: secret }), options),
        writer.removeReceipt(withHistory({ actorId: secret }), options),
      ]);
      for (const failure of failures) {
        expect(failure.status).toBe('rejected');
        const message = String((failure as PromiseRejectedResult).reason);
        expect(message).not.toContain('Secret');
        expect(message).not.toContain('Confidential');
      }
    });
  });

  it('prepares the transaction it sends, without executing', async () => {
    const { executor, writer } = setup();
    await expectPreparation(
      executor,
      () => writer.prepareRemoveReceipt(input, options),
      () => writer.removeReceipt(input, options),
      () => writer.prepareRemoveReceipt(input, undefined as never),
    );
  });

  it('sends one command and propagates errors unchanged', async () => {
    const client = {
      commands: [] as TransactWriteCommand[],
      failure: undefined as Error | undefined,
      send(command: TransactWriteCommand) {
        this.commands.push(command);
        return this.failure === undefined
          ? Promise.resolve({ $metadata: {} } as TransactWriteCommandOutput)
          : Promise.reject(this.failure);
      },
    };
    const writer = new DynamoDbClaimWriter({
      executor: new DynamoDbTransactionExecutor({ client }),
      tableName,
    });

    await writer.removeReceipt(input, options);
    expect(client.commands).toHaveLength(1);
    expect(client.commands[0]).toBeInstanceOf(TransactWriteCommand);

    const failure = Object.assign(new Error('TransactionCanceledException'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
    });
    client.failure = failure;
    await expect(writer.removeReceipt(input, options)).rejects.toBe(failure);
    expect(client.commands).toHaveLength(2);

    const { executor, writer: fake } = setup();
    const executorFailure = new Error('IdempotentParameterMismatchException');
    executor.failure = executorFailure;
    await expect(fake.removeReceipt(input, options)).rejects.toBe(
      executorFailure,
    );
    expect(executor.inputs).toHaveLength(1);
  });
});

describe('deleteDraft', () => {
  const at = (minute: number) =>
    new Date(
      Date.parse('2026-10-14T10:00:00.000Z') + minute * 60_000,
    ).toISOString();
  const checksum = 'a1b2'.repeat(16);
  const changedAt = at(12);

  const attached: AttachedReceiptRecord = {
    receiptId: 'r-7731',
    ownerId: 'sub-aisha',
    state: 'ATTACHED',
    fileName: 'flight.pdf',
    contentType: 'application/pdf',
    sizeBytes: 52_144,
    checksumSha256: checksum,
    uploadedAt: at(5),
    attachedClaimId: claimId,
  };
  const retired: RetiredReceiptRecord = {
    ...attached,
    state: 'REMOVED',
    expiresAt: retiredReceiptExpiresAt(changedAt),
  };
  const receipt = {
    receiptId: 'r-7731',
    fileName: 'flight.pdf',
    contentType: 'application/pdf' as const,
    sizeBytes: 52_144,
    checksumSha256: checksum,
    attachedAt: at(8),
  };
  const base: Claim = {
    ...categorized.claim,
    version: 4,
    updatedAt: at(8),
  };
  const bare = (claim: Claim): Claim => {
    const { categoryId: _c, ...rest } = claim;
    return rest;
  };
  const ids: ClaimEventIds = {
    eventId: '1c9e7b2a-3d4f-4e5a-8b6c-7d8e9f0a1b2c',
    correlationId: 'c0ffee00-1111-2222-3333-444455556667',
    causationId: 'request-8a41',
  };
  const secondId = '2d0f8c3b-4e5f-4f6b-9c7d-8e9f0a1b2c3d';
  const context = {
    ...ids,
    actorId: 'sub-aisha',
    occurredAt: changedAt,
    claimVersion: 5,
    claimId,
  };
  const purge = (patch: object = {}) =>
    buildHistoryPurgeEvent({ ...context, ...patch });
  const deletion = (patch: object = {}) =>
    buildReceiptDeletionEvent({
      ...context,
      eventId: secondId,
      receiptId: 'r-7731',
      objectKey: 'receipts/r-7731',
      ...patch,
    });

  function scenario(withCategory: boolean, withReceipt: boolean) {
    const claim: Claim = {
      ...(withCategory ? base : bare(base)),
      ...(withReceipt ? { receipt } : {}),
    };
    const input: DeleteDraftInput = {
      claim,
      actorId: 'sub-aisha',
      changedAt,
      ...(withReceipt
        ? { attachedReceipt: attached, retiredReceipt: retired }
        : {}),
    };
    const options: CommitOptions = {
      events: withReceipt ? [purge(), deletion()] : [purge()],
      idempotency: completed,
    };
    return { claim, input, options };
  }

  const combinations: [string, boolean, boolean, string[]][] = [
    ['no category and no receipt', false, false, []],
    ['a category and no receipt', true, false, ['CATEGORIES CATEGORY#travel']],
    ['a receipt and no category', false, true, ['RECEIPT#r-7731 RECEIPT']],
    [
      'a category and a receipt',
      true,
      true,
      ['CATEGORIES CATEGORY#travel', 'RECEIPT#r-7731 RECEIPT'],
    ],
  ];

  it.each(combinations)(
    'commits a draft with %s in the required order',
    async (_name, withCategory, withReceipt, businessKeys) => {
      const { executor, writer } = setup();
      const { claim, input, options } = scenario(withCategory, withReceipt);

      await writer.deleteDraft(input, options);

      const expectedBusiness = [
        deleteDraftOperation(tableName, claim, 'sub-aisha', 4),
        ...(withCategory
          ? [decrementClaimCountOperation(tableName, 'travel')]
          : []),
        ...(withReceipt
          ? [retireReceiptOperation(tableName, attached, retired, changedAt)]
          : []),
      ];
      expect(executor.inputs).toEqual([
        composeBusinessTransaction({
          tableName,
          businessItems: expectedBusiness,
          events: options.events,
          completed,
        }),
      ]);
      const items = executor.inputs[0]!.TransactItems!;
      expect(items.length).toBeLessThanOrEqual(6);
      expect(keysOf(executor.inputs[0]!)).toEqual([
        `Delete CLAIM#${claimId} CLAIM`,
        ...businessKeys.map((key) =>
          key.startsWith('CATEGORIES') ? `Update ${key}` : `Update ${key}`,
        ),
        `Put CLAIM#${claimId} OUTBOX#${changedAt}#${ids.eventId}`,
        ...(withReceipt
          ? [`Put CLAIM#${claimId} OUTBOX#${changedAt}#${secondId}`]
          : []),
        expect.stringMatching(/^Put IDEMPOTENCY#/),
      ]);
      // No history entry is written or deleted, and no ConditionCheck is used.
      expect(JSON.stringify(items)).not.toContain('HISTORY#');
      expect(items.some((item) => item.ConditionCheck !== undefined)).toBe(
        false,
      );
      expect(
        items.some((item) => item.Delete?.Key?.SK !== 'CLAIM' && item.Delete),
      ).toBe(false);
    },
  );

  it('deletes only the owned, unchanged draft at its version', async () => {
    const { executor, writer } = setup();
    const { input, options } = scenario(true, true);

    await writer.deleteDraft(input, options);

    const items = executor.inputs[0]!.TransactItems!;
    expect(items[0]!.Delete!.ConditionExpression).toBe(draftDeleteCondition);
    expect(items[0]!.Delete!.ExpressionAttributeValues).toMatchObject({
      ':expectedVersion': 4,
      ':actorId': 'sub-aisha',
      ':draft': 'DRAFT',
    });
    expect(items[1]!.Update!.ConditionExpression).toBe(
      claimCountDecrementCondition,
    );
    expect(items[1]!.Update!.ExpressionAttributeValues).toEqual({
      ':minusOne': -1,
      ':one': 1,
    });
  });

  it('retires the receipt with a TTL 30 days after the deletion time', async () => {
    const { executor, writer } = setup();
    const { input, options } = scenario(false, true);

    await writer.deleteDraft(input, options);

    const retire = executor.inputs[0]!.TransactItems![1]!.Update!;
    expect(retire.ConditionExpression).toBe(receiptRetireCondition);
    expect(retire.ExpressionAttributeValues).toEqual({
      ':state': 'REMOVED',
      ':expiresAt': retiredReceiptExpiresAt(changedAt),
      ':attached': 'ATTACHED',
      ':claimId': claimId,
    });
  });

  it('writes cleanup events at the next claim version, outside the published sequence', async () => {
    const { executor, writer } = setup();
    const { input, options } = scenario(true, true);

    await writer.deleteDraft(input, options);

    const items = executor.inputs[0]!.TransactItems!;
    const [first, second] = [items[3]!.Put!.Item!, items[4]!.Put!.Item!];
    expect(first).toMatchObject({
      eventType: 'internal.claim-history-purge-requested',
      payload: { claimId },
      aggregate: { version: 5, previousEventVersion: null },
    });
    expect(second).toMatchObject({
      eventType: 'internal.receipt-object-deletion-requested',
      payload: {
        claimId,
        receiptId: 'r-7731',
        objectKey: 'receipts/r-7731',
      },
      aggregate: { version: 5, previousEventVersion: null },
    });
  });

  it('has a deterministic token changed by the payload', async () => {
    const { executor, writer } = setup();
    const { input, options } = scenario(true, true);

    await writer.deleteDraft(input, options);
    await writer.deleteDraft(input, options);
    await writer.deleteDraft(input, {
      ...options,
      events: [purge({ eventId: 'event-other-0001' }), deletion()],
    });

    const [a, b, c] = executor.inputs.map((item) => item.ClientRequestToken);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });

  describe('refuses before sending', () => {
    const full = scenario(true, true);
    const plain = scenario(true, false);
    const withClaim = (
      patch: Partial<Claim>,
      from = full,
    ): DeleteDraftInput => ({
      ...from.input,
      claim: { ...from.input.claim, ...patch },
    });
    const withEvents = (events: unknown[], from = full): CommitOptions => ({
      ...from.options,
      events: events as never,
    });

    it.each([
      [
        'a missing input',
        undefined,
        full.options,
        'The draft deletion is missing.',
      ],
      [
        'a missing claim',
        { ...full.input, claim: undefined },
        full.options,
        'The claim is missing.',
      ],
      [
        'missing options',
        full.input,
        undefined,
        'The commit options are missing.',
      ],
      [
        'a deletion time that is not canonical',
        { ...full.input, changedAt: '2026-10-14' },
        full.options,
        'The deletion time is not valid.',
      ],
      [
        'a deletion time before the last update',
        { ...full.input, changedAt: at(7) },
        full.options,
        'The deletion time is before the last update.',
      ],
      [
        'a version that cannot be advanced',
        withClaim({ version: Number.MAX_SAFE_INTEGER }),
        full.options,
        'The claim version is too large to delete.',
      ],
      [
        'receipt records without a claim receipt',
        { ...plain.input, attachedReceipt: attached },
        plain.options,
        'A draft without a receipt cannot carry receipt records.',
      ],
      [
        'a claim receipt without records',
        { claim: full.claim, actorId: 'sub-aisha', changedAt },
        full.options,
        'A receipt record is missing.',
      ],
      [
        'only one receipt record',
        { ...full.input, retiredReceipt: undefined },
        full.options,
        'A receipt record is missing.',
      ],
      [
        'a record for another receipt',
        {
          ...full.input,
          attachedReceipt: { ...attached, receiptId: 'r-0001' },
        },
        full.options,
        'The previous receipt record does not match the previous claim.',
      ],
      [
        'a record for another claim',
        {
          ...full.input,
          attachedReceipt: { ...attached, attachedClaimId: 'other-claim' },
        },
        full.options,
        'The previous receipt record does not match the previous claim.',
      ],
      [
        'a record with another owner',
        { ...full.input, attachedReceipt: { ...attached, ownerId: 'sub-ben' } },
        full.options,
        'The previous receipt record does not match the previous claim.',
      ],
      [
        'a record retired as replaced',
        { ...full.input, retiredReceipt: { ...retired, state: 'REPLACED' } },
        full.options,
        'The deleted receipt must be marked as removed.',
      ],
      [
        'a category guard',
        full.input,
        {
          ...full.options,
          categoryGuard: {
            categoryId: 'travel',
            readVersion: 1,
            mustBeActive: true,
          },
        },
        'A draft deletion cannot carry a category guard.',
      ],
      [
        'a missing idempotency record',
        full.input,
        { events: full.options.events },
        'A draft deletion requires an idempotency record.',
      ],
      [
        'events that are not a list',
        full.input,
        { idempotency: completed },
        'The commit options must list their events.',
      ],
      [
        'no events',
        plain.input,
        withEvents([], plain),
        'A draft deletion publishes exactly its required cleanup events.',
      ],
      [
        'only the purge event for a receipt',
        full.input,
        withEvents([purge()]),
        'A draft deletion publishes exactly its required cleanup events.',
      ],
      [
        'a receipt event for a draft without a receipt',
        plain.input,
        withEvents([purge(), deletion()], plain),
        'A draft deletion publishes exactly its required cleanup events.',
      ],
      [
        'events in the wrong order',
        full.input,
        withEvents([
          deletion({ eventId: ids.eventId }),
          purge({ eventId: secondId }),
        ]),
        'The cleanup event does not match the change.',
      ],
      [
        'duplicate event IDs',
        full.input,
        withEvents([purge(), deletion({ eventId: ids.eventId })]),
        'The cleanup events must have distinct IDs.',
      ],
      [
        'a purge event for another claim',
        full.input,
        withEvents([purge({ claimId: 'other-claim' }), deletion()]),
        'The cleanup event does not match the change.',
      ],
      [
        'a purge event for another actor',
        full.input,
        withEvents([purge({ actorId: 'sub-zed' }), deletion()]),
        'The cleanup event does not match the change.',
      ],
      [
        'a purge event at another time',
        full.input,
        withEvents([purge({ occurredAt: at(13) }), deletion()]),
        'The cleanup event does not match the change.',
      ],
      [
        'a purge event at the claim version',
        full.input,
        withEvents([purge({ claimVersion: 4 }), deletion()]),
        'The cleanup event does not match the change.',
      ],
      [
        'a deletion event for another receipt',
        full.input,
        withEvents([
          purge(),
          deletion({ receiptId: 'r-8000', objectKey: 'receipts/r-8000' }),
        ]),
        'The cleanup event does not match the change.',
      ],
      [
        'an event with an extra field',
        full.input,
        withEvents([{ ...purge(), note: 'extra' }, deletion()]),
        'The cleanup event does not match the change.',
      ],
      [
        'a non-object event',
        plain.input,
        withEvents(['event'], plain),
        'The cleanup event does not match the change.',
      ],
    ])('%s', async (_name, bad, commit, message) => {
      const { executor, writer } = setup();

      await expect(
        writer.deleteDraft(
          bad as unknown as DeleteDraftInput,
          commit as unknown as CommitOptions,
        ),
      ).rejects.toThrow(new TypeError(message));
      expect(executor.inputs).toEqual([]);
    });

    it('refuses drafts that were submitted, foreign drafts and invalid data', async () => {
      const { executor, writer } = setup();
      const invalid: Promise<void>[] = [
        writer.deleteDraft(
          withClaim({ submittedAt: at(6) }, plain),
          plain.options,
        ),
        writer.deleteDraft(
          withClaim({ status: 'SUBMITTED' }, plain),
          plain.options,
        ),
        writer.deleteDraft(
          { ...plain.input, actorId: 'sub-ben' },
          {
            ...plain.options,
            events: [purge({ actorId: 'sub-ben' })],
          },
        ),
        writer.deleteDraft(withClaim({ version: 0 }, plain), plain.options),
        writer.deleteDraft(
          withClaim({ createdAt: 'yesterday' }, plain),
          plain.options,
        ),
        writer.deleteDraft(
          {
            ...full.input,
            retiredReceipt: {
              ...retired,
              expiresAt: retiredReceiptExpiresAt(at(13)),
            },
          },
          full.options,
        ),
        writer.deleteDraft(plain.input, {
          ...plain.options,
          idempotency: { ...completed, fingerprint: 'short' },
        }),
      ];

      for (const promise of invalid) {
        await expect(promise).rejects.toBeInstanceOf(Error);
      }
      expect(executor.inputs).toEqual([]);
    });

    it('echoes no supplied value in its own messages', async () => {
      const { writer } = setup();
      const secret = 'Secret Payslip.pdf';
      const failures = await Promise.allSettled([
        writer.deleteDraft(
          { ...full.input, attachedReceipt: { ...attached, fileName: secret } },
          full.options,
        ),
        writer.deleteDraft(
          full.input,
          withEvents([{ ...purge(), actorId: secret }, deletion()]),
        ),
        writer.deleteDraft({ ...full.input, actorId: secret }, full.options),
        writer.deleteDraft({ ...full.input, changedAt: secret }, full.options),
      ]);
      for (const failure of failures) {
        expect(failure.status).toBe('rejected');
        const message = String((failure as PromiseRejectedResult).reason);
        expect(message).not.toContain('Secret');
        expect(message).not.toContain('Confidential');
      }
    });
  });

  it('prepares the transaction it sends, without executing', async () => {
    const { executor, writer } = setup();
    const { input, options } = scenario(true, true);
    await expectPreparation(
      executor,
      () => writer.prepareDeleteDraft(input, options),
      () => writer.deleteDraft(input, options),
      () => writer.prepareDeleteDraft(input, undefined as never),
    );
  });

  it('sends one command and propagates errors unchanged', async () => {
    const client = {
      commands: [] as TransactWriteCommand[],
      failure: undefined as Error | undefined,
      send(command: TransactWriteCommand) {
        this.commands.push(command);
        return this.failure === undefined
          ? Promise.resolve({ $metadata: {} } as TransactWriteCommandOutput)
          : Promise.reject(this.failure);
      },
    };
    const writer = new DynamoDbClaimWriter({
      executor: new DynamoDbTransactionExecutor({ client }),
      tableName,
    });
    const { input, options } = scenario(true, true);

    await writer.deleteDraft(input, options);
    expect(client.commands).toHaveLength(1);
    expect(client.commands[0]).toBeInstanceOf(TransactWriteCommand);

    const failure = Object.assign(new Error('TransactionCanceledException'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
    });
    client.failure = failure;
    await expect(writer.deleteDraft(input, options)).rejects.toBe(failure);
    expect(client.commands).toHaveLength(2);

    const { executor, writer: fake } = setup();
    const executorFailure = new Error('IdempotentParameterMismatchException');
    executor.failure = executorFailure;
    await expect(fake.deleteDraft(input, options)).rejects.toBe(
      executorFailure,
    );
    expect(executor.inputs).toHaveLength(1);
  });
});
