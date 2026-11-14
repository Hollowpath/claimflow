import type { ClaimDto, ClaimHistoryEntryDto } from '@claimflow/contracts';
import Alert from '@mui/material/Alert';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';

import { api } from '../api/claimflow';
import { formatDateTime, historyLabels, statusLabels } from '../lib/format';
import { useResource } from '../lib/use-resource';
import { DataTable, RowHeader } from '../ui/data-table';
import { Section } from '../ui/section';
import { ErrorNotice, Loading } from './ui';

/**
 * The claim's immutable audit trail, oldest first. It reloads whenever the
 * claim's version changes, so an action taken on the page appears at once.
 */
export function useClaimHistory(claimId: string, version: number) {
  return useResource(
    async (signal) => {
      const entries: ClaimHistoryEntryDto[] = [];
      let cursor: string | undefined;
      do {
        const page = await api.getHistory(claimId, cursor, signal);
        entries.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return entries;
    },
    [claimId, version],
  );
}

export type ClaimHistory = ReturnType<typeof useClaimHistory>;

/** The history as a table: each row is one accepted change. */
export function HistoryCard({ history }: { readonly history: ClaimHistory }) {
  return (
    <Section id="history" title="History">
      {history.state === 'loading' && <Loading label="Loading history…" />}
      {history.state === 'error' && (
        <ErrorNotice error={history.error} onReload={history.reload} />
      )}
      {history.state === 'ready' &&
        (history.data.length === 0 ? (
          <Typography sx={{ color: 'text.secondary' }}>
            No history has been recorded yet.
          </Typography>
        ) : (
          <DataTable label="Claim history">
            <TableHead>
              <TableRow>
                <TableCell>When</TableCell>
                <TableCell>Who</TableCell>
                <TableCell>Action</TableCell>
                <TableCell>Status change</TableCell>
                <TableCell>Comment</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {history.data.map((entry) => (
                <TableRow key={entry.version}>
                  <RowHeader>{formatDateTime(entry.occurredAt)}</RowHeader>
                  <TableCell>{entry.actor.displayName}</TableCell>
                  <TableCell>{historyLabels[entry.action]}</TableCell>
                  <TableCell>
                    {entry.fromStatus !== undefined &&
                    entry.fromStatus !== entry.toStatus
                      ? `${statusLabels[entry.fromStatus]} → ${statusLabels[entry.toStatus]}`
                      : '—'}
                  </TableCell>
                  <TableCell sx={{ minWidth: 200, whiteSpace: 'pre-wrap' }}>
                    {entry.comment ?? '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
        ))}
    </Section>
  );
}

/**
 * Why a rejected claim was rejected, taken from the latest rejection in its
 * history. A polite status message, not an alert: it is context, not an error
 * of the page.
 */
export function RejectionNotice({
  claim,
  history,
}: {
  readonly claim: Pick<ClaimDto, 'status'>;
  readonly history: ClaimHistory;
}) {
  if (claim.status !== 'REJECTED' || history.state !== 'ready') {
    return null;
  }
  const rejection = [...history.data]
    .reverse()
    .find((entry) => entry.action === 'REJECT');
  if (rejection === undefined) {
    return null;
  }
  return (
    <Alert severity="error" variant="outlined" role="status">
      <strong>Rejected by {rejection.actor.displayName}</strong>
      {rejection.comment === undefined ? null : `: ${rejection.comment}`}
    </Alert>
  );
}
