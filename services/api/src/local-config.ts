import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root, from either `src/` (tsx) or `dist/` (built). */
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

export const localConfig = {
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 3001),
  dataDirectory: resolve(
    process.env.CLAIMFLOW_DATA_DIR ?? resolve(repositoryRoot, '.local'),
  ),
  webRoot: resolve(repositoryRoot, 'apps/web/dist'),
};
