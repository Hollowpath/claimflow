import { hasRole, type Actor } from './actor.js';
import { DomainError } from './errors.js';
import type { Money } from './money.js';
import type { Receipt } from './receipt.js';

export const claimStatuses = [
  'DRAFT',
  'SUBMITTED',
  'UNDER_REVIEW',
  'APPROVED',
  'REJECTED',
  'PAID',
] as const;

export type ClaimStatus = (typeof claimStatuses)[number];

export const claimActions = [
  'SUBMIT',
  'START_REVIEW',
  'APPROVE',
  'REJECT',
  'REOPEN',
  'MARK_PAID',
] as const;

export type ClaimAction = (typeof claimActions)[number];

/** The only valid lifecycle transitions. Everything else is rejected. */
export const claimTransitions: Readonly<
  Record<ClaimAction, { readonly from: ClaimStatus; readonly to: ClaimStatus }>
> = {
  SUBMIT: { from: 'DRAFT', to: 'SUBMITTED' },
  START_REVIEW: { from: 'SUBMITTED', to: 'UNDER_REVIEW' },
  APPROVE: { from: 'UNDER_REVIEW', to: 'APPROVED' },
  REJECT: { from: 'UNDER_REVIEW', to: 'REJECTED' },
  REOPEN: { from: 'REJECTED', to: 'DRAFT' },
  MARK_PAID: { from: 'APPROVED', to: 'PAID' },
};

/** Claims awaiting or undergoing manager review. */
export const openReviewStatuses: readonly ClaimStatus[] = [
  'SUBMITTED',
  'UNDER_REVIEW',
];

export const claimHistoryActions = [
  'CREATE',
  'UPDATE',
  'ATTACH_RECEIPT',
  'REPLACE_RECEIPT',
  'REMOVE_RECEIPT',
  ...claimActions,
] as const;

export type ClaimHistoryAction = (typeof claimHistoryActions)[number];

export const merchantMaxLength = 120;
export const businessPurposeMaxLength = 500;

/** Employee-editable fields. All are optional while the claim is a draft. */
export interface ClaimDetails {
  readonly categoryId?: string;
  readonly amount?: Money;
  /** Calendar date in `YYYY-MM-DD` form. */
  readonly expenseDate?: string;
  readonly merchant?: string;
  readonly businessPurpose?: string;
}

/** A draft edit: a value sets the field, `null` clears it, absent leaves it. */
export type ClaimDetailsChanges = {
  readonly [K in keyof ClaimDetails]?:
    NonNullable<ClaimDetails[K]> | null | undefined;
};

/** Details for a new draft; absent and `undefined` fields are left empty. */
export type ClaimDetailsInput = {
  readonly [K in keyof ClaimDetails]?: ClaimDetails[K] | undefined;
};

export const claimDetailFields = [
  'categoryId',
  'amount',
  'expenseDate',
  'merchant',
  'businessPurpose',
] as const satisfies readonly (keyof ClaimDetails)[];

export interface Claim extends ClaimDetails {
  readonly claimId: string;
  readonly employeeId: string;
  /** Copied from the employee's profile at each submission. */
  readonly assignedManagerId?: string;
  readonly receipt?: Receipt;
  readonly status: ClaimStatus;
  /** Optimistic concurrency version; starts at 1 and grows by 1 per change. */
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly submittedAt?: string;
  readonly reviewedAt?: string;
}

/** Immutable audit record. `version` is the claim version it produced. */
export interface ClaimHistoryEntry {
  readonly claimId: string;
  readonly version: number;
  readonly action: ClaimHistoryAction;
  readonly fromStatus?: ClaimStatus;
  readonly toStatus: ClaimStatus;
  readonly actorId: string;
  readonly occurredAt: string;
  readonly comment?: string;
}

/** A new claim state and the history entry to persist with it. */
export interface ClaimChange {
  readonly claim: Claim;
  readonly history: ClaimHistoryEntry;
}

export function isValidTransition(from: ClaimStatus, to: ClaimStatus): boolean {
  return Object.values(claimTransitions).some(
    (transition) => transition.from === from && transition.to === to,
  );
}

export function nextStatus(
  status: ClaimStatus,
  action: ClaimAction,
): ClaimStatus {
  const transition = claimTransitions[action];
  if (transition.from !== status) {
    throw new DomainError(
      'INVALID_TRANSITION',
      `A ${status} claim cannot be changed with ${action}.`,
    );
  }
  return transition.to;
}

export function isClaimOwner(claim: Claim, actor: Actor): boolean {
  return hasRole(actor, 'EMPLOYEE') && claim.employeeId === actor.userId;
}

export function isAssignedManager(claim: Claim, actor: Actor): boolean {
  return (
    hasRole(actor, 'MANAGER') &&
    claim.assignedManagerId !== undefined &&
    claim.assignedManagerId === actor.userId
  );
}

/** The owner, the assigned manager, and administrators may see a claim. */
export function canViewClaim(claim: Claim, actor: Actor): boolean {
  return (
    claim.employeeId === actor.userId ||
    isAssignedManager(claim, actor) ||
    hasRole(actor, 'ADMIN')
  );
}

export function canEditClaim(claim: Claim, actor: Actor): boolean {
  return isClaimOwner(claim, actor) && claim.status === 'DRAFT';
}

/**
 * Only a draft that was never submitted may be deleted. Once a claim has been
 * submitted, it and its review history are kept permanently, even if it is
 * later reopened.
 */
export function canDeleteClaim(claim: Claim, actor: Actor): boolean {
  return canEditClaim(claim, actor) && claim.submittedAt === undefined;
}

/** Throws unless the actor may delete the claim. */
export function assertMayDeleteClaim(claim: Claim, actor: Actor): void {
  if (!isClaimOwner(claim, actor)) {
    throw new DomainError(
      'FORBIDDEN',
      'Only the employee who owns the claim may delete it.',
    );
  }
  if (claim.status !== 'DRAFT') {
    throw new DomainError(
      'CLAIM_NOT_EDITABLE',
      `A ${claim.status} claim cannot be deleted.`,
    );
  }
  if (claim.submittedAt !== undefined) {
    throw new DomainError(
      'CLAIM_NOT_DELETABLE',
      'A claim that has been submitted keeps its history and cannot be deleted.',
    );
  }
}

/** Throws unless the actor may perform the action, regardless of status. */
export function assertMayPerform(
  claim: Claim,
  action: ClaimAction,
  actor: Actor,
): void {
  switch (action) {
    case 'SUBMIT':
    case 'REOPEN':
      if (!isClaimOwner(claim, actor)) {
        throw new DomainError(
          'FORBIDDEN',
          'Only the employee who owns the claim may do this.',
        );
      }
      return;
    case 'START_REVIEW':
    case 'APPROVE':
    case 'REJECT':
      if (claim.employeeId === actor.userId) {
        throw new DomainError(
          'SELF_REVIEW_FORBIDDEN',
          'You cannot review your own claim.',
        );
      }
      if (!isAssignedManager(claim, actor)) {
        throw new DomainError(
          'FORBIDDEN',
          'Only the assigned manager may review this claim.',
        );
      }
      return;
    case 'MARK_PAID':
      if (!hasRole(actor, 'ADMIN')) {
        throw new DomainError(
          'FORBIDDEN',
          'Only an administrator may mark a claim as paid.',
        );
      }
      if (claim.employeeId === actor.userId) {
        throw new DomainError(
          'SELF_REVIEW_FORBIDDEN',
          'You cannot mark your own claim as paid.',
        );
      }
      return;
  }
}

/** Lifecycle actions the actor could perform on the claim right now. */
export function availableActions(claim: Claim, actor: Actor): ClaimAction[] {
  return claimActions.filter((action) => {
    if (claimTransitions[action].from !== claim.status) {
      return false;
    }
    try {
      assertMayPerform(claim, action, actor);
      return true;
    } catch (error) {
      if (error instanceof DomainError) {
        return false;
      }
      throw error;
    }
  });
}
