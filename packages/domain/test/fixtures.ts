import {
  createDraftClaim,
  type Actor,
  type Category,
  type Claim,
  type ClaimDetails,
  type CommandContext,
  type UploadedReceipt,
} from '../src/index.js';

export const now = '2026-10-14T09:00:00.000Z';

export const aisha: Actor = {
  userId: 'u-aisha',
  displayName: 'Aisha',
  roles: ['EMPLOYEE'],
  managerId: 'u-ben',
};
export const ravi: Actor = {
  userId: 'u-ravi',
  displayName: 'Ravi',
  roles: ['EMPLOYEE'],
  managerId: 'u-ben',
};
export const ben: Actor = {
  userId: 'u-ben',
  displayName: 'Ben',
  roles: ['EMPLOYEE', 'MANAGER'],
  managerId: 'u-chloe',
};
export const chloe: Actor = {
  userId: 'u-chloe',
  displayName: 'Chloe',
  roles: ['MANAGER'],
};
export const dan: Actor = {
  userId: 'u-dan',
  displayName: 'Dan',
  roles: ['ADMIN'],
};

export const as = (actor: Actor): CommandContext => ({ actor, now });

export const travel: Category = {
  categoryId: 'travel',
  name: 'Travel',
  active: true,
  currency: 'MYR',
  maxAmountMinor: 200_000,
  receiptRequiredAboveMinor: 20_000,
  version: 1,
  createdAt: now,
  updatedAt: now,
  updatedBy: 'u-dan',
};

export const completeDetails: ClaimDetails = {
  categoryId: 'travel',
  amount: { amountMinor: 15_000, currency: 'MYR' },
  expenseDate: '2026-10-10',
  merchant: 'City Taxi',
  businessPurpose: 'Client visit',
};

export function draft(
  overrides: Partial<Claim> = {},
  owner: Actor = aisha,
): Claim {
  return {
    ...createDraftClaim('c-1', completeDetails, travel, as(owner)).claim,
    ...overrides,
  };
}

export function upload(
  overrides: Partial<UploadedReceipt> = {},
): UploadedReceipt {
  return {
    receiptId: 'r-1',
    ownerId: 'u-aisha',
    fileName: 'receipt.pdf',
    contentType: 'application/pdf',
    sizeBytes: 2048,
    checksumSha256: 'a'.repeat(64),
    uploadedAt: now,
    ...overrides,
  };
}

/** A claim in the given state, owned by Aisha and assigned to Ben. */
export function claimIn(status: Claim['status']): Claim {
  return draft({
    status,
    assignedManagerId: 'u-ben',
    ...(status === 'DRAFT' ? {} : { submittedAt: now }),
  });
}
