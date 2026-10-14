import { defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  ssr: { resolve: { conditions: ['source', ...defaultServerConditions] } },
  test: {
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts', 'src/reset-data.ts', 'src/local-config.ts'],
    },
  },
});
