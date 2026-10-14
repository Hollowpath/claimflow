import { describe, expect, it } from 'vitest';

import {
  evaluateSubmission,
  isCalendarDate,
  submitClaim,
  validateMoney,
  type Claim,
} from '../src/index.js';
import { aisha, as, ben, chloe, draft, now, travel } from './fixtures.js';

const receipt = {
  receiptId: 'r-1',
  fileName: 'r.pdf',
  contentType: 'application/pdf',
  sizeBytes: 10,
  checksumSha256: 'a'.repeat(64),
  attachedAt: now,
} as const;

function codes(claim: Claim, category = travel): string[] {
  return evaluateSubmission(claim, category, now).map((v) => v.code);
}

function withAmount(amountMinor: number, extra: Partial<Claim> = {}): Claim {
  return draft({ amount: { amountMinor, currency: 'MYR' }, ...extra });
}

describe('submission policy', () => {
  it('accepts a complete claim', () => {
    expect(codes(draft())).toEqual([]);
  });

  it('reports every missing required field at once', () => {
    const empty: Claim = {
      claimId: 'c-1',
      employeeId: 'u-aisha',
      status: 'DRAFT',
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    expect(
      evaluateSubmission(empty, undefined, now).map((v) => [v.field, v.code]),
    ).toEqual([
      ['categoryId', 'REQUIRED'],
      ['amount', 'REQUIRED'],
      ['expenseDate', 'REQUIRED'],
      ['merchant', 'REQUIRED'],
      ['businessPurpose', 'REQUIRED'],
    ]);
  });

  it('rejects inactive and unknown categories', () => {
    expect(codes(draft(), { ...travel, active: false })).toEqual([
      'CATEGORY_INACTIVE',
    ]);
    expect(evaluateSubmission(draft(), undefined, now)).toEqual([
      expect.objectContaining({ code: 'CATEGORY_NOT_FOUND' }),
    ]);
  });

  it.each([
    [199_999, []],
    [200_000, []],
    [200_001, ['LIMIT_EXCEEDED']],
  ])('enforces the inclusive category limit at %i', (amount, expected) => {
    expect(codes(withAmount(amount, { receipt }))).toEqual(expected);
  });

  it.each([
    [19_999, []],
    [20_000, []],
    [20_001, ['RECEIPT_REQUIRED']],
  ])('requires a receipt only above the threshold (%i)', (amount, expected) => {
    expect(codes(withAmount(amount))).toEqual(expected);
    expect(codes(withAmount(amount, { receipt }))).toEqual([]);
  });

  it('treats a zero threshold as "always require a receipt"', () => {
    expect(codes(withAmount(1))).toEqual([]);
    expect(
      codes(withAmount(1), { ...travel, receiptRequiredAboveMinor: 0 }),
    ).toEqual(['RECEIPT_REQUIRED']);
  });

  it('requires the category currency', () => {
    expect(
      codes(draft({ amount: { amountMinor: 100, currency: 'USD' } })),
    ).toEqual(['CURRENCY_MISMATCH']);
  });

  it.each([
    ['2026-02-30', 'INVALID_DATE'],
    ['14/10/2026', 'INVALID_DATE'],
    ['2026-10-20', 'FUTURE_DATE'],
  ])('rejects expense date %s', (expenseDate, code) => {
    expect(codes(draft({ expenseDate }))).toEqual([code]);
  });

  it('accepts tomorrow (UTC) for time zones ahead of UTC', () => {
    expect(codes(draft({ expenseDate: '2026-10-15' }))).toEqual([]);
  });

  it('refuses a mismatched category as a programming error', () => {
    expect(() =>
      evaluateSubmission(draft(), { ...travel, categoryId: 'meals' }, now),
    ).toThrow(Error);
  });

  it('re-evaluates the current policy on resubmission', () => {
    const tightened = { ...travel, maxAmountMinor: 10_000 };
    expect(() => submitClaim(draft(), tightened, as(aisha))).toThrow(
      expect.objectContaining({
        code: 'VALIDATION_FAILED',
        violations: [expect.objectContaining({ code: 'LIMIT_EXCEEDED' })],
      }),
    );
  });

  it('requires a manager other than the owner', () => {
    const chloesClaim = { ...draft(), employeeId: 'u-chloe' };
    expect(() => submitClaim(chloesClaim, travel, as(chloe))).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
    const { managerId, ...noManager } = aisha;
    expect(() => submitClaim(draft(), travel, as(noManager))).toThrow(
      expect.objectContaining({
        violations: [expect.objectContaining({ code: 'NO_MANAGER_ASSIGNED' })],
      }),
    );
    const selfManaged = { ...ben, managerId: 'u-ben' };
    expect(() => submitClaim(draft({}, ben), travel, as(selfManaged))).toThrow(
      expect.objectContaining({
        violations: [expect.objectContaining({ code: 'NO_MANAGER_ASSIGNED' })],
      }),
    );
  });

  it('assigns the manager from the employee profile at submission', () => {
    expect(
      submitClaim(draft({}, ben), travel, as(ben)).claim.assignedManagerId,
    ).toBe('u-chloe');
  });
});

describe('money', () => {
  it.each([
    [{ amountMinor: 1, currency: 'MYR' }, []],
    [{ amountMinor: 0, currency: 'MYR' }, ['INVALID_AMOUNT']],
    [{ amountMinor: -5, currency: 'MYR' }, ['INVALID_AMOUNT']],
    [{ amountMinor: 10.5, currency: 'MYR' }, ['INVALID_AMOUNT']],
    [{ amountMinor: 2 ** 53, currency: 'MYR' }, ['INVALID_AMOUNT']],
    [{ amountMinor: 100, currency: 'myr' }, ['INVALID_CURRENCY']],
    [{ amountMinor: 100, currency: 'RM' }, ['INVALID_CURRENCY']],
  ])('validates %j', (money, expected) => {
    expect(validateMoney(money).map((v) => v.code)).toEqual(expected);
  });

  it('validates calendar dates', () => {
    expect(isCalendarDate('2024-02-29')).toBe(true);
    expect(isCalendarDate('2025-02-29')).toBe(false);
  });
});
