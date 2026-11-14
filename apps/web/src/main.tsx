import Alert from '@mui/material/Alert';
import Container from '@mui/material/Container';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';

import { App } from './app';
import { ConfigError, loadRuntimeConfig, setRuntimeConfig } from './config';
import { theme } from './ui/theme';

const root = document.getElementById('root');
if (root === null) {
  throw new Error('Missing #root element.');
}
const mountPoint = createRoot(root);

loadRuntimeConfig().then(
  (config) => {
    setRuntimeConfig(config);
    mountPoint.render(
      <StrictMode>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </StrictMode>,
    );
  },
  (error: unknown) => {
    // Outside the router and the app providers: only the theme is needed.
    mountPoint.render(
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <Container component="main" maxWidth="lg" sx={{ py: 3 }}>
          <Alert severity="error">
            ClaimFlow is not configured correctly:{' '}
            {error instanceof ConfigError
              ? error.message
              : 'invalid config.json.'}
          </Alert>
        </Container>
      </ThemeProvider>,
    );
  },
);
