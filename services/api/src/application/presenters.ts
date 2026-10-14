import type {
  CategoryDto,
  ClaimDto,
  ClaimHistoryEntryDto,
  PersonRef,
  UploadedReceiptDto,
} from '@claimflow/contracts';
import {
  availableActions,
  canDeleteClaim,
  canEditClaim,
  type Actor,
  type Category,
  type Claim,
  type ClaimHistoryEntry,
  type UploadedReceipt,
} from '@claimflow/domain';

import type { CategoryRepository, UserDirectory } from './ports.js';

/** Display names needed to present claims, loaded once per request. */
export interface Names {
  person(userId: string): PersonRef;
  categoryName(categoryId: string): string | undefined;
}

export async function loadNames(
  users: UserDirectory,
  categories: CategoryRepository,
): Promise<Names> {
  const [userList, categoryList] = await Promise.all([
    users.list(),
    categories.list(),
  ]);
  const userNames = new Map(userList.map((u) => [u.userId, u.displayName]));
  const categoryNames = new Map(
    categoryList.map((c) => [c.categoryId, c.name]),
  );
  return {
    person: (userId) => ({
      userId,
      displayName: userNames.get(userId) ?? 'Unknown user',
    }),
    categoryName: (categoryId) => categoryNames.get(categoryId),
  };
}

export function toClaimDto(claim: Claim, actor: Actor, names: Names): ClaimDto {
  const categoryName =
    claim.categoryId === undefined
      ? undefined
      : names.categoryName(claim.categoryId);
  return {
    claimId: claim.claimId,
    employee: names.person(claim.employeeId),
    ...(claim.assignedManagerId === undefined
      ? {}
      : { assignedManager: names.person(claim.assignedManagerId) }),
    ...(claim.categoryId === undefined ? {} : { categoryId: claim.categoryId }),
    ...(categoryName === undefined ? {} : { categoryName }),
    ...(claim.amount === undefined ? {} : { amount: claim.amount }),
    ...(claim.expenseDate === undefined
      ? {}
      : { expenseDate: claim.expenseDate }),
    ...(claim.merchant === undefined ? {} : { merchant: claim.merchant }),
    ...(claim.businessPurpose === undefined
      ? {}
      : { businessPurpose: claim.businessPurpose }),
    ...(claim.receipt === undefined ? {} : { receipt: claim.receipt }),
    status: claim.status,
    version: claim.version,
    createdAt: claim.createdAt,
    updatedAt: claim.updatedAt,
    ...(claim.submittedAt === undefined
      ? {}
      : { submittedAt: claim.submittedAt }),
    ...(claim.reviewedAt === undefined ? {} : { reviewedAt: claim.reviewedAt }),
    permissions: {
      canEdit: canEditClaim(claim, actor),
      canDelete: canDeleteClaim(claim, actor),
      actions: availableActions(claim, actor),
    },
  };
}

export function toHistoryDto(
  entry: ClaimHistoryEntry,
  names: Names,
): ClaimHistoryEntryDto {
  return {
    version: entry.version,
    action: entry.action,
    ...(entry.fromStatus === undefined ? {} : { fromStatus: entry.fromStatus }),
    toStatus: entry.toStatus,
    actor: names.person(entry.actorId),
    occurredAt: entry.occurredAt,
    ...(entry.comment === undefined ? {} : { comment: entry.comment }),
  };
}

export function toCategoryDto(category: Category): CategoryDto {
  return {
    categoryId: category.categoryId,
    name: category.name,
    active: category.active,
    currency: category.currency,
    maxAmountMinor: category.maxAmountMinor,
    receiptRequiredAboveMinor: category.receiptRequiredAboveMinor,
    version: category.version,
    updatedAt: category.updatedAt,
  };
}

export function toUploadedReceiptDto(
  upload: UploadedReceipt,
): UploadedReceiptDto {
  return {
    receiptId: upload.receiptId,
    fileName: upload.fileName,
    contentType: upload.contentType,
    sizeBytes: upload.sizeBytes,
    checksumSha256: upload.checksumSha256,
    uploadedAt: upload.uploadedAt,
  };
}
