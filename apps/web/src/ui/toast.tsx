import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useLocation } from 'react-router';

export type ToastSeverity = 'success' | 'info';

interface ToastState {
  readonly message: string;
  readonly severity: ToastSeverity;
  /** The history entry the toast belongs to; a toast never follows navigation. */
  readonly locationKey: string;
}

interface ToastApi {
  /** Shows a short, non-urgent confirmation. Replaces any toast already shown. */
  readonly notify: (message: string, severity?: ToastSeverity) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/**
 * Confirmations for completed actions. The toast is a polite status message,
 * stays until it is dismissed (Escape or its close button) or the user moves
 * to another page, and never takes keyboard focus.
 */
export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const location = useLocation();
  const [toast, setToast] = useState<ToastState | null>(null);

  const notify = useCallback(
    (message: string, severity: ToastSeverity = 'success') =>
      setToast({ message, severity, locationKey: location.key }),
    [location.key],
  );
  const api = useMemo<ToastApi>(() => ({ notify }), [notify]);

  const visible = toast !== null && toast.locationKey === location.key;
  const dismiss = () => setToast(null);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <Snackbar
        open={visible}
        autoHideDuration={null}
        onClose={(_event, reason) => {
          if (reason !== 'clickaway') {
            dismiss();
          }
        }}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      >
        <Alert
          severity={toast?.severity ?? 'success'}
          role="status"
          variant="filled"
          onClose={dismiss}
        >
          {toast?.message}
        </Alert>
      </Snackbar>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (api === null) {
    throw new Error('useToast must be used inside ToastProvider.');
  }
  return api;
}
