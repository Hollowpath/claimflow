import {
  claimActions,
  claimHistoryActions,
  claimTransitions,
  type Claim,
  type ClaimAction,
  type ClaimChange,
  type ClaimHistoryEntry,
} from '@claimflow/domain';
import { describe, expect, it } from 'vitest';

import { updateClaimOperations } from '../src/adapters/aws/dynamodb-claim-operations.js';
import { ItemEncodingError } from '../src/adapters/aws/dynamodb-items.js';
import {
  decodeOutboxItem,
  encodeOutboxItem,
} from '../src/adapters/aws/dynamodb-outbox-items.js';
import {
  buildClaimLifecycleEvent,
  claimActionEventTypes,
  ClaimEventError,
  isPublishableAction,
  type ClaimEventIds,
} from '../src/application/claim-events.js';

const claimId = '4ce0c74b-9c64-46d6-87ba-07fb71b0628c';
const merchant = 'Confidential Supplier Sdn Bhd';
const purpose = 'Client workshop for the merger';
const comment = 'Please attach the boarding pass for the return flight.';
const time = (minute: number) =>
  new Date(
    Date.parse('2026-10-14T10:00:00.000Z') + minute * 60_000,
  ).toISOString();

const ids: ClaimEventIds = {
  eventId: '8f3d2c1e-5a7b-4c1d-9e2f-0a1b2c3d4e5f',
  correlationId: 'c0ffee00-1111-2222-3333-444455556666',
  causationId: 'request-7d3e',
};

const base: Claim = {
  claimId,
  employeeId: 'sub-aisha',
  assignedManagerId: 'sub-ben',
  categoryId: 'travel',
  amount: { amountMinor: 45_000, currency: 'MYR' },
  expenseDate: '2026-10-08',
  merchant,
  businessPurpose: purpose,
  status: 'DRAFT',
  version: 4,
  createdAt: time(0),
  updatedAt: time(7),
  submittedAt: time(5),
};

const actors: Record<ClaimAction, string> = {
  SUBMIT: 'sub-aisha',
  START_REVIEW: 'sub-ben',
  APPROVE: 'sub-ben',
  REJECT: 'sub-ben',
  REOPEN: 'sub-aisha',
  MARK_PAID: 'sub-dan',
};

function changeFor(
  action: ClaimAction,
  claimChange: Partial<Claim> = {},
): ClaimChange {
  const { from, to } = claimTransitions[action];
  const decided =
    action === 'APPROVE' || action === 'REJECT' || action === 'MARK_PAID';
  const claim: Claim = {
    ...base,
    status: to,
    ...(decided || action === 'REOPEN' ? { reviewedAt: time(6) } : {}),
    ...claimChange,
  };
  const history: ClaimHistoryEntry = {
    claimId,
    version: claim.version,
    action,
    fromStatus: from,
    toStatus: to,
    actorId: actors[action],
    occurredAt: time(7),
    ...(action === 'APPROVE' || action === 'REJECT' ? { comment } : {}),
  };
  return { claim, history };
}

const common = {
  claimId,
  employeeId: 'sub-aisha',
  assignedManagerId: 'sub-ben',
  categoryId: 'travel',
  amount: { amountMinor: 45_000, currency: 'MYR' },
};

const expectedPayloads: Record<ClaimAction, object> = {
  SUBMIT: { ...common, submittedAt: time(5) },
  START_REVIEW: common,
  APPROVE: { ...common, reviewedAt: time(6) },
  REJECT: { ...common, reviewedAt: time(6) },
  REOPEN: common,
  MARK_PAID: { ...common, paidBy: 'sub-dan', paidAt: time(7) },
};

const build = (change: ClaimChange, previous: number | undefined = undefined) =>
  buildClaimLifecycleEvent(change, ids, previous);

function errorOf(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('lifecycle events', () => {
  it('map every lifecycle action to its approved event type', () => {
    expect(claimActionEventTypes).toEqual({
      SUBMIT: 'claim.submitted',
      START_REVIEW: 'claim.review-started',
      APPROVE: 'claim.approved',
      REJECT: 'claim.rejected',
      REOPEN: 'claim.reopened',
      MARK_PAID: 'claim.paid',
    });
  });

  it.each(claimActions)(
    'builds the exact %s envelope and payload',
    (action) => {
      expect(build(changeFor(action))).toEqual({
        eventId: ids.eventId,
        eventType: claimActionEventTypes[action],
        schemaVersion: 1,
        occurredAt: time(7),
        source: 'claimflow.api',
        aggregate: {
          type: 'claim',
          id: claimId,
          version: 4,
          previousEventVersion: null,
        },
        correlationId: ids.correlationId,
        causationId: ids.causationId,
        actorId: actors[action],
        payload: expectedPayloads[action],
      });
    },
  );

  it.each(
    claimHistoryActions.filter(
      (action) => !(claimActions as readonly string[]).includes(action),
    ),
  )('builds no event for the draft-only action %s', (action) => {
    const change: ClaimChange = {
      claim: { ...base },
      history: {
        claimId,
        version: 4,
        action: action,
        toStatus: 'DRAFT',
        actorId: 'sub-aisha',
        occurredAt: time(7),
      },
    };

    expect(isPublishableAction(action)).toBe(false);
    expect(build(change)).toBeUndefined();
    expect(build(change, 999)).toBeUndefined();
  });

  it('never includes free text, names, or receipt data', () => {
    const withReceipt = {
      receipt: {
        receiptId: 'r-7731',
        fileName: 'Payslip Aisha Rahman.pdf',
        contentType: 'application/pdf' as const,
        sizeBytes: 100,
        checksumSha256: 'a1b2'.repeat(16),
        attachedAt: time(4),
      },
    };

    for (const action of claimActions) {
      const event = build(changeFor(action, withReceipt))!;
      const text = JSON.stringify(event);
      for (const forbidden of [
        merchant,
        purpose,
        comment,
        'Payslip',
        'r-7731',
        'application/pdf',
      ]) {
        expect(text).not.toContain(forbidden);
      }
      const keys = Object.keys(event.payload);
      for (const field of [
        'merchant',
        'businessPurpose',
        'comment',
        'receipt',
        'fileName',
        'displayName',
        'title',
        'expenseDate',
      ]) {
        expect(keys).not.toContain(field);
      }
    }
  });

  it('copies the amount rather than sharing the claim object', () => {
    const change = changeFor('SUBMIT');
    const event = build(change)!;

    expect((event.payload as { amount: object }).amount).not.toBe(
      change.claim.amount,
    );
  });
});

describe('previous event version', () => {
  it.each([undefined, 0])('is null for the first event (%s)', (previous) => {
    expect(
      build(changeFor('SUBMIT'), previous)!.aggregate.previousEventVersion,
    ).toBeNull();
  });

  it.each([1, 2, 3])('is %s when a later event exists', (previous) => {
    expect(
      build(changeFor('APPROVE'), previous)!.aggregate.previousEventVersion,
    ).toBe(previous);
  });

  it.each([4, 5, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects %s as the previous version of version 4',
    (previous) => {
      expect(() => build(changeFor('SUBMIT'), previous)).toThrow(
        'previous event version',
      );
    },
  );
});

describe('inconsistent changes', () => {
  const withHistory = (
    action: ClaimAction,
    change: Partial<ClaimHistoryEntry>,
    claimChange: Partial<Claim> = {},
  ): ClaimChange => {
    const base = changeFor(action, claimChange);
    return { claim: base.claim, history: { ...base.history, ...change } };
  };

  it.each<[string, ClaimChange, string]>([
    [
      'another claim',
      withHistory('SUBMIT', { claimId: 'other-claim' }),
      'another claim',
    ],
    [
      'another version',
      withHistory('SUBMIT', { version: 5 }),
      'equal the claim version',
    ],
    [
      'a wrong source status',
      withHistory('SUBMIT', { fromStatus: 'REJECTED' }),
      'statuses do not match',
    ],
    [
      'a missing source status',
      (() => {
        const change = changeFor('SUBMIT');
        const { fromStatus: _removed, ...history } = change.history;
        return { claim: change.claim, history };
      })(),
      'statuses do not match',
    ],
    [
      'a wrong target status',
      withHistory('SUBMIT', { toStatus: 'UNDER_REVIEW' }),
      'statuses do not match',
    ],
    [
      'a claim in another status',
      withHistory('APPROVE', {}, { status: 'REJECTED' }),
      'statuses do not match',
    ],
    [
      'an invalid event actor',
      withHistory('SUBMIT', { actorId: 'sub aisha' }),
      'actor ID',
    ],
  ])('rejects %s', (_name, change, problem) => {
    expect(() => build(change)).toThrow(ClaimEventError);
    expect(() => build(change)).toThrow(problem);
  });

  it('rejects invalid generated identifiers', () => {
    const change = changeFor('SUBMIT');

    for (const bad of [
      { ...ids, eventId: 'a#b' },
      { ...ids, correlationId: 'not valid!' },
      { ...ids, causationId: '' },
    ]) {
      expect(() => buildClaimLifecycleEvent(change, bad, undefined)).toThrow(
        ClaimEventError,
      );
    }
  });
});

describe('missing required fields', () => {
  const without = (action: ClaimAction, field: keyof Claim) => {
    const change = changeFor(action);
    const claim = { ...change.claim } as Record<string, unknown>;
    delete claim[field];
    return { claim: claim as unknown as Claim, history: change.history };
  };

  it.each(
    claimActions.flatMap((action) =>
      (['assignedManagerId', 'categoryId', 'amount'] as const).map(
        (field) => [action, field] as const,
      ),
    ),
  )('%s needs %s', (action, field) => {
    expect(() => build(without(action, field))).toThrow(
      'an assigned manager, category, and amount',
    );
  });

  it('needs a submission time to submit', () => {
    expect(() => build(without('SUBMIT', 'submittedAt'))).toThrow(
      'a submission time',
    );
  });

  it.each(['APPROVE', 'REJECT'] as const)(
    'needs a review time to %s',
    (action) => {
      expect(() => build(without(action, 'reviewedAt'))).toThrow(
        'a review time',
      );
    },
  );

  it('does not need extra timestamps for the other actions', () => {
    expect(() => build(without('START_REVIEW', 'submittedAt'))).not.toThrow();
    expect(() => build(without('REOPEN', 'reviewedAt'))).not.toThrow();
    expect(() => build(without('MARK_PAID', 'reviewedAt'))).not.toThrow();
  });

  it('names no values in errors', () => {
    const errors = [
      errorOf(() => build(without('SUBMIT', 'amount'))),
      errorOf(() =>
        build({
          ...changeFor('SUBMIT'),
          history: { ...changeFor('SUBMIT').history, claimId: merchant },
        }),
      ),
    ];

    for (const error of errors) {
      expect(error).toBeInstanceOf(ClaimEventError);
      expect(String(error)).not.toContain(merchant);
      expect(String(error)).not.toContain('sub-aisha');
      expect(String(error)).not.toContain(claimId);
    }
  });
});

describe('with the outbox codec and the claim transaction builder', () => {
  it.each(claimActions)('encodes and decodes the %s event', (action) => {
    const event = build(
      changeFor(action),
      action === 'SUBMIT' ? undefined : 2,
    )!;

    expect(decodeOutboxItem(encodeOutboxItem(event))).toEqual({
      event,
      state: { state: 'PENDING' },
    });
  });

  it('is refused by the codec if a payload would carry free text', () => {
    const event = build(changeFor('SUBMIT'))!;
    const tampered = {
      ...event,
      payload: { ...event.payload, merchant },
    } as unknown as typeof event;

    expect(() => encodeOutboxItem(tampered)).toThrow(ItemEncodingError);
  });

  it.each(claimActions)('matches the lastEventVersion set for %s', (action) => {
    const change = changeFor(action);
    const [update] = updateClaimOperations('ClaimFlow', change, 3, undefined);
    const event = build(change)!;

    expect(update.Update!.ExpressionAttributeValues![':lastEventVersion']).toBe(
      event.aggregate.version,
    );
  });
});
