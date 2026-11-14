import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import type { ReactNode } from 'react';

import { theme } from './theme';
import { ToastProvider } from './toast';

/**
 * The theme with Material UI's baseline (page background, text colour,
 * typography and box sizing), light and dark colour schemes that follow the
 * operating system, and toasts. Render inside the router: toasts are cleared
 * when the location changes.
 */
export function AppProviders({ children }: { readonly children: ReactNode }) {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <ToastProvider>{children}</ToastProvider>
    </ThemeProvider>
  );
}
