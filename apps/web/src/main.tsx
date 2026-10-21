import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';

import { App } from './app';
import { ConfigError, loadRuntimeConfig, setRuntimeConfig } from './config';
import './styles.css';

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
    mountPoint.render(
      <main className="content">
        <p role="alert" className="notice notice-error">
          ClaimFlow is not configured correctly:{' '}
          {error instanceof ConfigError
            ? error.message
            : 'invalid config.json.'}
        </p>
      </main>,
    );
  },
);
