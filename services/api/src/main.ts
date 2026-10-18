import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isMissingFile } from './adapters/local/json-database.js';
import { createLocalApplication, localDataPaths } from './composition.js';
import { createLocalApiHandler } from './http/local-api.js';
import { createHttpServer } from './http/server.js';
import { SessionCookies } from './http/session-cookie.js';
import { localConfig } from './local-config.js';

const abandonedUploadAgeMs = 24 * 60 * 60 * 1000;

const { host, port, dataDirectory, webRoot } = localConfig;
const serveWeb =
  process.argv.includes('--serve-web') &&
  existsSync(join(webRoot, 'index.html'));

const app = await createLocalApplication({ dataDirectory });
const purged = await app.receipts.purgeAbandonedUploads(abandonedUploadAgeMs);
const cookies = new SessionCookies(await loadSessionSecret());

const server = createHttpServer(
  createLocalApiHandler(app, cookies),
  serveWeb ? { webRoot } : {},
);

server.listen(port, host, () => {
  app.logger.info('server.started', {
    url: `http://localhost:${port}`,
    api: `http://localhost:${port}/api/v1`,
    servesWeb: serveWeb,
    dataDirectory,
    purgedUploads: purged,
  });
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
}

/** A per-installation secret so session cookies survive restarts. */
async function loadSessionSecret(): Promise<string> {
  const { sessionSecret } = localDataPaths(dataDirectory);
  try {
    return (await readFile(sessionSecret, 'utf8')).trim();
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
    const secret = randomBytes(32).toString('hex');
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(sessionSecret, secret, { mode: 0o600 });
    return secret;
  }
}
