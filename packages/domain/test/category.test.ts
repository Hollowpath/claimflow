import { describe, expect, it } from 'vitest';

import {
  createCategory,
  isReceiptRequired,
  updateCategory,
  type CategorySettings,
} from '../src/index.js';
import { aisha, as, ben, dan, now, travel } from './fixtures.js';

const settings: CategorySettings = {
  name: ' Meals ',
  active: true,
  currency: 'MYR',
  maxAmountMinor: 30_000,
  receiptRequiredAboveMinor: 5_000,
};

describe('category management', () => {
  it('lets an administrator create a category', () => {
    expect(createCategory('meals', settings, as(dan))).toEqual({
      categoryId: 'meals',
      ...settings,
      name: 'Meals',
      version: 1,
      createdAt: now,
      updatedAt: now,
      updatedBy: 'u-dan',
    });
  });

  it('forbids non-administrators', () => {
    for (const actor of [aisha, ben]) {
      expect(() => createCategory('meals', settings, as(actor))).toThrow(
        expect.objectContaining({ code: 'FORBIDDEN' }),
      );
      expect(() =>
        updateCategory(travel, { active: false }, as(actor)),
      ).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    }
  });

  it('updates limits, thresholds, and activation with a new version', () => {
    const updated = updateCategory(
      travel,
      { active: false, maxAmountMinor: 1, receiptRequiredAboveMinor: 0 },
      as(dan),
    );
    expect(updated).toMatchObject({
      active: false,
      maxAmountMinor: 1,
      receiptRequiredAboveMinor: 0,
      name: 'Travel',
      version: 2,
    });
  });

  it('validates every setting', () => {
    expect(() =>
      createCategory(
        'bad',
        {
          name: ' ',
          active: true,
          currency: 'usd',
          maxAmountMinor: 0,
          receiptRequiredAboveMinor: -1,
        },
        as(dan),
      ),
    ).toThrow(
      expect.objectContaining({
        violations: [
          expect.objectContaining({ field: 'name', code: 'REQUIRED' }),
          expect.objectContaining({ field: 'currency' }),
          expect.objectContaining({ field: 'maxAmountMinor' }),
          expect.objectContaining({ field: 'receiptRequiredAboveMinor' }),
        ],
      }),
    );
    expect(() =>
      updateCategory(travel, { name: 'x'.repeat(81) }, as(dan)),
    ).toThrow(
      expect.objectContaining({
        violations: [expect.objectContaining({ code: 'TOO_LONG' })],
      }),
    );
  });

  it('requires a receipt strictly above the threshold', () => {
    expect(isReceiptRequired(travel, 19_999)).toBe(false);
    expect(isReceiptRequired(travel, 20_000)).toBe(false);
    expect(isReceiptRequired(travel, 20_001)).toBe(true);
  });
});
