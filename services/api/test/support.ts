import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Actor } from '@claimflow/domain';

import { silentLogger } from '../src/adapters/local/system.js';
import type { Clock } from '../src/application/ports.js';
import { createLocalApplication } from '../src/composition.js';

export const pdfBytes = new Uint8Array([
  ...new TextEncoder().encode('%PDF-1.7\n'),
  ...new TextEncoder().encode('fictional receipt\n%%EOF'),
]);

export const pngBytes = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);

/** A clock that advances one second per reading, for stable ordering. */
export function steppingClock(start = '2026-10-14T09:00:00.000Z'): Clock {
  let current = Date.parse(start);
  return {
    now: () => {
      const value = new Date(current);
      current += 1000;
      return value;
    },
  };
}

export async function temporaryDirectory(): Promise<{
  path: string;
  remove: () => Promise<void>;
}> {
  const path = await mkdtemp(join(tmpdir(), 'claimflow-test-'));
  return { path, remove: () => rm(path, { recursive: true, force: true }) };
}

export async function testApplication(dataDirectory: string) {
  return createLocalApplication({
    dataDirectory,
    clock: steppingClock(),
    logger: silentLogger,
  });
}

export const actors = {
  aisha: {
    userId: 'u-aisha',
    displayName: 'Aisha Rahman',
    roles: ['EMPLOYEE'],
    managerId: 'u-ben',
  },
  ravi: {
    userId: 'u-ravi',
    displayName: 'Ravi Kumar',
    roles: ['EMPLOYEE'],
    managerId: 'u-ben',
  },
  ben: {
    userId: 'u-ben',
    displayName: 'Ben Tan',
    roles: ['EMPLOYEE', 'MANAGER'],
    managerId: 'u-chloe',
  },
  chloe: { userId: 'u-chloe', displayName: 'Chloe Lim', roles: ['MANAGER'] },
  dan: { userId: 'u-dan', displayName: 'Dan Wong', roles: ['ADMIN'] },
} satisfies Record<string, Actor>;
