import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import { useId, type ReactNode } from 'react';

import type { ApiError } from '../api/client';
import { ErrorAlert } from './feedback';

/**
 * Confirms a consequential action. It is an alert dialog: focus moves into it
 * and stays there, the background is inert, Escape cancels, and focus returns
 * to the control that opened it. Initial focus lands on the safe choice.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  busyLabel = 'Working…',
  cancelLabel = 'Cancel',
  destructive = false,
  busy = false,
  error = null,
  onReload,
  alternative,
  onConfirm,
  onCancel,
  children,
}: {
  readonly open: boolean;
  readonly title: string;
  /** Names the item and the consequence, not just "Are you sure?". */
  readonly description: ReactNode;
  readonly confirmLabel: string;
  readonly busyLabel?: string;
  readonly cancelLabel?: string;
  readonly destructive?: boolean;
  readonly busy?: boolean;
  readonly error?: ApiError | null;
  readonly onReload?: (() => void) | undefined;
  /** A safer way to get what the user probably wants, such as deactivating. */
  readonly alternative?:
    { readonly label: string; readonly onClick: () => void } | undefined;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly children?: ReactNode;
}) {
  const titleId = useId();
  const descriptionId = useId();
  return (
    <Dialog
      open={open}
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onClose={busy ? undefined : onCancel}
      fullWidth
      maxWidth="xs"
    >
      <DialogTitle id={titleId}>{title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <DialogContentText id={descriptionId}>
            {description}
          </DialogContentText>
          {children}
          {error !== null && (
            <ErrorAlert
              error={error}
              showDetails={false}
              {...(onReload === undefined ? {} : { onReload })}
            />
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Button autoFocus onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </Button>
        {alternative !== undefined && (
          <Button
            variant="outlined"
            onClick={alternative.onClick}
            disabled={busy}
          >
            {alternative.label}
          </Button>
        )}
        <Button
          variant="contained"
          color={destructive ? 'error' : 'primary'}
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? busyLabel : confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
