import type { ClaimDto, Page } from '@claimflow/contracts';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';

import type { ApiError } from '../api/client';
import { formatDate } from '../lib/format';
import { formatMoney } from '../lib/money';
import {
  toApiError,
  useResource,
  type ResourceDeps,
} from '../lib/use-resource';
import { EmptyState, ErrorNotice, Loading, StatusBadge } from './ui';

/**
 * A paginated claim list. `load` fetches one page; "Show more" appends the
 * next page using the server's opaque cursor.
 */
export function ClaimList({
  load,
  deps = [],
  showEmployee = false,
  emptyTitle,
  emptyHint,
}: {
  readonly load: (
    cursor: string | undefined,
    signal?: AbortSignal,
  ) => Promise<Page<ClaimDto>>;
  readonly deps?: ResourceDeps;
  readonly showEmployee?: boolean;
  readonly emptyTitle: string;
  readonly emptyHint?: ReactNode;
}) {
  const first = useResource((signal) => load(undefined, signal), deps);
  const [more, setMore] = useState<{
    key: unknown;
    items: ClaimDto[];
    cursor?: string;
  }>({ key: null, items: [] });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<ApiError | null>(null);

  if (first.state === 'loading') {
    return <Loading label="Loading claims…" />;
  }
  if (first.state === 'error') {
    return <ErrorNotice error={first.error} onReload={first.reload} />;
  }

  // Extra pages belong to the first page they were loaded after.
  const extra =
    more.key === first.data ? more : { items: [], cursor: undefined };
  const claims = [...first.data.items, ...extra.items];
  const cursor = extra.items.length > 0 ? extra.cursor : first.data.nextCursor;

  async function showMore() {
    if (first.state !== 'ready') {
      return;
    }
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await load(cursor);
      setMore({
        key: first.data,
        items: [...extra.items, ...page.items],
        ...(page.nextCursor === undefined ? {} : { cursor: page.nextCursor }),
      });
    } catch (error) {
      setMoreError(toApiError(error));
    } finally {
      setLoadingMore(false);
    }
  }

  if (claims.length === 0) {
    return <EmptyState title={emptyTitle}>{emptyHint}</EmptyState>;
  }

  return (
    <>
      <ul className="claim-list" aria-label="Claims">
        {claims.map((claim) => (
          <li key={claim.claimId}>
            <Link to={`/claims/${claim.claimId}`} className="claim-card">
              <div className="claim-card-main">
                <span className="claim-merchant">
                  {claim.merchant ?? 'Untitled claim'}
                </span>
                <span className="claim-meta">
                  {[
                    showEmployee ? claim.employee.displayName : undefined,
                    claim.categoryName,
                    claim.expenseDate === undefined
                      ? undefined
                      : formatDate(claim.expenseDate),
                  ]
                    .filter(Boolean)
                    .join(' · ') || 'No details yet'}
                </span>
              </div>
              <span className="claim-amount">
                {claim.amount === undefined
                  ? '—'
                  : formatMoney(
                      claim.amount.amountMinor,
                      claim.amount.currency,
                    )}
              </span>
              <StatusBadge status={claim.status} />
            </Link>
          </li>
        ))}
      </ul>
      {moreError !== null && <ErrorNotice error={moreError} />}
      {cursor !== undefined && (
        <button
          type="button"
          className="button button-secondary load-more"
          disabled={loadingMore}
          onClick={() => void showMore()}
        >
          {loadingMore ? 'Loading…' : 'Show more'}
        </button>
      )}
    </>
  );
}
