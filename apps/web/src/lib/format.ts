import type {
  ClaimAction,
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
