import type { ClaimDto } from '@claimflow/contracts';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import { useNavigate } from 'react-router';

import type { ApiError } from '../api/client';
import { api } from '../api/claimflow';
import { toApiError } from '../lib/use-resource';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { Section } from '../ui/section';

/**
 * Lets the owner discard a draft that was never submitted. Deleting cannot be
 * undone, so it asks first, in a dialog that names the draft and what is lost.
 */
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
      // The page goes away with the draft; the dialog stays "Deleting…" until it does.
      void navigate('/claims');
    } catch (caught) {
      setError(toApiError(caught));
      setBusy(false);
    }
  }

  function cancel() {
    setConfirming(false);
    setError(null);
  }

  const name = claim.merchant ?? 'this draft';
  return (
    <Section id="delete" title="Delete draft">
      <Stack spacing={2} sx={{ alignItems: 'flex-start' }}>
        <Typography sx={{ color: 'text.secondary' }}>
          Deleting removes this draft, its receipt, and its history. This cannot
          be undone.
        </Typography>
        <Button
          variant="outlined"
          color="error"
          onClick={() => setConfirming(true)}
        >
          Delete draft
        </Button>
      </Stack>
      <ConfirmDialog
        open={confirming}
        title="Delete this draft?"
        description={`${name} will be deleted together with its receipt and its history. It cannot be undone.`}
        confirmLabel="Delete draft"
        busyLabel="Deleting…"
        destructive
        busy={busy}
        error={error}
        onReload={() => {
          cancel();
          onReload();
        }}
        onConfirm={() => void remove()}
        onCancel={cancel}
      />
    </Section>
  );
}
