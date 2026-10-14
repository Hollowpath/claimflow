import { describe, expect, it } from 'vitest';

import {
  createDraftClaim,
  updateDraftClaim,
  type ClaimDetails,
} from '../src/index.js';
import { aisha, as, chloe, dan, draft, now, travel } from './fixtures.js';

describe('creating drafts', () => {
  it('allows an incomplete draft and records CREATE history', () => {
    const { claim, history } = createDraftClaim(
      'c-9',
      { merchant: '  City Taxi  ' },
      undefined,
      as(aisha),
    );
    expect(claim).toEqual({
      claimId: 'c-9',
      employeeId: 'u-aisha',
      merchant: 'City Taxi',
      status: 'DRAFT',
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    expect(history).toEqual({
      claimId: 'c-9',
      version: 1,
      action: 'CREATE',
      toStatus: 'DRAFT',
      actorId: 'u-aisha',
      occurredAt: now,
    });
  });

  it('ignores identity and status fields smuggled into details', () => {
    const smuggled = {
      merchant: 'City Taxi',
      employeeId: 'u-ravi',
      status: 'APPROVED',
      version: 99,
    } as ClaimDetails;
    const { claim } = createDraftClaim('c-9', smuggled, undefined, as(aisha));
    expect(claim).toMatchObject({
      employeeId: 'u-aisha',
      status: 'DRAFT',
      version: 1,
    });
  });

  it('allows only employees to create claims', () => {
    for (const actor of [chloe, dan]) {
      expect(() => createDraftClaim('c-9', {}, undefined, as(actor))).toThrow(
        expect.objectContaining({ code: 'FORBIDDEN' }),
      );
    }
  });

  it('refuses inactive or unknown categories for new claims', () => {
    expect(() =>
      createDraftClaim(
        'c-9',
        { categoryId: 'travel' },
        { ...travel, active: false },
        as(aisha),
      ),
    ).toThrow(
      expect.objectContaining({
        violations: [expect.objectContaining({ code: 'CATEGORY_INACTIVE' })],
      }),
    );
    expect(() =>
      createDraftClaim('c-9', { categoryId: 'nope' }, undefined, as(aisha)),
    ).toThrow(
      expect.objectContaining({
        violations: [expect.objectContaining({ code: 'CATEGORY_NOT_FOUND' })],
      }),
    );
  });

  it('validates field formats on drafts', () => {
    expect(() =>
      createDraftClaim(
        'c-9',
        {
          amount: { amountMinor: 1.5, currency: 'MYR' },
          merchant: 'x'.repeat(121),
          businessPurpose: 'x'.repeat(501),
          expenseDate: 'yesterday',
        },
        undefined,
        as(aisha),
      ),
    ).toThrow(
      expect.objectContaining({
        violations: [
          expect.objectContaining({ code: 'INVALID_AMOUNT' }),
          expect.objectContaining({ code: 'INVALID_DATE' }),
          expect.objectContaining({ field: 'merchant', code: 'TOO_LONG' }),
          expect.objectContaining({
            field: 'businessPurpose',
            code: 'TOO_LONG',
          }),
        ],
      }),
    );
  });
});

describe('editing drafts', () => {
  it('sets, clears, and keeps fields and records UPDATE history', () => {
    const { claim, history } = updateDraftClaim(
      draft(),
      { merchant: 'Regional Airline', businessPurpose: null },
      undefined,
      as(aisha),
    );
    expect(claim).toMatchObject({
      merchant: 'Regional Airline',
      categoryId: 'travel',
      version: 2,
    });
    expect(claim).not.toHaveProperty('businessPurpose');
    expect(history).toMatchObject({
      action: 'UPDATE',
      version: 2,
      fromStatus: 'DRAFT',
      toStatus: 'DRAFT',
    });
  });

  it('keeps a draft editable after its category is deactivated', () => {
    expect(
      updateDraftClaim(draft(), { merchant: 'X' }, undefined, as(aisha)).claim
        .merchant,
    ).toBe('X');
  });

  it('checks a newly chosen category', () => {
    expect(() =>
      updateDraftClaim(
        draft(),
        { categoryId: 'meals' },
        { ...travel, categoryId: 'meals', active: false },
        as(aisha),
      ),
    ).toThrow(
      expect.objectContaining({
        violations: [expect.objectContaining({ code: 'CATEGORY_INACTIVE' })],
      }),
    );
  });
});
