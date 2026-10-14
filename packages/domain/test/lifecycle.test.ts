import { describe, expect, it } from 'vitest';

import {
  approveClaim,
  claimStatuses,
  DomainError,
  isValidTransition,
  markClaimPaid,
  nextStatus,
  rejectClaim,
  reopenClaim,
  startReview,
  submitClaim,
  updateDraftClaim,
  type ClaimAction,
  type ClaimStatus,
} from '../src/index.js';
import {
  aisha,
  as,
  ben,
  claimIn,
  dan,
  draft,
  now,
  travel,
} from './fixtures.js';

const validTransitions: [ClaimStatus, ClaimAction, ClaimStatus][] = [
  ['DRAFT', 'SUBMIT', 'SUBMITTED'],
  ['SUBMITTED', 'START_REVIEW', 'UNDER_REVIEW'],
  ['UNDER_REVIEW', 'APPROVE', 'APPROVED'],
  ['UNDER_REVIEW', 'REJECT', 'REJECTED'],
  ['REJECTED', 'REOPEN', 'DRAFT'],
  ['APPROVED', 'MARK_PAID', 'PAID'],
];

describe('claim lifecycle', () => {
  it.each(validTransitions)('%s --%s--> %s is valid', (from, action, to) => {
    expect(nextStatus(from, action)).toBe(to);
    expect(isValidTransition(from, to)).toBe(true);
  });

  it('rejects every other status pair', () => {
    const valid = new Set(validTransitions.map(([from, , to]) => from + to));
    for (const from of claimStatuses) {
      for (const to of claimStatuses) {
        expect(isValidTransition(from, to)).toBe(valid.has(from + to));
      }
    }
  });

  it.each([
    ['DRAFT', 'APPROVE'],
    ['SUBMITTED', 'APPROVE'],
    ['APPROVED', 'REJECT'],
    ['PAID', 'REOPEN'],
    ['REJECTED', 'SUBMIT'],
    ['UNDER_REVIEW', 'MARK_PAID'],
  ] as const)('refuses %s with %s', (status, action) => {
    expect(() => nextStatus(status, action)).toThrow(
      expect.objectContaining({ code: 'INVALID_TRANSITION' }),
    );
  });

  it('walks the full happy path with one history entry per change', () => {
    const submitted = submitClaim(draft(), travel, as(aisha));
    const reviewing = startReview(submitted.claim, as(ben));
    const approved = approveClaim(reviewing.claim, ' Looks good ', as(ben));
    const paid = markClaimPaid(approved.claim, as(dan));

    expect(submitted.claim).toMatchObject({
      status: 'SUBMITTED',
      version: 2,
      assignedManagerId: 'u-ben',
      submittedAt: now,
    });
    expect(approved.claim.reviewedAt).toBeDefined();
    expect(paid.claim).toMatchObject({ status: 'PAID', version: 5 });
    expect(
      [submitted, reviewing, approved, paid].map(({ history }) => [
        history.version,
        history.action,
        history.fromStatus,
        history.toStatus,
        history.actorId,
      ]),
    ).toEqual([
      [2, 'SUBMIT', 'DRAFT', 'SUBMITTED', 'u-aisha'],
      [3, 'START_REVIEW', 'SUBMITTED', 'UNDER_REVIEW', 'u-ben'],
      [4, 'APPROVE', 'UNDER_REVIEW', 'APPROVED', 'u-ben'],
      [5, 'MARK_PAID', 'APPROVED', 'PAID', 'u-dan'],
    ]);
    expect(approved.history.comment).toBe('Looks good');
  });

  it('requires a rejected claim to be reopened before editing and resubmitting', () => {
    const rejected = rejectClaim(
      claimIn('UNDER_REVIEW'),
      'Missing details',
      as(ben),
    ).claim;

    expect(() =>
      updateDraftClaim(rejected, { merchant: 'Taxi' }, undefined, as(aisha)),
    ).toThrow(expect.objectContaining({ code: 'CLAIM_NOT_EDITABLE' }));
    expect(() => submitClaim(rejected, travel, as(aisha))).toThrow(
      expect.objectContaining({ code: 'INVALID_TRANSITION' }),
    );

    const reopened = reopenClaim(rejected, as(aisha));
    expect(reopened.history).toMatchObject({
      action: 'REOPEN',
      fromStatus: 'REJECTED',
      toStatus: 'DRAFT',
    });

    const edited = updateDraftClaim(
      reopened.claim,
      { merchant: 'Taxi' },
      undefined,
      as(aisha),
    );
    const resubmitted = submitClaim(edited.claim, travel, as(aisha));
    expect(resubmitted.claim).toMatchObject({
      status: 'SUBMITTED',
      merchant: 'Taxi',
    });
    expect(resubmitted.claim.reviewedAt).toBeUndefined();
  });

  it('never mutates the input claim', () => {
    const original = claimIn('UNDER_REVIEW');
    const snapshot = structuredClone(original);
    approveClaim(original, 'ok', as(ben));
    expect(original).toEqual(snapshot);
  });

  it('raises DomainError instances', () => {
    expect(() => nextStatus('PAID', 'SUBMIT')).toThrow(DomainError);
  });
});
