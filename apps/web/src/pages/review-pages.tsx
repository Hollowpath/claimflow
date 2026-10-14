import { claimStatuses, type ClaimStatus } from '@claimflow/contracts';
import { useSearchParams } from 'react-router';

import { api } from '../api/claimflow';
import { ClaimList } from '../components/claim-list';
import { statusLabels } from '../lib/format';

export function ReviewQueuePage() {
  return (
    <>
      <h1>Review queue</h1>
      <p className="muted">
        Claims assigned to you that are waiting for or under review, oldest
        first.
      </p>
      <ClaimList
        load={(cursor, signal) => api.listReviewQueue(cursor, signal)}
        showEmployee
        emptyTitle="Nothing to review right now."
      />
    </>
  );
}

export function AdminClaimsPage() {
  const [params, setParams] = useSearchParams();
  const requested = params.get('status');
  const status = claimStatuses.find((s) => s === requested);

  const choose = (next: ClaimStatus | undefined) =>
    setParams(next === undefined ? {} : { status: next });

  return (
    <>
      <h1>All claims</h1>
      <div className="tabs" role="group" aria-label="Filter by status">
        <button
          type="button"
          aria-pressed={status === undefined}
          onClick={() => choose(undefined)}
        >
          All
        </button>
        {claimStatuses.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={status === s}
            onClick={() => choose(s)}
          >
            {statusLabels[s]}
          </button>
        ))}
      </div>
      <ClaimList
        key={status ?? 'all'}
        load={(cursor, signal) => api.listAllClaims(status, cursor, signal)}
        deps={[status]}
        showEmployee
        emptyTitle={
          status === undefined
            ? 'There are no claims yet.'
            : `No ${statusLabels[status].toLowerCase()} claims.`
        }
      />
    </>
  );
}
