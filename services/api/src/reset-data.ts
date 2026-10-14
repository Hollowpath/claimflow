import { rm } from 'node:fs/promises';

import { localDataPaths } from './composition.js';
import { localConfig } from './local-config.js';

/**
 * Deletes local claims, categories, history, and receipts so the next start
 * recreates the seed data. Refuses to run while the API is serving requests.
 */
const { dataDirectory, port } = localConfig;

if (await apiIsRunning()) {
  console.error(
    `The API is running on port ${port}. Stop it (Ctrl+C) and run this again.`,
  );
  process.exit(1);
}

const paths = localDataPaths(dataDirectory);
await rm(paths.database, { force: true });
await rm(paths.receipts, { recursive: true, force: true });
console.log(
  `Local data reset in ${dataDirectory}. Seed data loads on next start.`,
);

async function apiIsRunning(): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
