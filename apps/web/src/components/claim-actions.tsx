import {
  decisionCommentMaxLength,
  type ClaimAction,
  type ClaimDto,
} from '@claimflow/contracts';
import { useState } from 'react';

import type { ApiError } from '../api/client';
import { api } from '../api/claimflow';
import { actionLabels } from '../lib/format';
import { toApiError } from '../lib/use-resource';
import { ErrorNotice } from './ui';

const decisions: readonly ClaimAction[] = ['APPROVE', 'REJECT'];

/**
 * Lifecycle buttons for the actions the server says this user may take.
 * Approve and reject need a comment, checked here and again by the API.
 */
export function ClaimActions({
  claim,
  onChange,
  onReload,
}: {
  readonly claim: ClaimDto;
  readonly onChange: (claim: ClaimDto) => void;
  readonly onReload: () => void;
}) {
  const [comment, setComment] = useState('');
  const [commentError, setCommentError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ClaimAction | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const { actions } = claim.permissions;
  const needsComment = actions.some((a) => decisions.includes(a));

  if (actions.length === 0) {
    return null;
  }

  async function perform(action: ClaimAction) {
    setError(null);
    const isDecision = decisions.includes(action);
    if (isDecision && comment.trim() === '') {
      setCommentError('Add a comment explaining your decision.');
      return;
    }
    setCommentError(null);
    setBusy(action);
    try {
      onChange(
        await api.performAction(
          claim.claimId,
          action,
          claim.version,
          isDecision ? comment : undefined,
        ),
      );
      setComment('');
    } catch (caught) {
      setError(toApiError(caught));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="panel" aria-labelledby="actions-heading">
      <h2 id="actions-heading">Next step</h2>
      {needsComment && (
        <div className="field">
          <label htmlFor="decision-comment">Decision comment (required)</label>
          <textarea
            id="decision-comment"
            rows={3}
            maxLength={decisionCommentMaxLength}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            aria-invalid={commentError !== null}
            {...(commentError === null
              ? {}
              : { 'aria-describedby': 'decision-comment-error' })}
          />
          {commentError !== null && (
            <p className="field-error" id="decision-comment-error">
              {commentError}
            </p>
          )}
        </div>
      )}
      <div className="form-actions">
        {actions.map((action) => (
          <button
            key={action}
            type="button"
            className={action === 'REJECT' ? 'button button-danger' : 'button'}
            disabled={busy !== null}
            onClick={() => void perform(action)}
          >
            {busy === action ? 'Working…' : actionLabels[action]}
          </button>
        ))}
      </div>
      {error !== null && <ErrorNotice error={error} onReload={onReload} />}
    </section>
  );
}
