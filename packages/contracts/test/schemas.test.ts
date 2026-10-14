import { describe, expect, it } from 'vitest';

import {
  adminClaimListQuerySchema,
  claimDecisionRequestSchema,
  createCategoryRequestSchema,
  createClaimRequestSchema,
  idempotencyKeySchema,
  updateClaimRequestSchema,
} from '../src/index.js';

describe('request schemas', () => {
  it.each(['employeeId', 'status', 'roles', 'assignedManagerId', 'version'])(
    'rejects a client-supplied %s',
    (field) => {
      expect(
        createClaimRequestSchema.safeParse({
          merchant: 'City Taxi',
          [field]: 'x',
        }).success,
      ).toBe(false);
    },
  );

  it('accepts a partial draft and rejects fractional minor units', () => {
    expect(createClaimRequestSchema.parse({})).toEqual({});
    expect(
      createClaimRequestSchema.safeParse({
        amount: { amountMinor: 10.5, currency: 'MYR' },
      }).success,
    ).toBe(false);
  });

  it('distinguishes cleared fields from unchanged ones', () => {
    expect(
      updateClaimRequestSchema.parse({ expectedVersion: 2, merchant: null }),
    ).toEqual({ expectedVersion: 2, merchant: null });
    expect(updateClaimRequestSchema.safeParse({ merchant: 'x' }).success).toBe(
      false,
    );
  });

  it('requires a comment string on decisions', () => {
    expect(
      claimDecisionRequestSchema.safeParse({ expectedVersion: 1 }).success,
    ).toBe(false);
  });

  it('defaults new categories to active', () => {
    expect(
      createCategoryRequestSchema.parse({
        name: 'Meals',
        currency: 'MYR',
        maxAmountMinor: 100,
        receiptRequiredAboveMinor: 0,
      }).active,
    ).toBe(true);
  });

  it('coerces and bounds pagination parameters', () => {
    expect(adminClaimListQuerySchema.parse({ limit: '5' })).toEqual({
      limit: 5,
    });
    expect(adminClaimListQuerySchema.safeParse({ limit: '500' }).success).toBe(
      false,
    );
    expect(
      adminClaimListQuerySchema.safeParse({ status: 'ARCHIVED' }).success,
    ).toBe(false);
  });

  it('validates idempotency keys', () => {
    expect(idempotencyKeySchema.safeParse('0f8c7e1a-retry').success).toBe(true);
    expect(idempotencyKeySchema.safeParse('short').success).toBe(false);
    expect(idempotencyKeySchema.safeParse('has space!!').success).toBe(false);
  });
});
