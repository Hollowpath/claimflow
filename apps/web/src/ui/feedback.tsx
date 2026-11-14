import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import type { ReactNode } from 'react';

import type { ApiError } from '../api/client';

/** Lets an alert's action drop below its message on narrow screens. */
const wrappingAlert = {
  flexWrap: 'wrap',
  '& .MuiAlert-message': { flex: '1 1 14rem' },
  '& .MuiAlert-action': { ml: 'auto' },
} as const;

/** A polite status region: a spinner for sighted users, the label for everyone. */
export function Loading({ label = 'Loading…' }: { readonly label?: string }) {
  return (
    <Box
      role="status"
      sx={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        gap: 1.5,
        p: 4,
        color: 'text.secondary',
      }}
    >
      <CircularProgress size={20} aria-hidden="true" />
      <span>{label}</span>
    </Box>
  );
}

/** Why a list is empty and what the user can do about it. */
export function EmptyState({
  title,
  children,
}: {
  readonly title: string;
  readonly children?: ReactNode;
}) {
  return (
    <Box
      sx={{
        textAlign: 'center',
        p: 4,
        border: 1,
        borderStyle: 'dashed',
        borderColor: 'divider',
        borderRadius: 1,
      }}
    >
      <Typography sx={{ fontWeight: 600, mb: children === undefined ? 0 : 1 }}>
        {title}
      </Typography>
      {children}
    </Box>
  );
}

/**
 * A safe API error with its recovery action. A version conflict explains that
 * nothing was overwritten and offers the latest version; every other error
 * shows the server's message, its field details, and the request reference.
 */
export function ErrorAlert({
  error,
  onReload,
  showDetails = true,
}: {
  readonly error: ApiError;
  readonly onReload?: () => void;
  readonly showDetails?: boolean;
}) {
  if (error.isConflict) {
    return (
      <Alert
        severity="warning"
        sx={wrappingAlert}
        action={
          onReload === undefined ? undefined : (
            <Button color="inherit" size="small" onClick={onReload}>
              Load the latest version
            </Button>
          )
        }
      >
        <strong>Someone else changed this first.</strong> Your change was not
        saved so their update is not lost.
      </Alert>
    );
  }
  const details = showDetails ? error.details : [];
  const canRetry = onReload !== undefined && error.code !== 'VALIDATION_FAILED';
  return (
    <Alert
      severity="error"
      sx={wrappingAlert}
      action={
        canRetry ? (
          <Button color="inherit" size="small" onClick={onReload}>
            Try again
          </Button>
        ) : undefined
      }
    >
      <strong>{error.message}</strong>
      {details.length > 0 && (
        <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
          {details.map((detail) => (
            <li key={`${detail.field}:${detail.code}`}>{detail.message}</li>
          ))}
        </Box>
      )}
      {error.requestId !== undefined && (
        <Typography variant="caption" sx={{ display: 'block', opacity: 0.8 }}>
          Reference: {error.requestId}
        </Typography>
      )}
    </Alert>
  );
}
