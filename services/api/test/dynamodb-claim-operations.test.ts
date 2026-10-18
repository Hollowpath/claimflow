import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  claimHistoryActions,
  type Claim,
  type ClaimChange,
  type ClaimHistoryAction,
  type ClaimHistoryEntry,
  type ClaimStatus,
} from '@claimflow/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  categoryGuardCheckOperation,
  incrementClaimCountOperation,
} from '../src/adapters/aws/dynamodb-category-operations.js';
import {
  claimManagerCondition,
  claimOwnerCondition,
  claimVersionCondition,
  ClaimOperationError,
  createClaimOperations,
  deleteDraftOperation,
  draftDeleteCondition,
  isPublishableAction,
  updateClaimOperations,
} from '../src/adapters/aws/dynamodb-claim-operations.js';
import {
  decodeClaimItem,
  encodeClaimItem,
  encodeHistoryItem,
  ItemEncodingError,
  type DynamoItem,
} from '../src/adapters/aws/dynamodb-items.js';
import {
  composeBusinessTransaction,
  type TransactionItem,
} from '../src/adapters/aws/dynamodb-transaction.js';
import type { CompletedRequest } from '../src/application/commit.js';
import { eventSource, type OutboxEvent } from '../src/application/events.js';

const tableName = 'ClaimFlow';
const claimId = '4ce0c74b-9c64-46d6-87ba-07fb71b0628c';
const merchant = 'Confidential Supplier Sdn Bhd';
const purpose = 'Client workshop for the merger';
const comment = 'Please attach the boarding pass for the return flight.';
const checksum = 'a1b2'.repeat(16);
const time = (minute: number) =>
  new Date(
    Date.parse('2026-10-14T10:00:00.000Z') + minute * 60_000,
  ).toISOString();

const draft: Claim = {
  claimId,
  employeeId: 'sub-aisha',
  categoryId: 'travel',
  amount: { amountMinor: 45_000, currency: 'MYR' },
  expenseDate: '2026-10-08',
  merchant,
  businessPurpose: purpose,
  status: 'DRAFT',
  version: 3,
  createdAt: time(0),
  updatedAt: time(3),
};

const receipt = {
  receiptId: 'r-7731',
  fileName: 'flight.pdf',
  contentType: 'application/pdf' as const,
  sizeBytes: 52_144,
  checksumSha256: checksum,
  attachedAt: time(4),
};

/** The claim before and after each update action, at versions 3 → 4. */
const scenarios: Record<
  Exclude<ClaimHistoryAction, 'CREATE'>,
  { before: Claim; after: Claim; actorId: string; comment?: string }
> = {
  UPDATE: {
    before: draft,
    // Changes the merchant and clears the expense date.
    after: {
      claimId,
      employeeId: 'sub-aisha',
      categoryId: 'travel',
      amount: { amountMinor: 45_000, currency: 'MYR' },
      merchant: 'Regional Airline',
      businessPurpose: purpose,
      status: 'DRAFT',
      version: 3,
      createdAt: time(0),
      updatedAt: time(3),
    },
    actorId: 'sub-aisha',
  },
  ATTACH_RECEIPT: {
    before: draft,
    after: { ...draft, receipt },
    actorId: 'sub-aisha',
  },
  REPLACE_RECEIPT: {
    before: { ...draft, receipt },
    after: {
      ...draft,
      receipt: {
        ...receipt,
        receiptId: 'r-8000',
        fileName: 'ticket.png',
        contentType: 'image/png',
      },
    },
    actorId: 'sub-aisha',
  },
  REMOVE_RECEIPT: {
    before: { ...draft, receipt },
    after: draft,
    actorId: 'sub-aisha',
  },
  SUBMIT: {
    before: draft,
    after: {
      ...draft,
      status: 'SUBMITTED',
      assignedManagerId: 'sub-ben',
      submittedAt: time(5),
    },
    actorId: 'sub-aisha',
  },
  START_REVIEW: {
    before: {
      ...draft,
      status: 'SUBMITTED',
      assignedManagerId: 'sub-ben',
      submittedAt: time(5),
    },
    after: {
      ...draft,
      status: 'UNDER_REVIEW',
      assignedManagerId: 'sub-ben',
      submittedAt: time(5),
    },
    actorId: 'sub-ben',
  },
  APPROVE: {
    before: {
      ...draft,
      status: 'UNDER_REVIEW',
      assignedManagerId: 'sub-ben',
      submittedAt: time(5),
    },
    after: {
      ...draft,
      status: 'APPROVED',
      assignedManagerId: 'sub-ben',
      submittedAt: time(5),
      reviewedAt: time(6),
    },
    actorId: 'sub-ben',
    comment: 'Approved.',
  },
  REJECT: {
    before: {
      ...draft,
      status: 'UNDER_REVIEW',
      assignedManagerId: 'sub-ben',
      submittedAt: time(5),
    },
    after: {
      ...draft,
      status: 'REJECTED',
      assignedManagerId: 'sub-ben',
      submittedAt: time(5),
      reviewedAt: time(6),
    },
    actorId: 'sub-ben',
    comment,
  },
  REOPEN: {
    before: {
      ...draft,
      status: 'REJECTED',
      assignedManagerId: 'sub-ben',
      submittedAt: time(5),
      reviewedAt: time(6),
    },
    after: {
      ...draft,
      status: 'DRAFT',
      assignedManagerId: 'sub-ben',
      submittedAt: time(5),
      reviewedAt: time(6),
    },
    actorId: 'sub-aisha',
  },
  MARK_PAID: {
    before: {
      ...draft,
      status: 'APPROVED',
      assignedManagerId: 'sub-ben',
      submittedAt: time(5),
      reviewedAt: time(6),
    },
    after: {
      ...draft,
      status: 'PAID',
      assignedManagerId: 'sub-ben',
      submittedAt: time(5),
      reviewedAt: time(6),
    },
    actorId: 'sub-dan',
  },
};

const updateActions = Object.keys(scenarios) as (keyof typeof scenarios)[];

/** The change an action makes: the next version, with its history entry. */
function changeFor(action: keyof typeof scenarios): ClaimChange {
  const { before, after, actorId, comment: note } = scenarios[action];
  const claim = JSON.parse(
    JSON.stringify({ ...after, version: 4, updatedAt: time(7) }),
  ) as Claim;
  const history: ClaimHistoryEntry = {
    claimId,
    version: 4,
    action,
    fromStatus: before.status,
    toStatus: claim.status,
    actorId,
    occurredAt: time(7),
    ...(note === undefined ? {} : { comment: note }),
  };
  return { claim, history };
}

/** Applies an `Update`'s SET and REMOVE clauses to a stored item. */
function applyUpdate(
  stored: DynamoItem,
  operation: TransactionItem,
): DynamoItem {
  const update = operation.Update!;
  const names = update.ExpressionAttributeNames ?? {};
  const values = update.ExpressionAttributeValues ?? {};
  const [, setPart = '', removePart = ''] =
    /^SET (.*?)(?: REMOVE (.*))?$/.exec(update.UpdateExpression!) ?? [];
  const result = { ...stored };
  for (const assignment of setPart.split(', ')) {
    const [name, value] = assignment.split(' = ') as [string, string];
    result[names[name]!] = values[value];
  }
  for (const name of removePart === '' ? [] : removePart.split(', ')) {
    delete result[names[name]!];
  }
  return result;
}

const completed: CompletedRequest = {
  actorId: 'sub-aisha',
  key: 'claim-key-0001',
  fingerprint: 'ef'.repeat(32),
  response: { status: 200, body: { claimId, version: 4 } },
  createdAt: time(7),
  expiresAt: Math.floor(Date.parse(time(7)) / 1000) + 86_400,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('create', () => {
  const created: Claim = { ...draft, version: 1, updatedAt: time(0) };
  const creation: ClaimHistoryEntry = {
    claimId,
    version: 1,
    action: 'CREATE',
    toStatus: 'DRAFT',
    actorId: 'sub-aisha',
    occurredAt: time(0),
  };

  it('puts the claim and its first history entry, each only if absent', () => {
    expect(
      createClaimOperations(tableName, { claim: created, history: creation }),
    ).toEqual([
      {
        Put: {
          TableName: 'ClaimFlow',
          Item: encodeClaimItem(created),
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
      {
        Put: {
          TableName: 'ClaimFlow',
          Item: encodeHistoryItem(creation),
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
    ]);
  });

  it('records no event version for an unpublished creation', () => {
    const [claimPut] = createClaimOperations(tableName, {
      claim: created,
      history: creation,
    });

    expect(claimPut.Put!.Item).not.toHaveProperty('lastEventVersion');
  });

  it.each<[string, Partial<Claim>, Partial<ClaimHistoryEntry>, string]>([
    ['another action', {}, { action: 'UPDATE' }, 'CREATE history entry'],
    ['version 2', { version: 2 }, { version: 2 }, 'version 1'],
    ['another claim', {}, { claimId: 'other-claim' }, 'another claim'],
    ['another version', {}, { version: 2 }, 'equal the claim version'],
    ['another status', {}, { toStatus: 'SUBMITTED' }, 'resulting status'],
    ['a previous status', {}, { fromStatus: 'DRAFT' }, 'no previous status'],
  ])('refuses %s', (_name, claimChange, historyChange, problem) => {
    expect(() =>
      createClaimOperations(tableName, {
        claim: { ...created, ...claimChange },
        history: { ...creation, ...historyChange },
      }),
    ).toThrow(problem);
  });

  it.each<ClaimStatus>([
    'SUBMITTED',
    'UNDER_REVIEW',
    'APPROVED',
    'REJECTED',
    'PAID',
  ])(
    'refuses a version 1 claim created directly as %s, even with matching history',
    (status) => {
      const claim: Claim = {
        ...created,
        status,
        assignedManagerId: 'sub-ben',
        submittedAt: time(0),
        ...(['APPROVED', 'REJECTED', 'PAID'].includes(status)
          ? { reviewedAt: time(0) }
          : {}),
      };

      expect(() =>
        createClaimOperations(tableName, {
          claim,
          history: { ...creation, toStatus: status },
        }),
      ).toThrow('a new claim must be a DRAFT');
    },
  );

  it('refuses invalid values through the codecs', () => {
    expect(() =>
      createClaimOperations(tableName, {
        claim: { ...created, merchant: ` ${merchant}` },
        history: creation,
      }),
    ).toThrow(ItemEncodingError);
  });
});

describe('update', () => {
  it('builds the exact Update for a submission, with the history Put second', () => {
    const change = changeFor('SUBMIT');
    const [update, history] = updateClaimOperations(
      tableName,
      change,
      3,
      undefined,
    );

    expect(update).toEqual({
      Update: {
        TableName: 'ClaimFlow',
        Key: { PK: `CLAIM#${claimId}`, SK: 'CLAIM' },
        UpdateExpression:
          'SET #entityType = :entityType, #claimId = :claimId, ' +
          '#employeeId = :employeeId, #assignedManagerId = :assignedManagerId, ' +
          '#categoryId = :categoryId, #amount = :amount, ' +
          '#expenseDate = :expenseDate, #merchant = :merchant, ' +
          '#businessPurpose = :businessPurpose, #status = :status, ' +
          '#version = :version, #lastEventVersion = :lastEventVersion, ' +
          '#createdAt = :createdAt, #updatedAt = :updatedAt, ' +
          '#submittedAt = :submittedAt, #GSI1PK = :GSI1PK, #GSI1SK = :GSI1SK, ' +
          '#GSI2PK = :GSI2PK, #GSI2SK = :GSI2SK, #GSI3PK = :GSI3PK, ' +
          '#GSI3SK = :GSI3SK, #GSI4PK = :GSI4PK, #GSI4SK = :GSI4SK ' +
          'REMOVE #receipt, #reviewedAt',
        ConditionExpression:
          '#version = :expectedVersion AND #employeeId = :actorId',
        ExpressionAttributeNames: Object.fromEntries(
          [
            'entityType',
            'claimId',
            'employeeId',
            'assignedManagerId',
            'categoryId',
            'amount',
            'expenseDate',
            'merchant',
            'businessPurpose',
            'receipt',
            'status',
            'version',
            'lastEventVersion',
            'createdAt',
            'updatedAt',
            'submittedAt',
            'reviewedAt',
            'GSI1PK',
            'GSI1SK',
            'GSI2PK',
            'GSI2SK',
            'GSI3PK',
            'GSI3SK',
            'GSI4PK',
            'GSI4SK',
          ].map((name) => [`#${name}`, name]),
        ),
        ExpressionAttributeValues: {
          ...Object.fromEntries(
            Object.entries(
              encodeClaimItem(change.claim, { lastEventVersion: 4 }),
            )
              .filter(([name]) => name !== 'PK' && name !== 'SK')
              .map(([name, value]) => [`:${name}`, value]),
          ),
          ':expectedVersion': 3,
          ':actorId': 'sub-aisha',
        },
      },
    });
    expect(history).toEqual({
      Put: {
        TableName: 'ClaimFlow',
        Item: encodeHistoryItem(change.history),
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    });
  });

  it.each(updateActions)(
    '%s synchronizes the stored claim to exactly the encoded new claim',
    (action) => {
      const change = changeFor(action);
      const stored = encodeClaimItem(
        { ...scenarios[action].before, updatedAt: time(3) },
        { lastEventVersion: 2 },
      );
      const [update] = updateClaimOperations(tableName, change, 3, 2);
      const result = applyUpdate(stored, update);
      const lastEventVersion = isPublishableAction(action) ? 4 : 2;

      expect(result).toEqual(
        encodeClaimItem(change.claim, { lastEventVersion }),
      );
      expect(decodeClaimItem(result)).toEqual({
        claim: change.claim,
        metadata: { lastEventVersion },
      });
      expect(update.Update!.UpdateExpression).not.toMatch(/#PK|#SK/);
      expect(update.Update!.Key).toEqual({
        PK: `CLAIM#${claimId}`,
        SK: 'CLAIM',
      });
    },
  );

  it('adds GSI2 for an open assigned claim and removes it otherwise', () => {
    const submitted = applyUpdate(
      encodeClaimItem(scenarios.SUBMIT.before),
      updateClaimOperations(tableName, changeFor('SUBMIT'), 3, undefined)[0],
    );
    const approved = applyUpdate(
      encodeClaimItem({ ...scenarios.APPROVE.before, updatedAt: time(3) }),
      updateClaimOperations(tableName, changeFor('APPROVE'), 3, undefined)[0],
    );

    expect(submitted.GSI2PK).toBe('MANAGER#sub-ben#OPEN');
    expect(submitted.GSI2SK).toBe(`${time(5)}#${claimId}`);
    expect(approved).not.toHaveProperty('GSI2PK');
    expect(approved).not.toHaveProperty('GSI2SK');
    expect(approved.GSI3PK).toBe('STATUS#APPROVED');
  });

  it('removes cleared optional details and changes others', () => {
    const [update] = updateClaimOperations(
      tableName,
      changeFor('UPDATE'),
      3,
      undefined,
    );

    expect(update.Update!.UpdateExpression).toMatch(/REMOVE .*#expenseDate/);
    expect(update.Update!.ExpressionAttributeValues![':merchant']).toBe(
      'Regional Airline',
    );
  });

  describe('write conditions', () => {
    const expected: Record<keyof typeof scenarios, string> = {
      UPDATE: claimOwnerCondition,
      ATTACH_RECEIPT: claimOwnerCondition,
      REPLACE_RECEIPT: claimOwnerCondition,
      REMOVE_RECEIPT: claimOwnerCondition,
      SUBMIT: claimOwnerCondition,
      REOPEN: claimOwnerCondition,
      START_REVIEW: claimManagerCondition,
      APPROVE: claimManagerCondition,
      REJECT: claimManagerCondition,
      MARK_PAID: claimVersionCondition,
    };

    it('cover every history action except CREATE', () => {
      expect(Object.keys(expected).sort()).toEqual(
        claimHistoryActions.filter((a) => a !== 'CREATE').sort(),
      );
    });

    it.each(updateActions)('guard %s by version and actor', (action) => {
      const [update] = updateClaimOperations(
        tableName,
        changeFor(action),
        3,
        undefined,
      );
      const { ConditionExpression, ExpressionAttributeValues } = update.Update!;

      expect(ConditionExpression).toBe(expected[action]);
      expect(ExpressionAttributeValues![':expectedVersion']).toBe(3);
      if (expected[action] === claimVersionCondition) {
        expect(ExpressionAttributeValues).not.toHaveProperty(':actorId');
      } else {
        expect(ExpressionAttributeValues![':actorId']).toBe(
          scenarios[action].actorId,
        );
      }
    });

    it('use the exact condition texts', () => {
      expect(claimOwnerCondition).toBe(
        '#version = :expectedVersion AND #employeeId = :actorId',
      );
      expect(claimManagerCondition).toBe(
        '#version = :expectedVersion AND #assignedManagerId = :actorId',
      );
      expect(claimVersionCondition).toBe('#version = :expectedVersion');
    });
  });

  describe('event versions', () => {
    it.each(updateActions)(
      '%s sets or preserves lastEventVersion',
      (action) => {
        const [update] = updateClaimOperations(
          tableName,
          changeFor(action),
          3,
          2,
        );

        expect(
          update.Update!.ExpressionAttributeValues![':lastEventVersion'],
        ).toBe(isPublishableAction(action) ? 4 : 2);
      },
    );

    it('classifies exactly the lifecycle actions as publishable', () => {
      expect(
        claimHistoryActions
          .filter((action) => isPublishableAction(action))
          .sort(),
      ).toEqual([
        'APPROVE',
        'MARK_PAID',
        'REJECT',
        'REOPEN',
        'START_REVIEW',
        'SUBMIT',
      ]);
    });

    it('keeps no event version on a draft that never had one', () => {
      const [update] = updateClaimOperations(
        tableName,
        changeFor('ATTACH_RECEIPT'),
        3,
        undefined,
      );

      expect(update.Update!.ExpressionAttributeValues).not.toHaveProperty(
        ':lastEventVersion',
      );
      expect(update.Update!.UpdateExpression).toMatch(
        /REMOVE .*#lastEventVersion/,
      );
    });

    it('preserves the event version of a reopened draft across edits', () => {
      const [update] = updateClaimOperations(
        tableName,
        changeFor('UPDATE'),
        3,
        3,
      );

      expect(
        update.Update!.ExpressionAttributeValues![':lastEventVersion'],
      ).toBe(3);
    });

    it('refuses a stored event version newer than the claim', () => {
      expect(() =>
        updateClaimOperations(tableName, changeFor('UPDATE'), 3, 5),
      ).toThrow('storedLastEventVersion');
    });

    describe('stored event version, read at expectedVersion 3', () => {
      it.each<[string, number | undefined]>([
        ['absent', undefined],
        ['zero', 0],
        ['equal to expectedVersion', 3],
      ])('accepts %s for every action', (_name, stored) => {
        for (const action of updateActions) {
          const [update] = updateClaimOperations(
            tableName,
            changeFor(action),
            3,
            stored,
          );
          const values = update.Update!.ExpressionAttributeValues!;
          if (isPublishableAction(action)) {
            expect(values[':lastEventVersion']).toBe(4);
          } else if (stored === undefined) {
            expect(values).not.toHaveProperty(':lastEventVersion');
          } else {
            expect(values[':lastEventVersion']).toBe(stored);
          }
        }
      });

      it.each<[string, number]>([
        ['greater than expectedVersion, though equal to the new version', 4],
        ['far greater than expectedVersion', 9],
        ['negative', -1],
        ['fractional', 1.5],
        ['not a number', Number.NaN],
        ['unsafe', Number.MAX_SAFE_INTEGER + 1],
      ])('refuses %s, for every action', (_name, stored) => {
        for (const action of updateActions) {
          expect(() =>
            updateClaimOperations(tableName, changeFor(action), 3, stored),
          ).toThrow(
            'storedLastEventVersion must be a whole number from 0 to expectedVersion',
          );
        }
      });
    });
  });

  describe('validation', () => {
    const withChange = (
      action: keyof typeof scenarios,
      claimChange: Partial<Claim>,
      historyChange: Partial<ClaimHistoryEntry>,
    ): ClaimChange => {
      const change = changeFor(action);
      return {
        claim: { ...change.claim, ...claimChange },
        history: { ...change.history, ...historyChange },
      };
    };

    it.each<[string, ClaimChange, number, string]>([
      [
        'the same version',
        withChange('UPDATE', { version: 3 }, { version: 3 }),
        3,
        'one more than expectedVersion',
      ],
      [
        'a skipped version',
        withChange('UPDATE', { version: 5 }, { version: 5 }),
        3,
        'one more than expectedVersion',
      ],
      [
        'another claim in the history',
        withChange('UPDATE', {}, { claimId: 'other-claim' }),
        3,
        'another claim',
      ],
      [
        'another history version',
        withChange('UPDATE', {}, { version: 5 }),
        3,
        'equal the claim version',
      ],
      [
        'another resulting status',
        withChange('SUBMIT', {}, { toStatus: 'UNDER_REVIEW' }),
        3,
        'resulting status',
      ],
      [
        'a transition the action does not make',
        withChange('APPROVE', { status: 'REJECTED' }, { toStatus: 'REJECTED' }),
        3,
        'do not match the action',
      ],
      [
        'a wrong source status',
        withChange('SUBMIT', {}, { fromStatus: 'REJECTED' }),
        3,
        'do not match the action',
      ],
      [
        'an edit outside a draft',
        withChange(
          'UPDATE',
          {
            status: 'SUBMITTED',
            assignedManagerId: 'sub-ben',
            submittedAt: time(5),
          },
          { fromStatus: 'SUBMITTED', toStatus: 'SUBMITTED' },
        ),
        3,
        'do not match the action',
      ],
      [
        'a CREATE entry',
        withChange('UPDATE', {}, { action: 'CREATE' }),
        3,
        'cannot update a claim',
      ],
      [
        'an unknown action',
        withChange('UPDATE', {}, { action: 'ESCALATE' as ClaimHistoryAction }),
        3,
        'cannot update a claim',
      ],
    ])('refuses %s', (_name, change, expectedVersion, problem) => {
      expect(() =>
        updateClaimOperations(tableName, change, expectedVersion, undefined),
      ).toThrow(problem);
    });

    it.each([0, -1, 1.5, Number.NaN])(
      'refuses an expected version of %s',
      (expectedVersion) => {
        expect(() =>
          updateClaimOperations(
            tableName,
            changeFor('UPDATE'),
            expectedVersion,
            undefined,
          ),
        ).toThrow(ClaimOperationError);
      },
    );

    it('accepts the largest history version and refuses overflow', () => {
      const at = (version: number) =>
        withChange('UPDATE', { version }, { version });

      expect(() =>
        updateClaimOperations(
          tableName,
          at(9_999_999_999),
          9_999_999_998,
          undefined,
        ),
      ).not.toThrow();
      expect(() =>
        updateClaimOperations(
          tableName,
          at(10_000_000_000),
          9_999_999_999,
          undefined,
        ),
      ).toThrow(ItemEncodingError);
      expect(() =>
        updateClaimOperations(
          tableName,
          at(Number.MAX_SAFE_INTEGER + 1),
          Number.MAX_SAFE_INTEGER,
          undefined,
        ),
      ).toThrow('would not be exact');
    });
  });
});

describe('delete draft', () => {
  it('deletes a never-submitted draft owned by the actor at its version', () => {
    expect(deleteDraftOperation(tableName, draft, 'sub-aisha', 3)).toEqual({
      Delete: {
        TableName: 'ClaimFlow',
        Key: { PK: `CLAIM#${claimId}`, SK: 'CLAIM' },
        ConditionExpression:
          '#version = :expectedVersion AND #employeeId = :actorId AND #status = :draft AND attribute_not_exists(#submittedAt)',
        ExpressionAttributeNames: {
          '#version': 'version',
          '#employeeId': 'employeeId',
          '#status': 'status',
          '#submittedAt': 'submittedAt',
        },
        ExpressionAttributeValues: {
          ':expectedVersion': 3,
          ':actorId': 'sub-aisha',
          ':draft': 'DRAFT',
        },
      },
    });
    expect(draftDeleteCondition).toContain(
      'attribute_not_exists(#submittedAt)',
    );
  });

  it.each<[string, Claim, string, number, string]>([
    [
      'a submitted claim',
      scenarios.START_REVIEW.before,
      'sub-aisha',
      3,
      'never-submitted draft',
    ],
    [
      'a reopened draft',
      scenarios.REOPEN.after,
      'sub-aisha',
      3,
      'never-submitted draft',
    ],
    ['another actor', draft, 'sub-ravi', 3, 'only the owner'],
    ['a stale version', draft, 'sub-aisha', 2, 'version of the draft'],
    ['an invalid actor', draft, 'sub aisha', 3, 'actor ID'],
  ])('refuses %s', (_name, claim, actorId, expectedVersion, problem) => {
    expect(() =>
      deleteDraftOperation(tableName, claim, actorId, expectedVersion),
    ).toThrow(problem);
  });

  it('touches only the claim item, never its history', () => {
    const operation = deleteDraftOperation(tableName, draft, 'sub-aisha', 3);

    expect(Object.keys(operation)).toEqual(['Delete']);
    expect(operation.Delete!.Key).toEqual({
      PK: `CLAIM#${claimId}`,
      SK: 'CLAIM',
    });
  });
});

describe('with the transaction composer and category operations', () => {
  const submittedEvent: OutboxEvent = {
    eventId: 'event-submitted-1',
    eventType: 'claim.submitted',
    schemaVersion: 1,
    occurredAt: time(7),
    source: eventSource,
    aggregate: {
      type: 'claim',
      id: claimId,
      version: 4,
      previousEventVersion: null,
    },
    correlationId: 'trace-1',
    causationId: 'request-1',
    actorId: 'sub-aisha',
    payload: {
      claimId,
      employeeId: 'sub-aisha',
      assignedManagerId: 'sub-ben',
      categoryId: 'travel',
      amount: { amountMinor: 45_000, currency: 'MYR' },
      submittedAt: time(5),
    },
  };

  it('composes a submission with its category guard, event, and idempotency record', () => {
    const composed = composeBusinessTransaction({
      tableName,
      businessItems: [
        ...updateClaimOperations(tableName, changeFor('SUBMIT'), 3, undefined),
        categoryGuardCheckOperation(tableName, {
          categoryId: 'travel',
          readVersion: 3,
          mustBeActive: true,
        }),
      ],
      events: [submittedEvent],
      completed,
    });

    expect(composed.TransactItems).toHaveLength(5);
    expect(composed.ClientRequestToken).toMatch(/^[0-9a-f]{32}$/);
  });

  it('composes a creation with its category counter', () => {
    const created: Claim = { ...draft, version: 1, updatedAt: time(0) };
    const composed = composeBusinessTransaction({
      tableName,
      businessItems: [
        ...createClaimOperations(tableName, {
          claim: created,
          history: {
            claimId,
            version: 1,
            action: 'CREATE',
            toStatus: 'DRAFT',
            actorId: 'sub-aisha',
            occurredAt: time(0),
          },
        }),
        incrementClaimCountOperation(tableName, {
          categoryId: 'travel',
          readVersion: 3,
          mustBeActive: true,
        }),
      ],
      events: [],
      completed: { ...completed, response: { status: 201, body: { claimId } } },
    });

    expect(composed.TransactItems).toHaveLength(4);
  });
});

describe('free text and commands', () => {
  it('never puts free text into keys or conditions', () => {
    const operations = updateActions.flatMap((action) =>
      updateClaimOperations(tableName, changeFor(action), 3, undefined),
    );

    for (const operation of [
      ...operations,
      deleteDraftOperation(tableName, draft, 'sub-aisha', 3),
    ]) {
      const parameters = Object.values(operation)[0] as {
        Key?: unknown;
        ConditionExpression?: string;
        Item?: DynamoItem;
      };
      const exposed = JSON.stringify([
        parameters.Key ?? { PK: parameters.Item?.PK, SK: parameters.Item?.SK },
        parameters.ConditionExpression,
      ]);
      expect(exposed).not.toContain(merchant);
      expect(exposed).not.toContain(purpose);
      expect(exposed).not.toContain('flight.pdf');
      expect(exposed).not.toContain('boarding');
    }
  });

  it('keeps free text out of error messages', () => {
    const errors: unknown[] = [];
    for (const build of [
      () =>
        updateClaimOperations(
          tableName,
          {
            ...changeFor('UPDATE'),
            history: { ...changeFor('UPDATE').history, comment: ` ${comment}` },
          },
          3,
          undefined,
        ),
      () =>
        updateClaimOperations(
          tableName,
          {
            ...changeFor('UPDATE'),
            claim: { ...changeFor('UPDATE').claim, merchant: `${merchant} ` },
          },
          3,
          undefined,
        ),
      () =>
        deleteDraftOperation(
          tableName,
          { ...draft, businessPurpose: ` ${purpose}` },
          'sub-aisha',
          3,
        ),
    ]) {
      try {
        build();
      } catch (error) {
        errors.push(error);
      }
    }

    expect(errors).toHaveLength(3);
    for (const error of errors) {
      expect(String(error)).not.toContain('Confidential');
      expect(String(error)).not.toContain('merger');
      expect(String(error)).not.toContain('boarding');
    }
  });

  it('sends no DynamoDB command', () => {
    const send = vi.spyOn(DynamoDBDocumentClient.prototype, 'send');

    for (const action of updateActions) {
      updateClaimOperations(tableName, changeFor(action), 3, 2);
    }
    deleteDraftOperation(tableName, draft, 'sub-aisha', 3);

    expect(send).not.toHaveBeenCalled();
  });
});

it('covers every claim status across the scenarios', () => {
  const statuses = new Set<ClaimStatus>(
    updateActions.flatMap((action) => [
      scenarios[action].before.status,
      scenarios[action].after.status,
    ]),
  );

  expect([...statuses].sort()).toEqual(
    [
      'APPROVED',
      'DRAFT',
      'PAID',
      'REJECTED',
      'SUBMITTED',
      'UNDER_REVIEW',
    ].sort(),
  );
});
