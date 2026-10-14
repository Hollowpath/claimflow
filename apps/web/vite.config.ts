import react from '@vitejs/plugin-react';
import { defaultClientConditions } from 'vite';
import { defineConfig } from 'vitest/config';

const apiTarget = process.env.CLAIMFLOW_API_URL ?? 'http://127.0.0.1:3001';

export default defineConfig({
  plugins: [react()],
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
