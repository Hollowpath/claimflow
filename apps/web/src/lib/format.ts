import type {
  ClaimAction,
  ClaimDto,
  ClaimHistoryAction,
  ClaimStatus,
  Role,
} from '@claimflow/contracts';

export const statusLabels: Record<ClaimStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  UNDER_REVIEW: 'Under review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  PAID: 'Paid',
};

export const actionLabels: Record<ClaimAction, string> = {
  SUBMIT: 'Submit for approval',
  START_REVIEW: 'Start review',
  APPROVE: 'Approve',
  REJECT: 'Reject',
  REOPEN: 'Reopen to edit',
  MARK_PAID: 'Mark as paid',
};

export const historyLabels: Record<ClaimHistoryAction, string> = {
  CREATE: 'Created draft',
  UPDATE: 'Edited draft',
  ATTACH_RECEIPT: 'Attached receipt',
  REPLACE_RECEIPT: 'Replaced receipt',
  REMOVE_RECEIPT: 'Removed receipt',
  SUBMIT: 'Submitted',
  START_REVIEW: 'Started review',
  APPROVE: 'Approved',
  REJECT: 'Rejected',
  REOPEN: 'Reopened',
  MARK_PAID: 'Marked as paid',
};

export const roleLabels: Record<Role, string> = {
  EMPLOYEE: 'Employee',
  MANAGER: 'Manager',
  ADMIN: 'Administrator',
};

export function formatDate(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? isoDate
    : date.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      });
}

export function formatDateTime(isoInstant: string): string {
  return new Date(isoInstant).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Who has the next move on a claim, in words. It only restates the documented
 * lifecycle for the claim's current status; the server decides what is allowed.
 */
export function nextStepText(
  claim: Pick<ClaimDto, 'status' | 'assignedManager'>,
): string {
  const manager = claim.assignedManager?.displayName ?? 'the manager';
  switch (claim.status) {
    case 'DRAFT':
      return 'Complete the details and submit';
    case 'SUBMITTED':
      return `Waiting for ${manager} to start the review`;
    case 'UNDER_REVIEW':
      return `Being reviewed by ${manager}`;
    case 'APPROVED':
      return 'Waiting for payment';
    case 'REJECTED':
      return 'Reopen to edit and resubmit';
    case 'PAID':
      return 'Nothing further';
  }
}

const dayMs = 24 * 60 * 60 * 1000;

/** How long ago an instant was, in whole days: "Today", "1 day ago", "5 days ago". */
export function formatAge(
  isoInstant: string,
  now: number = Date.now(),
): string {
  const days = Math.floor((now - new Date(isoInstant).getTime()) / dayMs);
  if (Number.isNaN(days) || days <= 0) {
    return 'Today';
  }
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Today's local date as `YYYY-MM-DD`. */
export function localToday(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}
