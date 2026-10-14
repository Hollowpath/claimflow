import type { Violation } from './errors.js';

/** A monetary amount in integer minor units, e.g. 1050 MYR is RM 10.50. */
export interface Money {
  readonly amountMinor: number;
  readonly currency: string;
}

const currencyPattern = /^[A-Z]{3}$/;

export function isCurrencyCode(value: string): boolean {
  return currencyPattern.test(value);
}

/** A claimable amount is a positive integer that is exactly representable. */
export function isPositiveMinorAmount(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function validateMoney(
  money: Money,
  field = 'amount',
): readonly Violation[] {
  const violations: Violation[] = [];
  if (!isPositiveMinorAmount(money.amountMinor)) {
    violations.push({
      field: `${field}.amountMinor`,
      code: 'INVALID_AMOUNT',
      message: 'Amount must be a positive whole number of minor units.',
    });
  }
  if (!isCurrencyCode(money.currency)) {
    violations.push({
      field: `${field}.currency`,
      code: 'INVALID_CURRENCY',
      message: 'Currency must be a three-letter uppercase code.',
    });
  }
  return violations;
}
