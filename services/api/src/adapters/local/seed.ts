import type { Category } from '@claimflow/domain';

import type { UserProfile } from '../../application/ports.js';
import { emptyState, type DatabaseState } from './json-database.js';

/** Sample users for the local development runtime, chosen at sign-in. */
export const seedUsers: readonly UserProfile[] = [
  {
    userId: 'u-aisha',
    displayName: 'Aisha Rahman',
    title: 'Sales executive',
    roles: ['EMPLOYEE'],
    managerId: 'u-ben',
  },
  {
    userId: 'u-ravi',
    displayName: 'Ravi Kumar',
    title: 'Field engineer',
    roles: ['EMPLOYEE'],
    managerId: 'u-ben',
  },
  {
    userId: 'u-ben',
    displayName: 'Ben Tan',
    title: 'Sales manager',
    roles: ['EMPLOYEE', 'MANAGER'],
    managerId: 'u-chloe',
  },
  {
    userId: 'u-chloe',
    displayName: 'Chloe Lim',
    title: 'Senior manager',
    roles: ['MANAGER'],
  },
  {
    userId: 'u-dan',
    displayName: 'Dan Wong',
    title: 'Finance administrator',
    roles: ['ADMIN'],
  },
];

const seededAt = '2026-01-01T00:00:00.000Z';

function category(
  categoryId: string,
  name: string,
  maxAmountMinor: number,
  receiptRequiredAboveMinor: number,
  active = true,
): Category {
  return {
    categoryId,
    name,
    active,
    currency: 'MYR',
    maxAmountMinor,
    receiptRequiredAboveMinor,
    version: 1,
    createdAt: seededAt,
    updatedAt: seededAt,
    updatedBy: 'u-dan',
  };
}

export const seedCategories: readonly Category[] = [
  category('travel', 'Travel', 200_000, 20_000),
  category('meals', 'Meals and entertainment', 30_000, 5_000),
  category('equipment', 'Equipment', 500_000, 0),
  category('training', 'Training and courses', 300_000, 0, false),
];

export function seedState(): DatabaseState {
  return {
    ...emptyState(),
    categories: Object.fromEntries(
      seedCategories.map((c) => [c.categoryId, c]),
    ),
  };
}
