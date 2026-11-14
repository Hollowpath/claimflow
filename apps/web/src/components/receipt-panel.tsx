import {
  maxReceiptSizeBytes,
  receiptContentTypes,
  type ClaimDto,
} from '@claimflow/contracts';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import MuiLink from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useState } from 'react';

import type { ApiError } from '../api/client';
import { api } from '../api/claimflow';
import { formatDateTime, formatFileSize } from '../lib/format';
import { toApiError } from '../lib/use-resource';
import { useSession } from '../session';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { FileButton } from '../ui/fields';
import { Section } from '../ui/section';
import { ErrorNotice } from './ui';

/**
 * View the receipt; the owner of a draft can also upload, replace, remove. In
 * Cognito mode the receipt is opened through the authenticated API, never a
 * plain link, because the protected endpoint needs the access token.
 */
export function ReceiptPanel({
  claim,
  onChange,
  onReload,
}: {
  readonly claim: ClaimDto;
  readonly onChange: (claim: ClaimDto) => void;
  readonly onReload: () => void;
}) {
  const { authMode } = useSession();
  const [busy, setBusy] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [removeError, setRemoveError] = useState<ApiError | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const { receipt } = claim;
  const editable = claim.permissions.canEdit;

  async function openReceipt() {
    setBusy(true);
    setError(null);
    try {
      await api.openReceipt(claim.claimId);
    } catch (caught) {
      setError(toApiError(caught));
    } finally {
      setBusy(false);
    }
  }

  function chooseFile(file: File) {
    setLocalError(null);
    setStatus(null);
    if (!(receiptContentTypes as readonly string[]).includes(file.type)) {
      setLocalError('Choose a PDF, JPEG, or PNG file.');
      return;
    }
    if (file.size === 0 || file.size > maxReceiptSizeBytes) {
      setLocalError('Receipts must be between 1 byte and 10 MB.');
      return;
    }
    void attach(file);
  }

  async function attach(file: File) {
    const replacing = receipt !== undefined;
    setBusy(true);
    setError(null);
    try {
      onChange(await api.attachReceiptFile(claim.claimId, claim.version, file));
      setStatus(replacing ? 'Receipt replaced.' : 'Receipt attached.');
    } catch (caught) {
      setError(toApiError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setRemoveError(null);
    try {
      onChange(await api.removeReceipt(claim.claimId, claim.version));
      setConfirmingRemove(false);
      setStatus('Receipt removed.');
    } catch (caught) {
      setRemoveError(toApiError(caught));
    } finally {
      setBusy(false);
    }
  }

  function cancelRemove() {
    setConfirmingRemove(false);
    setRemoveError(null);
  }

  return (
    <Section id="receipt" title="Receipt">
      {receipt === undefined ? (
        <Typography sx={{ color: 'text.secondary' }}>
          No receipt attached.
        </Typography>
      ) : (
        <Stack spacing={0.5} sx={{ mb: editable ? 2 : 0 }}>
          {authMode === 'cognito' ? (
            <MuiLink
              component="button"
              type="button"
              disabled={busy}
              onClick={() => void openReceipt()}
              sx={{ alignSelf: 'flex-start', textAlign: 'left' }}
            >
              {receipt.fileName}
            </MuiLink>
          ) : (
            <MuiLink
              href={api.receiptUrl(claim.claimId)}
              target="_blank"
              rel="noopener noreferrer"
              sx={{ alignSelf: 'flex-start', overflowWrap: 'anywhere' }}
            >
              {receipt.fileName}
            </MuiLink>
          )}
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {formatFileSize(receipt.sizeBytes)} · added{' '}
            {formatDateTime(receipt.attachedAt)}
          </Typography>
        </Stack>
      )}

      {editable && (
        <Stack spacing={1.5} sx={{ mt: receipt === undefined ? 2 : 0 }}>
          <Stack
            direction="row"
            spacing={1}
            useFlexGap
            sx={{ flexWrap: 'wrap', alignItems: 'center' }}
          >
            <FileButton
              label={
                receipt === undefined ? 'Upload receipt' : 'Replace receipt'
              }
              accept={receiptContentTypes.join(',')}
              disabled={busy}
              onFile={chooseFile}
            />
            {receipt !== undefined && (
              <Button
                color="error"
                disabled={busy}
                onClick={() => setConfirmingRemove(true)}
              >
                Remove
              </Button>
            )}
          </Stack>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            PDF, JPEG, or PNG up to 10 MB.
          </Typography>
        </Stack>
      )}

      {busy && !confirmingRemove && (
        <Typography role="status" sx={{ mt: 1.5 }}>
          Working…
        </Typography>
      )}
      {status !== null && !busy && (
        <Typography role="status" sx={{ mt: 1.5 }}>
          {status}
        </Typography>
      )}
      {localError !== null && (
        <Alert severity="error" sx={{ mt: 1.5 }}>
          {localError}
        </Alert>
      )}
      {error !== null && (
        <Stack sx={{ mt: 1.5 }}>
          <ErrorNotice error={error} onReload={onReload} />
        </Stack>
      )}

      {receipt !== undefined && (
        <ConfirmDialog
          open={confirmingRemove}
          title="Remove this receipt?"
          description={`${receipt.fileName} will be removed from this draft. You can attach another receipt afterwards.`}
          confirmLabel="Remove receipt"
          busyLabel="Removing…"
          destructive
          busy={busy}
          error={removeError}
          onReload={() => {
            cancelRemove();
            onReload();
          }}
          onConfirm={() => void remove()}
          onCancel={cancelRemove}
        />
      )}
    </Section>
  );
}
