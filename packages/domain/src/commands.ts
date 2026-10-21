import { hasRole, type Actor } from './actor.js';
import { isReceiptRequired, type Category } from './category.js';
import {
  assertMayPerform,
  businessPurposeMaxLength,
  isClaimOwner,
  merchantMaxLength,
  nextStatus,
  type Claim,
  type ClaimAction,
  type ClaimChange,
  type ClaimDetails,
  type ClaimDetailsChanges,
  type ClaimDetailsInput,
  type ClaimHistoryAction,
} from './claim.js';
import { isCalendarDate, isFutureCalendarDate } from './dates.js';
import { DomainError, throwIfViolations, type Violation } from './errors.js';
import { validateMoney } from './money.js';
import {
  verifyReceiptForAttachment,
  type ReceiptDeclaration,
  type UploadedReceipt,
} from './receipt.js';

export const decisionCommentMaxLength = 1000;

export interface CommandContext {
  readonly actor: Actor;
  /** ISO 8601 instant supplied by the caller so the domain stays pure. */
  readonly now: string;
}

/**
 * Creates a draft. `category` is the stored category for `details.categoryId`,
 * or `undefined` when none was given or it does not exist.
 */
export function createDraftClaim(
  claimId: string,
  details: ClaimDetailsInput,
  category: Category | undefined,
  { actor, now }: CommandContext,
): ClaimChange {
  if (!hasRole(actor, 'EMPLOYEE')) {
    throw new DomainError('FORBIDDEN', 'Only employees may create claims.');
  }

  const normalized = normalizeDetails(details);
  throwIfViolations(
    validateDraftDetails(normalized, now, {
      checkCategory: normalized.categoryId !== undefined,
      category,
    }),
    'The claim details are not valid.',
  );

  const claim: Claim = {
    ...normalized,
    claimId,
    employeeId: actor.userId,
    status: 'DRAFT',
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  return {
    claim,
    history: {
      claimId,
      version: 1,
      action: 'CREATE',
      toStatus: 'DRAFT',
      actorId: actor.userId,
      occurredAt: now,
    },
  };
}

/**
 * Edits a draft. `category` is the stored category for the new `categoryId`
 * when the edit changes it; an unchanged category is not re-checked here so an
 * existing draft stays editable after its category is deactivated.
 */
export function updateDraftClaim(
  claim: Claim,
  changes: ClaimDetailsChanges,
  category: Category | undefined,
  context: CommandContext,
): ClaimChange {
  assertEditable(claim, context.actor);

  const merged = normalizeDetails(applyChanges(claim, changes));
  const categoryChanged =
    merged.categoryId !== undefined && merged.categoryId !== claim.categoryId;
  throwIfViolations(
    validateDraftDetails(merged, context.now, {
      checkCategory: categoryChanged,
      category,
    }),
    'The claim details are not valid.',
  );

  const {
    categoryId,
    amount,
    expenseDate,
    merchant,
    businessPurpose,
    ...rest
  } = claim;
  return editDraft({ ...rest, ...merged }, 'UPDATE', context);
}

export function attachReceipt(
  claim: Claim,
  upload: UploadedReceipt,
  declaration: ReceiptDeclaration,
  context: CommandContext,
): ClaimChange {
  assertEditable(claim, context.actor);
  throwIfViolations(
    verifyReceiptForAttachment(upload, declaration, claim, context.actor),
    'The receipt cannot be attached.',
  );

  return editDraft(
    {
      ...claim,
      receipt: {
        receiptId: upload.receiptId,
        fileName: upload.fileName,
        contentType: upload.contentType,
        sizeBytes: upload.sizeBytes,
        checksumSha256: upload.checksumSha256,
        attachedAt: context.now,
      },
    },
    claim.receipt === undefined ? 'ATTACH_RECEIPT' : 'REPLACE_RECEIPT',
    context,
    claim,
  );
}

export function removeReceipt(
  claim: Claim,
  context: CommandContext,
): ClaimChange {
  assertEditable(claim, context.actor);
  const { receipt, ...withoutReceipt } = claim;
  if (receipt === undefined) {
    throw new DomainError('VALIDATION_FAILED', 'The claim has no receipt.', [
      {
        field: 'receipt',
        code: 'NO_RECEIPT',
        message: 'There is no receipt to remove.',
      },
    ]);
  }
  return editDraft(withoutReceipt, 'REMOVE_RECEIPT', context, claim);
}

/**
 * Checks every submission rule against the current category policy. `category`
 * is the stored category for `claim.categoryId`, or `undefined` if none exists.
 */
export function evaluateSubmission(
  claim: Claim,
  category: Category | undefined,
  now: string,
): readonly Violation[] {
  if (category !== undefined && category.categoryId !== claim.categoryId) {
    // Loading the wrong category is a caller defect, not a user input error.
    throw new Error(
      `Category ${category.categoryId} does not apply to this claim.`,
    );
  }

  const violations: Violation[] = [];
  for (const field of [
    'categoryId',
    'amount',
    'expenseDate',
    'merchant',
    'businessPurpose',
  ] as const) {
    if (claim[field] === undefined) {
      violations.push({
        field,
        code: 'REQUIRED',
        message: `${fieldLabels[field]} is required.`,
      });
    }
  }

  violations.push(
    ...validateDraftDetails(claim, now, {
      checkCategory: claim.categoryId !== undefined,
      category,
    }),
  );

  const { amount } = claim;
  if (category?.active === true && amount !== undefined) {
    if (amount.currency !== category.currency) {
      violations.push({
        field: 'amount.currency',
        code: 'CURRENCY_MISMATCH',
        message: `This category is paid in ${category.currency}.`,
      });
    } else if (amount.amountMinor > category.maxAmountMinor) {
      violations.push({
        field: 'amount.amountMinor',
        code: 'LIMIT_EXCEEDED',
        message: 'The amount is above the category limit.',
      });
    }
    if (
      isReceiptRequired(category, amount.amountMinor) &&
      claim.receipt === undefined
    ) {
      violations.push({
        field: 'receipt',
        code: 'RECEIPT_REQUIRED',
        message: 'A receipt is required for this amount.',
      });
    }
  }
  return violations;
}

/** Submits or resubmits a draft, re-evaluating the current policy. */
export function submitClaim(
  claim: Claim,
  category: Category | undefined,
  context: CommandContext,
): ClaimChange {
  const { actor, now } = context;
  assertMayPerform(claim, 'SUBMIT', actor);
  nextStatus(claim.status, 'SUBMIT');

  const violations = [...evaluateSubmission(claim, category, now)];
  const managerId = actor.managerId;
  if (managerId === undefined || managerId === claim.employeeId) {
    violations.push({
      field: 'assignedManagerId',
      code: 'NO_MANAGER_ASSIGNED',
      message: 'You have no manager to review your claims.',
    });
  }
  throwIfViolations(violations, 'The claim cannot be submitted yet.');

  const { reviewedAt, ...rest } = claim;
  return transition(
    { ...rest, assignedManagerId: managerId as string, submittedAt: now },
    'SUBMIT',
    context,
    claim,
  );
}

export function startReview(
  claim: Claim,
  context: CommandContext,
): ClaimChange {
  return lifecycleChange(claim, 'START_REVIEW', context);
}

export function approveClaim(
  claim: Claim,
  comment: string,
  context: CommandContext,
): ClaimChange {
  return decide(claim, 'APPROVE', comment, context);
}

export function rejectClaim(
  claim: Claim,
  comment: string,
  context: CommandContext,
): ClaimChange {
  return decide(claim, 'REJECT', comment, context);
}

export function reopenClaim(
  claim: Claim,
  context: CommandContext,
): ClaimChange {
  return lifecycleChange(claim, 'REOPEN', context);
}

export function markClaimPaid(
  claim: Claim,
  context: CommandContext,
): ClaimChange {
  return lifecycleChange(claim, 'MARK_PAID', context);
}

const fieldLabels: Record<keyof ClaimDetails, string> = {
  categoryId: 'Category',
  amount: 'Amount',
  expenseDate: 'Expense date',
  merchant: 'Merchant',
  businessPurpose: 'Business purpose',
};

function decide(
  claim: Claim,
  action: 'APPROVE' | 'REJECT',
  comment: string,
  context: CommandContext,
): ClaimChange {
  assertMayPerform(claim, action, context.actor);
  nextStatus(claim.status, action);

  const trimmed = comment.trim();
  if (trimmed === '') {
    throw new DomainError('VALIDATION_FAILED', 'A comment is required.', [
      {
        field: 'comment',
        code: 'COMMENT_REQUIRED',
        message: 'Explain your decision in a comment.',
      },
    ]);
  }
  if (trimmed.length > decisionCommentMaxLength) {
    throw new DomainError('VALIDATION_FAILED', 'The comment is too long.', [
      {
        field: 'comment',
        code: 'TOO_LONG',
        message: `Comments must be at most ${decisionCommentMaxLength} characters.`,
      },
    ]);
  }

  return transition(
    { ...claim, reviewedAt: context.now },
    action,
    context,
    claim,
    trimmed,
  );
}

function lifecycleChange(
  claim: Claim,
  action: ClaimAction,
  context: CommandContext,
): ClaimChange {
  assertMayPerform(claim, action, context.actor);
  nextStatus(claim.status, action);
  return transition(claim, action, context, claim);
}

function transition(
  updated: Claim,
  action: ClaimAction,
  { actor, now }: CommandContext,
  previous: Claim,
  comment?: string,
): ClaimChange {
  const claim: Claim = {
    ...updated,
    status: nextStatus(previous.status, action),
    version: previous.version + 1,
    updatedAt: now,
  };
  return {
    claim,
    history: {
      claimId: claim.claimId,
      version: claim.version,
      action,
      fromStatus: previous.status,
      toStatus: claim.status,
      actorId: actor.userId,
      occurredAt: now,
      ...(comment === undefined ? {} : { comment }),
    },
  };
}

function editDraft(
  updated: Claim,
  action: ClaimHistoryAction,
  { actor, now }: CommandContext,
  previous: Claim = updated,
): ClaimChange {
  const claim: Claim = {
    ...updated,
    version: previous.version + 1,
    updatedAt: now,
  };
  return {
    claim,
    history: {
      claimId: claim.claimId,
      version: claim.version,
      action,
      fromStatus: 'DRAFT',
      toStatus: 'DRAFT',
      actorId: actor.userId,
      occurredAt: now,
    },
  };
}

export function assertEditable(claim: Claim, actor: Actor): void {
  if (!isClaimOwner(claim, actor)) {
    throw new DomainError(
      'FORBIDDEN',
      'Only the employee who owns the claim may edit it.',
    );
  }
  if (claim.status !== 'DRAFT') {
    throw new DomainError(
      'CLAIM_NOT_EDITABLE',
      `A ${claim.status} claim cannot be edited.`,
    );
  }
}

function applyChanges(
  claim: ClaimDetails,
  changes: ClaimDetailsChanges,
): ClaimDetailsInput {
  const value = <K extends keyof ClaimDetails>(field: K) =>
    changes[field] === undefined ? claim[field] : (changes[field] ?? undefined);
  return {
    categoryId: value('categoryId'),
    amount: value('amount'),
    expenseDate: value('expenseDate'),
    merchant: value('merchant'),
    businessPurpose: value('businessPurpose'),
  };
}

/**
 * Copies only the editable fields, trims text, and drops blank values, so
 * identity, status, and audit data can never arrive through a details object.
 */
function normalizeDetails(details: ClaimDetailsInput): ClaimDetails {
  const text = (value: string | undefined) => {
    const trimmed = value?.trim();
    return trimmed === '' ? undefined : trimmed;
  };
  const categoryId = text(details.categoryId);
  const expenseDate = text(details.expenseDate);
  const merchant = text(details.merchant);
  const businessPurpose = text(details.businessPurpose);
  const { amount } = details;
  return {
    ...(categoryId === undefined ? {} : { categoryId }),
    ...(amount === undefined
      ? {}
      : {
          amount: {
            amountMinor: amount.amountMinor,
            currency: amount.currency,
          },
        }),
    ...(expenseDate === undefined ? {} : { expenseDate }),
    ...(merchant === undefined ? {} : { merchant }),
    ...(businessPurpose === undefined ? {} : { businessPurpose }),
  };
}

/** Format checks that apply to drafts as well as submissions. */
function validateDraftDetails(
  details: ClaimDetailsInput,
  now: string,
  {
    checkCategory,
    category,
  }: { checkCategory: boolean; category: Category | undefined },
): Violation[] {
  const violations: Violation[] = [];

  if (checkCategory) {
    if (category === undefined) {
      violations.push({
        field: 'categoryId',
        code: 'CATEGORY_NOT_FOUND',
        message: 'The selected category does not exist.',
      });
    } else if (!category.active) {
      violations.push({
        field: 'categoryId',
        code: 'CATEGORY_INACTIVE',
        message: 'The selected category is no longer available.',
      });
    }
  }

  if (details.amount !== undefined) {
    violations.push(...validateMoney(details.amount));
  }

  if (details.expenseDate !== undefined) {
    if (!isCalendarDate(details.expenseDate)) {
      violations.push({
        field: 'expenseDate',
        code: 'INVALID_DATE',
        message: 'Expense date must be a valid date.',
      });
    } else if (isFutureCalendarDate(details.expenseDate, now)) {
      violations.push({
        field: 'expenseDate',
        code: 'FUTURE_DATE',
        message: 'Expense date cannot be in the future.',
      });
    }
  }

  if ((details.merchant?.length ?? 0) > merchantMaxLength) {
    violations.push({
      field: 'merchant',
      code: 'TOO_LONG',
      message: `Merchant must be at most ${merchantMaxLength} characters.`,
    });
  }
  if ((details.businessPurpose?.length ?? 0) > businessPurposeMaxLength) {
    violations.push({
      field: 'businessPurpose',
      code: 'TOO_LONG',
      message: `Business purpose must be at most ${businessPurposeMaxLength} characters.`,
    });
  }

  return violations;
}
