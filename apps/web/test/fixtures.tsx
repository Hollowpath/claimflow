import type {
  CategoryDto,
  ClaimDto,
  CurrentUserDto,
  Page,
  SessionDto,
  UserSummaryDto,
} from '@claimflow/contracts';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

import { ApiError } from '../src/api/client';
import { App } from '../src/app';

export const users: UserSummaryDto[] = [
  {
    userId: 'u-aisha',
    displayName: 'Aisha Rahman',
    title: 'Sales executive',
    roles: ['EMPLOYEE'],
  },
  {
    userId: 'u-ravi',
    displayName: 'Ravi Kumar',
    title: 'Field engineer',
    roles: ['EMPLOYEE'],
  },
  {
    userId: 'u-ben',
    displayName: 'Ben Tan',
    title: 'Sales manager',
    roles: ['EMPLOYEE', 'MANAGER'],
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

export function sessionFor(userId: string | null): SessionDto {
  const user = users.find((u) => u.userId === userId);
  return { user: (user as CurrentUserDto | undefined) ?? null, users };
}

export const travel: CategoryDto = {
  categoryId: 'travel',
  name: 'Travel',
  active: true,
  currency: 'MYR',
  maxAmountMinor: 200_000,
  receiptRequiredAboveMinor: 20_000,
  version: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
};

export const training: CategoryDto = {
  ...travel,
  categoryId: 'training',
  name: 'Training',
  active: false,
};

export function claim(overrides: Partial<ClaimDto> = {}): ClaimDto {
  return {
    claimId: 'c-1',
    employee: { userId: 'u-aisha', displayName: 'Aisha Rahman' },
    categoryId: 'travel',
    categoryName: 'Travel',
    amount: { amountMinor: 12_550, currency: 'MYR' },
    expenseDate: '2026-10-10',
    merchant: 'City Taxi',
    businessPurpose: 'Client visit',
    status: 'DRAFT',
    version: 1,
    createdAt: '2026-10-14T09:00:00.000Z',
    updatedAt: '2026-10-14T09:00:00.000Z',
    permissions: { canEdit: true, canDelete: true, actions: ['SUBMIT'] },
    ...overrides,
  };
}

export const page = <T,>(items: T[], nextCursor?: string): Page<T> => ({
  items,
  ...(nextCursor === undefined ? {} : { nextCursor }),
});

export function apiError(
  status: number,
  code: ConstructorParameters<typeof ApiError>[1],
  message: string,
  details: { field: string; code: string; message: string }[] = [],
) {
  return new ApiError(status, code, message, details, 'req-123');
}

/** Resolves only when `release` is called, to simulate a slow response. */
export function deferred<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

export function renderApp(path = '/') {
  const user = userEvent.setup();
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
  return { user, ...view };
}

export const never = () => new Promise<never>(() => undefined);
