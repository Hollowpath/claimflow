import { describe, expect, it } from 'vitest';

import {
  assertMayDeleteCategory,
  assertMayDeleteClaim,
  canDeleteClaim,
  rejectClaim,
  reopenClaim,
} from '../src/index.js';
import { aisha, as, ben, claimIn, dan, draft, now, ravi } from './fixtures.js';

describe('deleting claims', () => {
  it('lets the owner delete a draft that was never submitted', () => {
    expect(canDeleteClaim(draft(), aisha)).toBe(true);
    expect(() => assertMayDeleteClaim(draft(), aisha)).not.toThrow();
  });

  it('forbids anyone but the owner', () => {
    for (const actor of [ravi, ben, dan]) {
      expect(canDeleteClaim(draft(), actor)).toBe(false);
      expect(() => assertMayDeleteClaim(draft(), actor)).toThrow(
        expect.objectContaining({ code: 'FORBIDDEN' }),
      );
    }
  });

  it.each([
    'SUBMITTED',
    'UNDER_REVIEW',
    'APPROVED',
    'REJECTED',
    'PAID',
  ] as const)('refuses to delete a %s claim', (status) => {
    expect(canDeleteClaim(claimIn(status), aisha)).toBe(false);
    expect(() => assertMayDeleteClaim(claimIn(status), aisha)).toThrow(
      expect.objectContaining({ code: 'CLAIM_NOT_EDITABLE' }),
    );
  });

  it('keeps a reopened draft because it has review history', () => {
    const rejected = rejectClaim(claimIn('UNDER_REVIEW'), 'No', as(ben)).claim;
    const reopened = reopenClaim(rejected, as(aisha)).claim;
    expect(reopened).toMatchObject({ status: 'DRAFT', submittedAt: now });
    expect(canDeleteClaim(reopened, aisha)).toBe(false);
    expect(() => assertMayDeleteClaim(reopened, aisha)).toThrow(
      expect.objectContaining({ code: 'CLAIM_NOT_DELETABLE' }),
    );
  });
});

describe('deleting categories', () => {
  it('is limited to administrators', () => {
    expect(() => assertMayDeleteCategory(dan)).not.toThrow();
    for (const actor of [aisha, ben]) {
      expect(() => assertMayDeleteCategory(actor)).toThrow(
        expect.objectContaining({ code: 'FORBIDDEN' }),
      );
    }
  });
});
