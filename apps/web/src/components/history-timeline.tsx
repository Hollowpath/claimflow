import type { ClaimHistoryEntryDto } from '@claimflow/contracts';

import { api } from '../api/claimflow';
import { formatDateTime, historyLabels, statusLabels } from '../lib/format';
import { useResource } from '../lib/use-resource';
import { ErrorNotice, Loading } from './ui';

/** The claim's immutable audit trail, oldest first. */
export function HistoryTimeline({
  claimId,
  version,
}: {
  readonly claimId: string;
  /** Reloads the history whenever the claim changes. */
  readonly version: number;
}) {
  const history = useResource(
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

  return (
    <section className="panel" aria-labelledby="history-heading">
      <h2 id="history-heading">History</h2>
      {history.state === 'loading' && <Loading label="Loading history…" />}
      {history.state === 'error' && (
        <ErrorNotice error={history.error} onReload={history.reload} />
      )}
      {history.state === 'ready' && (
        <ol className="timeline">
          {history.data.map((entry) => (
            <li key={entry.version}>
              <div className="timeline-head">
                <strong>{historyLabels[entry.action]}</strong>
                <span className="muted"> by {entry.actor.displayName}</span>
              </div>
              <div className="muted timeline-meta">
                {formatDateTime(entry.occurredAt)}
                {entry.fromStatus !== undefined &&
                  entry.fromStatus !== entry.toStatus &&
                  ` · ${statusLabels[entry.fromStatus]} → ${statusLabels[entry.toStatus]}`}
              </div>
              {entry.comment !== undefined && (
                <blockquote className="timeline-comment">
                  {entry.comment}
                </blockquote>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
