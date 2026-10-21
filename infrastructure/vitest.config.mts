import { defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  ssr: {
    resolve: {
      // The tests import the API's route table, which imports the workspaces'
      // sources through their `source` export condition (no prebuilt `dist`).
      // Node ignores the bundler-only `module` condition, so leave it out, as
      // the API workspace does.
      conditions: [
        'source',
        ...defaultServerConditions.filter((c) => c !== 'module'),
      ],
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    // Synthesizing the stack bundles each Lambda function with esbuild.
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
});
