import { claimStatuses, type ClaimStatus } from '@claimflow/contracts';
import Box from '@mui/material/Box';
import { useSearchParams } from 'react-router';

import { api } from '../api/claimflow';
import { ClaimList } from '../components/claim-list';
import { statusLabels } from '../lib/format';
import { SelectField } from '../ui/fields';
import { PageHeader } from '../ui/page-header';

export function ReviewQueuePage() {
  return (
    <>
      <PageHeader
        title="Review queue"
        subtitle="Claims assigned to you that are waiting for or under review, oldest first."
      />
      <ClaimList
        load={(cursor, signal) => api.listReviewQueue(cursor, signal)}
        variant="review"
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
      <PageHeader title="All claims" />
      <Box sx={{ maxWidth: 280, mb: 2 }}>
        <SelectField
          id="status-filter"
          label="Status"
          size="small"
          value={status ?? ''}
          onChange={(value) => choose(claimStatuses.find((s) => s === value))}
        >
          <option value="">All statuses</option>
          {claimStatuses.map((s) => (
            <option key={s} value={s}>
              {statusLabels[s]}
            </option>
          ))}
        </SelectField>
      </Box>
      <ClaimList
        key={status ?? 'all'}
        load={(cursor, signal) => api.listAllClaims(status, cursor, signal)}
        deps={[status]}
        variant="admin"
        emptyTitle={
          status === undefined
            ? 'There are no claims yet.'
            : `No ${statusLabels[status].toLowerCase()} claims.`
        }
      />
    </>
  );
}
