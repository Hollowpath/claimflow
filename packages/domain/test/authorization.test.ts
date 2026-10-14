import { describe, expect, it } from 'vitest';

import {
  approveClaim,
  availableActions,
  canEditClaim,
  canViewClaim,
  markClaimPaid,
  rejectClaim,
  reopenClaim,
  startReview,
  submitClaim,
  updateDraftClaim,
  type Actor,
} from '../src/index.js';
import {
  aisha,
  as,
  ben,
  chloe,
  claimIn,
  dan,
  draft,
  ravi,
  travel,
} from './fixtures.js';

describe('claim visibility', () => {
  it.each([
    [aisha, true],
    [ben, true],
    [dan, true],
    [ravi, false],
    [chloe, false],
  ] as [Actor, boolean][])('%s can view: %s', (actor, expected) => {
    expect(canViewClaim(claimIn('SUBMITTED'), actor)).toBe(expected);
  });

  it('hides an unsubmitted draft from the future manager', () => {
    expect(canViewClaim(draft(), ben)).toBe(false);
  });
});

describe('ownership', () => {
  it('lets only the owner edit a draft', () => {
    expect(canEditClaim(draft(), aisha)).toBe(true);
    expect(canEditClaim(draft(), ravi)).toBe(false);
    expect(() =>
      updateDraftClaim(draft(), { merchant: 'X' }, undefined, as(ravi)),
    ).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    expect(() =>
      updateDraftClaim(draft(), { merchant: 'X' }, undefined, as(dan)),
    ).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('lets only the owner submit or reopen', () => {
    expect(() => submitClaim(draft(), travel, as(ravi))).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
    expect(() => reopenClaim(claimIn('REJECTED'), as(ben))).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });

  it('forbids editing outside DRAFT', () => {
    for (const status of [
      'SUBMITTED',
      'UNDER_REVIEW',
      'APPROVED',
      'REJECTED',
      'PAID',
    ] as const) {
      expect(canEditClaim(claimIn(status), aisha)).toBe(false);
      expect(() =>
        updateDraftClaim(
          claimIn(status),
          { merchant: 'X' },
          undefined,
          as(aisha),
        ),
      ).toThrow(expect.objectContaining({ code: 'CLAIM_NOT_EDITABLE' }));
    }
  });
});

describe('manager assignment', () => {
  it('lets only the assigned manager review', () => {
    expect(() => startReview(claimIn('SUBMITTED'), as(chloe))).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
    expect(() => approveClaim(claimIn('UNDER_REVIEW'), 'ok', as(dan))).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
    expect(startReview(claimIn('SUBMITTED'), as(ben)).claim.status).toBe(
      'UNDER_REVIEW',
    );
  });

  it('prevents a user from reviewing their own claim', () => {
    const ownClaim = { ...claimIn('UNDER_REVIEW'), employeeId: 'u-ben' };
    for (const run of [
      () => approveClaim(ownClaim, 'ok', as(ben)),
      () => rejectClaim(ownClaim, 'no', as(ben)),
      () => startReview({ ...ownClaim, status: 'SUBMITTED' }, as(ben)),
    ]) {
      expect(run).toThrow(
        expect.objectContaining({ code: 'SELF_REVIEW_FORBIDDEN' }),
      );
    }
  });

  it.each(['', '   ', '\n\t'])(
    'requires a nonblank decision comment (%j)',
    (comment) => {
      for (const decide of [approveClaim, rejectClaim]) {
        expect(() => decide(claimIn('UNDER_REVIEW'), comment, as(ben))).toThrow(
          expect.objectContaining({
            code: 'VALIDATION_FAILED',
            violations: [expect.objectContaining({ code: 'COMMENT_REQUIRED' })],
          }),
        );
      }
    },
  );

  it('limits decision comment length', () => {
    expect(() =>
      approveClaim(claimIn('UNDER_REVIEW'), 'x'.repeat(1001), as(ben)),
    ).toThrow(
      expect.objectContaining({
        violations: [expect.objectContaining({ code: 'TOO_LONG' })],
      }),
    );
  });
});

describe('payment', () => {
  it('lets only an administrator mark an approved claim as paid', () => {
    expect(markClaimPaid(claimIn('APPROVED'), as(dan)).claim.status).toBe(
      'PAID',
    );
    for (const actor of [aisha, ben, chloe]) {
      expect(() => markClaimPaid(claimIn('APPROVED'), as(actor))).toThrow(
        expect.objectContaining({ code: 'FORBIDDEN' }),
      );
    }
  });

  it('prevents an administrator paying their own claim', () => {
    const admin: Actor = { ...dan, roles: ['EMPLOYEE', 'ADMIN'] };
    const own = { ...claimIn('APPROVED'), employeeId: admin.userId };
    expect(() => markClaimPaid(own, as(admin))).toThrow(
      expect.objectContaining({ code: 'SELF_REVIEW_FORBIDDEN' }),
    );
  });
});

describe('available actions', () => {
  it.each([
    ['DRAFT', aisha, ['SUBMIT']],
    ['SUBMITTED', ben, ['START_REVIEW']],
    ['UNDER_REVIEW', ben, ['APPROVE', 'REJECT']],
    ['REJECTED', aisha, ['REOPEN']],
    ['APPROVED', dan, ['MARK_PAID']],
    ['SUBMITTED', aisha, []],
    ['UNDER_REVIEW', dan, []],
    ['PAID', dan, []],
  ] as const)('%s for %s', (status, actor, expected) => {
    expect(availableActions(claimIn(status), actor)).toEqual(expected);
  });
});
