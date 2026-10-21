import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defaultClientConditions } from 'vite';
import { defineConfig } from 'vitest/config';

import { thirdPartyNotices } from './scripts/notices.ts';

/** The repository's notices; every real build checks them and ships a copy. */
const noticesPath = fileURLToPath(
  new URL('../../THIRD_PARTY_NOTICES.txt', import.meta.url),
);
const apiTarget = process.env.CLAIMFLOW_API_URL ?? 'http://127.0.0.1:3001';

export default defineConfig({
  plugins: [react(), thirdPartyNotices(noticesPath)],
  resolve: { conditions: ['source', ...defaultClientConditions] },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: apiTarget } },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    coverage: { include: ['src/**/*.{ts,tsx}'], exclude: ['src/main.tsx'] },
  },
});
