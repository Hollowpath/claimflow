import type { ClaimDto, Page } from '@claimflow/contracts';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import { useState, type ReactNode } from 'react';
import { Link as RouterLink } from 'react-router';

import type { ApiError } from '../api/client';
import {
  formatAge,
  formatDate,
  formatDateTime,
  nextStepText,
} from '../lib/format';
import { formatMoney } from '../lib/money';
import {
  toApiError,
  useResource,
  type ResourceDeps,
} from '../lib/use-resource';
import { DataTable, RowHeader } from '../ui/data-table';
import { StatusChip } from '../ui/status-chip';
import { EmptyState, ErrorNotice, Loading } from './ui';

/**
 * Which list this is. Each shows the columns its reader needs: employees
 * track what happens next, managers see who sent what and how long ago, and
 * administrators see who is reviewing.
 */
export type ClaimListVariant = 'mine' | 'review' | 'admin';

const tableLabels: Record<ClaimListVariant, string> = {
  mine: 'My claims',
  review: 'Review queue',
  admin: 'All claims',
};

const headings: Record<ClaimListVariant, readonly string[]> = {
  mine: [
    'Merchant',
    'Category',
    'Expense date',
    'Amount',
    'Status',
    'Next step',
  ],
  review: [
    'Merchant',
    'Employee',
    'Category',
    'Amount',
    'Submitted',
    'Receipt',
    'Status',
  ],
  admin: [
    'Merchant',
    'Employee',
    'Category',
    'Expense date',
    'Amount',
    'Reviewer',
    'Status',
  ],
};

const amountColumns: ReadonlySet<string> = new Set(['Amount']);
const none = '—';

function Cell({
  claim,
  column,
}: {
  readonly claim: ClaimDto;
  readonly column: string;
}): ReactNode {
  switch (column) {
    case 'Merchant':
      return (
        <RowHeader>
          {/* Padding with an equal negative margin enlarges the touch target
              without making the row taller. */}
          <Link
            component={RouterLink}
            to={`/claims/${claim.claimId}`}
            sx={{ display: 'inline-block', py: 1, my: -1 }}
          >
            {claim.merchant ?? 'Untitled claim'}
          </Link>
        </RowHeader>
      );
    case 'Employee':
      return <TableCell>{claim.employee.displayName}</TableCell>;
    case 'Category':
      return <TableCell>{claim.categoryName ?? none}</TableCell>;
    case 'Expense date':
      return (
        <TableCell sx={{ whiteSpace: 'nowrap' }}>
          {claim.expenseDate === undefined
            ? none
            : formatDate(claim.expenseDate)}
        </TableCell>
      );
    case 'Amount':
      return (
        <TableCell
          align="right"
          sx={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}
        >
          {claim.amount === undefined
            ? none
            : formatMoney(claim.amount.amountMinor, claim.amount.currency)}
        </TableCell>
      );
    case 'Submitted':
      return (
        <TableCell sx={{ whiteSpace: 'nowrap' }}>
          {claim.submittedAt === undefined ? (
            none
          ) : (
            <>
              {formatDateTime(claim.submittedAt)}
              <Typography
                variant="caption"
                sx={{ display: 'block', color: 'text.secondary' }}
              >
                {formatAge(claim.submittedAt)}
              </Typography>
            </>
          )}
        </TableCell>
      );
    case 'Receipt':
      return (
        <TableCell>
          {claim.receipt === undefined ? 'None' : 'Attached'}
        </TableCell>
      );
    case 'Reviewer':
      return (
        <TableCell>{claim.assignedManager?.displayName ?? none}</TableCell>
      );
    case 'Status':
      return (
        <TableCell>
          <StatusChip status={claim.status} />
        </TableCell>
      );
    case 'Next step':
      return <TableCell>{nextStepText(claim)}</TableCell>;
    default:
      return null;
  }
}

/**
 * A paginated claim list. `load` fetches one page; "Show more" appends the
 * next page using the server's opaque cursor.
 */
export function ClaimList({
  load,
  deps = [],
  variant,
  emptyTitle,
  emptyHint,
}: {
  readonly load: (
    cursor: string | undefined,
    signal?: AbortSignal,
  ) => Promise<Page<ClaimDto>>;
  readonly deps?: ResourceDeps;
  readonly variant: ClaimListVariant;
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

  const columns = headings[variant];
  return (
    <>
      <DataTable label={tableLabels[variant]}>
        <TableHead>
          <TableRow>
            {columns.map((column) => (
              <TableCell
                key={column}
                {...(amountColumns.has(column)
                  ? { align: 'right' as const }
                  : {})}
              >
                {column}
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {claims.map((claim) => (
            <TableRow key={claim.claimId} hover>
              {columns.map((column) => (
                <Cell key={column} claim={claim} column={column} />
              ))}
            </TableRow>
          ))}
        </TableBody>
      </DataTable>
      {moreError !== null && (
        <Box sx={{ mt: 2 }}>
          <ErrorNotice error={moreError} />
        </Box>
      )}
      {cursor !== undefined && (
        <Box sx={{ mt: 2 }}>
          <Button
            variant="outlined"
            disabled={loadingMore}
            onClick={() => void showMore()}
          >
            {loadingMore ? 'Loading…' : 'Show more'}
          </Button>
        </Box>
      )}
    </>
  );
}
