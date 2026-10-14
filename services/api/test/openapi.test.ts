import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { createRoutes } from '../src/http/routes.js';
import { SessionCookies } from '../src/http/session-cookie.js';
import { temporaryDirectory, testApplication } from './support.js';

/** Reads `path -> methods` from the `paths:` section of the OpenAPI file. */
function documentedOperations(yaml: string): string[] {
  const operations: string[] = [];
  let inPaths = false;
  let currentPath = '';
  for (const line of yaml.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inPaths = line.startsWith('paths:');
      continue;
    }
    if (!inPaths) {
      continue;
    }
    const path = /^ {2}(\/\S*):\s*$/.exec(line);
    if (path) {
      currentPath = path[1]!;
      continue;
    }
    const method = /^ {4}(get|post|put|patch|delete):/.exec(line);
    if (method) {
      operations.push(`${method[1]!.toUpperCase()} ${currentPath}`);
    }
  }
  return operations.sort();
}

describe('OpenAPI specification', () => {
  it('documents exactly the implemented routes', async () => {
    const dir = await temporaryDirectory();
    try {
      const app = await testApplication(dir.path);
      const implemented = createRoutes(app, new SessionCookies('x'))
        .map(
          (route) => `${route.method} ${route.path.replace(/:(\w+)/g, '{$1}')}`,
        )
        .sort();
      const yaml = await readFile(
        new URL('../../../docs/openapi.yaml', import.meta.url),
        'utf8',
      );
      expect(documentedOperations(yaml)).toEqual(implemented);
    } finally {
      await dir.remove();
    }
  });
});
