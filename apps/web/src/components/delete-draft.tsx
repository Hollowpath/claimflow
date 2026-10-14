import type { ClaimDto } from '@claimflow/contracts';
import { useState } from 'react';
import { useNavigate } from 'react-router';

import type { ApiError } from '../api/client';
import { api } from '../api/claimflow';
import { toApiError } from '../lib/use-resource';
import { ErrorNotice } from './ui';

/** Lets the owner discard a draft that was never submitted. */
export function DeleteDraft({
  claim,
  onReload,
}: {
  readonly claim: ClaimDto;
  readonly onReload: () => void;
}) {
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  if (!claim.permissions.canDelete) {
    return null;
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api.deleteClaim(claim.claimId, claim.version);
      void navigate('/claims');
    } catch (caught) {
      setError(toApiError(caught));
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="delete-heading">
      <h2 id="delete-heading">Delete draft</h2>
      <p className="hint">
        Deleting removes this draft, its receipt, and its history. This cannot
        be undone.
      </p>
      <div className="form-actions">
        {confirming ? (
          <>
            <button
              type="button"
              className="button button-danger"
              disabled={busy}
              onClick={() => void remove()}
            >
              {busy ? 'Deleting…' : 'Confirm delete'}
            </button>
            <button
              type="button"
              className="link-button"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Keep it
            </button>
          </>
        ) : (
          <button
            type="button"
            className="button button-secondary"
            onClick={() => setConfirming(true)}
          >
            Delete draft
          </button>
        )}
      </div>
      {error !== null && <ErrorNotice error={error} onReload={onReload} />}
    </section>
  );
}
