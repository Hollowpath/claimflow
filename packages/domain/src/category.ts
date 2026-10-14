import { hasRole, type Actor } from './actor.js';
import { DomainError, throwIfViolations, type Violation } from './errors.js';
import { isCurrencyCode, isPositiveMinorAmount } from './money.js';

export const categoryNameMaxLength = 80;

/** Administrator-managed settings that drive claim policy. */
export interface CategorySettings {
  readonly name: string;
  readonly active: boolean;
  readonly currency: string;
  /** Largest claimable amount, inclusive, in minor units. */
  readonly maxAmountMinor: number;
  /** A receipt is required when the amount is strictly above this value. */
  readonly receiptRequiredAboveMinor: number;
}

export interface Category extends CategorySettings {
  readonly categoryId: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

interface Context {
  readonly actor: Actor;
  readonly now: string;
}

export function createCategory(
  categoryId: string,
  settings: CategorySettings,
  { actor, now }: Context,
): Category {
  assertAdministrator(actor);
  const normalized = normalize(settings);
  throwIfViolations(
    validateCategorySettings(normalized),
    'The category settings are not valid.',
  );
  return {
    categoryId,
    ...normalized,
    version: 1,
    createdAt: now,
    updatedAt: now,
    updatedBy: actor.userId,
  };
}

export function updateCategory(
  category: Category,
  changes: Partial<CategorySettings>,
  { actor, now }: Context,
): Category {
  assertAdministrator(actor);
  const normalized = normalize({
    name: changes.name ?? category.name,
    active: changes.active ?? category.active,
    currency: changes.currency ?? category.currency,
    maxAmountMinor: changes.maxAmountMinor ?? category.maxAmountMinor,
    receiptRequiredAboveMinor:
      changes.receiptRequiredAboveMinor ?? category.receiptRequiredAboveMinor,
  });
  throwIfViolations(
    validateCategorySettings(normalized),
    'The category settings are not valid.',
  );
  return {
    ...category,
    ...normalized,
    version: category.version + 1,
    updatedAt: now,
    updatedBy: actor.userId,
  };
}

export function validateCategorySettings(
  settings: CategorySettings,
): readonly Violation[] {
  const violations: Violation[] = [];
  if (settings.name.trim() === '') {
    violations.push({
      field: 'name',
      code: 'REQUIRED',
      message: 'Name is required.',
    });
  } else if (settings.name.length > categoryNameMaxLength) {
    violations.push({
      field: 'name',
      code: 'TOO_LONG',
      message: `Name must be at most ${categoryNameMaxLength} characters.`,
    });
  }
  if (!isCurrencyCode(settings.currency)) {
    violations.push({
      field: 'currency',
      code: 'INVALID_CURRENCY',
      message: 'Currency must be a three-letter uppercase code.',
    });
  }
  if (!isPositiveMinorAmount(settings.maxAmountMinor)) {
    violations.push({
      field: 'maxAmountMinor',
      code: 'INVALID_SETTING',
      message: 'Maximum amount must be a positive whole number of minor units.',
    });
  }
  if (
    !Number.isSafeInteger(settings.receiptRequiredAboveMinor) ||
    settings.receiptRequiredAboveMinor < 0
  ) {
    violations.push({
      field: 'receiptRequiredAboveMinor',
      code: 'INVALID_SETTING',
      message:
        'Receipt threshold must be zero or a positive whole number of minor units.',
    });
  }
  return violations;
}

/** A receipt is required only when the amount is strictly above the threshold. */
export function isReceiptRequired(
  category: CategorySettings,
  amountMinor: number,
): boolean {
  return amountMinor > category.receiptRequiredAboveMinor;
}

/**
 * Throws unless the actor may delete categories. Whether the category is still
 * used by claims is checked by the caller, which can query stored claims.
 */
export function assertMayDeleteCategory(actor: Actor): void {
  assertAdministrator(actor);
}

function assertAdministrator(actor: Actor): void {
  if (!hasRole(actor, 'ADMIN')) {
    throw new DomainError(
      'FORBIDDEN',
      'Only an administrator may manage categories.',
    );
  }
}

function normalize(settings: CategorySettings): CategorySettings {
  return { ...settings, name: settings.name.trim() };
}
