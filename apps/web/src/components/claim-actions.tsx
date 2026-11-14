import {
  decisionCommentMaxLength,
  type ClaimAction,
  type ClaimDto,
} from '@claimflow/contracts';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useEffect, useId, useState } from 'react';

import type { ApiError } from '../api/client';
import { api } from '../api/claimflow';
import { actionLabels } from '../lib/format';
import { toApiError } from '../lib/use-resource';
import { Field } from '../ui/fields';
import { Section } from '../ui/section';
import { useToast } from '../ui/toast';
import { ErrorNotice } from './ui';

const decisions: readonly ClaimAction[] = ['APPROVE', 'REJECT'];

/** What to tell the user once the server has accepted the action. */
const completed: Record<ClaimAction, string> = {
  SUBMIT: 'Claim submitted for approval.',
  START_REVIEW: 'Review started.',
  APPROVE: 'Claim approved.',
  REJECT: 'Claim rejected.',
  REOPEN: 'Claim reopened for editing.',
  MARK_PAID: 'Claim marked as paid.',
};

const commentFieldId = 'decision-comment';

/**
 * Lifecycle buttons for the actions the server says this user may take.
 * Approve and reject need a comment, checked here and again by the API. The
 * section is titled for what the reader is doing: a decision, or a next step.
 */
export function ClaimActions({
  claim,
  onChange,
  onReload,
  submitBlockedReason,
}: {
  readonly claim: ClaimDto;
  readonly onChange: (claim: ClaimDto) => void;
  readonly onReload: () => void;
  /** While set, submitting is disabled and this explains why. */
  readonly submitBlockedReason?: string | undefined;
}) {
  const { notify } = useToast();
  const reasonId = useId();
  const [comment, setComment] = useState('');
  const [commentError, setCommentError] = useState<string | null>(null);
  const [focusComment, setFocusComment] = useState<{ n: number } | null>(null);
  const [busy, setBusy] = useState<ClaimAction | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const { actions } = claim.permissions;
  const needsComment = actions.some((a) => decisions.includes(a));

  // A missing comment moves focus to the field that needs it.
  useEffect(() => {
    if (focusComment !== null) {
      document.getElementById(commentFieldId)?.focus();
    }
  }, [focusComment]);

  if (actions.length === 0) {
    return null;
  }

  async function perform(action: ClaimAction) {
    setError(null);
    const isDecision = decisions.includes(action);
    if (isDecision && comment.trim() === '') {
      setCommentError('Add a comment explaining your decision.');
      setFocusComment({ n: (focusComment?.n ?? 0) + 1 });
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
      notify(completed[action]);
      // The button that was just used is gone (or replaced) now; without this
      // keyboard focus would fall back to the top of the document.
      const title = document.querySelector<HTMLElement>('main h1');
      if (title !== null) {
        title.tabIndex = -1;
        title.focus({ preventScroll: true });
      }
    } catch (caught) {
      setError(toApiError(caught));
    } finally {
      setBusy(null);
    }
  }

  const showReason =
    submitBlockedReason !== undefined && actions.includes('SUBMIT');

  return (
    <Section id="actions" title={needsComment ? 'Decision' : 'Next step'}>
      <Stack spacing={2}>
        {needsComment && (
          <Field
            id={commentFieldId}
            label="Decision comment (required)"
            multiline
            rows={3}
            maxLength={decisionCommentMaxLength}
            value={comment}
            onChange={setComment}
            messages={commentError === null ? [] : [commentError]}
            hint="Your comment is added to the claim's history."
          />
        )}
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1}
          useFlexGap
          sx={{ flexWrap: 'wrap' }}
        >
          {actions.map((action) => {
            const blocked = action === 'SUBMIT' && showReason;
            return (
              <Button
                key={action}
                variant={action === 'REJECT' ? 'outlined' : 'contained'}
                color={action === 'REJECT' ? 'error' : 'primary'}
                disabled={busy !== null || blocked}
                {...(blocked ? { 'aria-describedby': reasonId } : {})}
                onClick={() => void perform(action)}
                sx={{ width: { xs: '100%', sm: 'auto' } }}
              >
                {busy === action ? 'Working…' : actionLabels[action]}
              </Button>
            );
          })}
        </Stack>
        {showReason && (
          <Typography
            id={reasonId}
            variant="body2"
            sx={{ color: 'text.secondary' }}
          >
            {submitBlockedReason}
          </Typography>
        )}
        {error !== null && <ErrorNotice error={error} onReload={onReload} />}
      </Stack>
    </Section>
  );
}
