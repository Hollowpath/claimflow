import {
  maxReceiptSizeBytes,
  receiptContentTypes,
  type ClaimDto,
} from '@claimflow/contracts';
import { useRef, useState, type ChangeEvent } from 'react';

import type { ApiError } from '../api/client';
import { api } from '../api/claimflow';
import { formatDateTime, formatFileSize } from '../lib/format';
import { toApiError } from '../lib/use-resource';
import { useSession } from '../session';
import { ErrorNotice } from './ui';

/** View the receipt; the owner of a draft can also upload, replace, remove. */
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
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
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

  async function run(action: () => Promise<ClaimDto>) {
    setBusy(true);
    setError(null);
    try {
      onChange(await action());
    } catch (caught) {
      setError(toApiError(caught));
    } finally {
      setBusy(false);
      setConfirmingRemove(false);
    }
  }

  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    setLocalError(null);
    if (file === undefined) {
      return;
    }
    if (!(receiptContentTypes as readonly string[]).includes(file.type)) {
      setLocalError('Choose a PDF, JPEG, or PNG file.');
      return;
    }
    if (file.size === 0 || file.size > maxReceiptSizeBytes) {
      setLocalError('Receipts must be between 1 byte and 10 MB.');
      return;
    }
    void run(() => api.attachReceiptFile(claim.claimId, claim.version, file));
  }

  return (
    <section className="panel" aria-labelledby="receipt-heading">
      <h2 id="receipt-heading">Receipt</h2>
      {receipt === undefined ? (
        <p className="muted">No receipt attached.</p>
      ) : (
        <div className="receipt">
          {authMode === 'cognito' ? (
            <button
              type="button"
              className="link-button"
              disabled={busy}
              onClick={() => void openReceipt()}
            >
              {receipt.fileName}
            </button>
          ) : (
            <a
              href={api.receiptUrl(claim.claimId)}
              target="_blank"
              rel="noopener noreferrer"
            >
              {receipt.fileName}
            </a>
          )}
          <span className="muted">
            {formatFileSize(receipt.sizeBytes)} · added{' '}
            {formatDateTime(receipt.attachedAt)}
          </span>
        </div>
      )}

      {editable && (
        <div className="receipt-actions">
          <input
            ref={input}
            type="file"
            accept={receiptContentTypes.join(',')}
            className="visually-hidden"
            id="receipt-file"
            aria-label={
              receipt === undefined ? 'Upload receipt' : 'Replace receipt'
            }
            onChange={chooseFile}
            disabled={busy}
          />
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            {busy
              ? 'Working…'
              : receipt === undefined
                ? 'Upload receipt'
                : 'Replace receipt'}
          </button>
          {receipt !== undefined &&
            (confirmingRemove ? (
              <>
                <button
                  type="button"
                  className="button button-danger"
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      api.removeReceipt(claim.claimId, claim.version),
                    )
                  }
                >
                  Confirm remove
                </button>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => setConfirmingRemove(false)}
                >
                  Keep it
                </button>
              </>
            ) : (
              <button
                type="button"
                className="link-button"
                disabled={busy}
                onClick={() => setConfirmingRemove(true)}
              >
                Remove
              </button>
            ))}
          <p className="hint">PDF, JPEG, or PNG up to 10 MB.</p>
        </div>
      )}
      {localError !== null && (
        <p className="field-error" role="alert">
          {localError}
        </p>
      )}
      {error !== null && <ErrorNotice error={error} onReload={onReload} />}
    </section>
  );
}
