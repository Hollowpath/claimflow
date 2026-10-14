import type { ClaimStatus, FieldError } from '@claimflow/contracts';
import type { ReactNode } from 'react';

import type { ApiError } from '../api/client';
import { statusLabels } from '../lib/format';

export function StatusBadge({ status }: { readonly status: ClaimStatus }) {
  return (
    <span className={`badge badge-${status.toLowerCase().replace('_', '-')}`}>
      {statusLabels[status]}
    </span>
  );
}

export function Loading({ label = 'Loading…' }: { readonly label?: string }) {
  return (
    <div className="state state-loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      {label}
    </div>
  );
}

export function EmptyState({
  title,
  children,
}: {
  readonly title: string;
  readonly children?: ReactNode;
}) {
  return (
    <div className="state state-empty">
      <p className="state-title">{title}</p>
      {children}
    </div>
  );
}

/**
 * Shows a safe error message from the API. Version conflicts get a clear
 * explanation and a way to load the latest data instead of overwriting it.
 */
export function ErrorNotice({
  error,
  onReload,
  showDetails = true,
}: {
  readonly error: ApiError;
  readonly onReload?: () => void;
  readonly showDetails?: boolean;
}) {
  if (error.isConflict) {
    return (
      <div className="notice notice-warning" role="alert">
        <strong>Someone else changed this first.</strong> Your change was not
        saved so their update is not lost.
        {onReload !== undefined && (
          <button type="button" className="link-button" onClick={onReload}>
            Load the latest version
          </button>
        )}
      </div>
    );
  }
  const details = showDetails ? error.details : [];
  return (
    <div className="notice notice-error" role="alert">
      <strong>{error.message}</strong>
      {details.length > 0 && (
        <ul>
          {details.map((detail) => (
            <li key={`${detail.field}:${detail.code}`}>{detail.message}</li>
          ))}
        </ul>
      )}
      {error.requestId !== undefined && (
        <span className="request-id">Reference: {error.requestId}</span>
      )}
      {onReload !== undefined && error.code !== 'VALIDATION_FAILED' && (
        <button type="button" className="link-button" onClick={onReload}>
          Try again
        </button>
      )}
    </div>
  );
}

/** Messages for one form field, matching `amount` to `amount.amountMinor`. */
export function fieldMessages(
  details: readonly FieldError[] | undefined,
  field: string,
): string[] {
  return (details ?? [])
    .filter((d) => d.field === field || d.field.startsWith(`${field}.`))
    .map((d) => d.message);
}

export function FieldMessages({
  id,
  messages,
}: {
  readonly id: string;
  readonly messages: readonly string[];
}) {
  if (messages.length === 0) {
    return null;
  }
  return (
    <p className="field-error" id={id}>
      {messages.join(' ')}
    </p>
  );
}
