import { defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  ssr: {
    resolve: {
      // Resolve packages as Node does at runtime. Node ignores the bundler-only
      // `module` condition, which points the AWS SDK's dependencies at
      // builds that Node cannot load.
      conditions: [
        'source',
        ...defaultServerConditions.filter((c) => c !== 'module'),
      ],
    },
  },
  test: {
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts', 'src/reset-data.ts', 'src/local-config.ts'],
    },
  },
});
