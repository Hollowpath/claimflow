import { join } from 'node:path';

import { LocalReceiptStorage } from './adapters/local/local-receipt-storage.js';
import {
  LocalCategoryRepository,
  LocalClaimRepository,
  LocalIdempotencyStore,
} from './adapters/local/local-repositories.js';
import { JsonDatabase } from './adapters/local/json-database.js';
import { seedState, seedUsers } from './adapters/local/seed.js';
import {
  JsonLogger,
  StaticUserDirectory,
  systemClock,
  uuidGenerator,
} from './adapters/local/system.js';
import { CategoryService } from './application/category-service.js';
import { ClaimService } from './application/claim-service.js';
import { Idempotency } from './application/idempotency.js';
import type { Clock, IdGenerator, Logger } from './application/ports.js';
import { ReceiptService } from './application/receipt-service.js';
import { SessionService } from './application/session-service.js';

export interface Application {
  readonly claims: ClaimService;
  readonly receipts: ReceiptService;
  readonly categories: CategoryService;
  readonly sessions: SessionService;
  readonly idempotency: Idempotency;
  readonly logger: Logger;
}

export interface LocalApplicationOptions {
  readonly dataDirectory: string;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly logger?: Logger;
}

export function localDataPaths(dataDirectory: string) {
  return {
    database: join(dataDirectory, 'claimflow.json'),
    receipts: join(dataDirectory, 'receipts'),
    sessionSecret: join(dataDirectory, 'session-secret'),
  };
}

/** Wires the application services to the local JSON and file adapters. */
export async function createLocalApplication({
  dataDirectory,
  clock = systemClock,
  ids = uuidGenerator,
  logger = new JsonLogger(),
}: LocalApplicationOptions): Promise<Application> {
  const paths = localDataPaths(dataDirectory);
  const db = await JsonDatabase.open(paths.database, seedState);

  const claims = new LocalClaimRepository(db);
  const categories = new LocalCategoryRepository(db);
  const users = new StaticUserDirectory(seedUsers);
  const receipts = new LocalReceiptStorage(paths.receipts);

  return {
    claims: new ClaimService({
      claims,
      categories,
      users,
      receipts,
      clock,
      ids,
      logger,
    }),
    receipts: new ReceiptService({
      claims,
      categories,
      users,
      receipts,
      clock,
      ids,
      logger,
    }),
    categories: new CategoryService({ categories, claims, clock, ids }),
    sessions: new SessionService(users),
    idempotency: new Idempotency(new LocalIdempotencyStore(db, clock), clock),
    logger,
  };
}
