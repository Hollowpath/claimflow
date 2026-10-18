import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JsonDatabase } from '../src/adapters/local/json-database.js';
import { LocalReceiptStorage } from '../src/adapters/local/local-receipt-storage.js';
import {
  LocalCategoryRepository,
  LocalClaimRepository,
} from '../src/adapters/local/local-repositories.js';
import { seedState, seedUsers } from '../src/adapters/local/seed.js';
import {
  silentLogger,
  StaticUserDirectory,
  uuidGenerator,
} from '../src/adapters/local/system.js';
import { ClaimService } from '../src/application/claim-service.js';
import type {
  CategoryRepository,
  DevelopmentUserCatalogue,
  UserDirectory,
  UserProfile,
} from '../src/application/ports.js';
import { loadNames } from '../src/application/presenters.js';
import { ReceiptService } from '../src/application/receipt-service.js';
import { SessionService } from '../src/application/session-service.js';
import { localDataPaths } from '../src/composition.js';
import {
  actors,
  pdfBytes,
  steppingClock,
  temporaryDirectory,
} from './support.js';

const { aisha, ravi, ben } = actors;

/**
 * A production-shaped directory: `get` and `getMany` only, with no way to
 * list users. It records each `getMany` call and, like `BatchGetItem`,
 * returns profiles in reverse order.
 */
class RecordingDirectory implements UserDirectory {
  public readonly batches: (readonly string[])[] = [];
  public constructor(private readonly profiles: readonly UserProfile[]) {}

  public get(userId: string): Promise<UserProfile | undefined> {
    return Promise.resolve(this.profiles.find((p) => p.userId === userId));
  }

  public getMany(userIds: readonly string[]): Promise<readonly UserProfile[]> {
    this.batches.push(userIds);
    return Promise.resolve(
      this.profiles.filter((p) => userIds.includes(p.userId)).reverse(),
    );
  }
}

const noCategories: CategoryRepository = {
  list: () => Promise.resolve([]),
  get: () => Promise.resolve(undefined),
  create: () => Promise.reject(new Error('unused')),
  update: () => Promise.reject(new Error('unused')),
  delete: () => Promise.reject(new Error('unused')),
};

describe('StaticUserDirectory', () => {
  const directory = new StaticUserDirectory(seedUsers);

  it('gets one profile by ID', async () => {
    expect((await directory.get('u-ben'))?.displayName).toBe('Ben Tan');
    expect(await directory.get('u-nobody')).toBeUndefined();
  });

  it('gets only the requested profiles, once each, omitting unknown IDs', async () => {
    const profiles = await directory.getMany([
      'u-dan',
      'u-aisha',
      'u-dan',
      'u-nobody',
    ]);

    expect(profiles.map((p) => p.userId).sort()).toEqual(['u-aisha', 'u-dan']);
    expect(await directory.getMany([])).toEqual([]);
  });

  it('lists every sample user as the development catalogue', async () => {
    const catalogue: DevelopmentUserCatalogue = directory;

    expect(await catalogue.list()).toEqual(seedUsers);
  });
});

describe('loadNames', () => {
  it('requests each needed user once and matches names by ID, not order', async () => {
    const directory = new RecordingDirectory(seedUsers);

    const names = await loadNames(directory, noCategories, [
      'u-aisha',
      'u-ben',
      'u-aisha',
      'u-gone',
    ]);

    expect(directory.batches).toEqual([['u-aisha', 'u-ben', 'u-gone']]);
    expect(names.person('u-aisha').displayName).toBe('Aisha Rahman');
    expect(names.person('u-ben').displayName).toBe('Ben Tan');
    expect(names.person('u-gone').displayName).toBe('Unknown user');
  });

  it('does not call getMany when no users are needed', async () => {
    const directory = new RecordingDirectory(seedUsers);

    await loadNames(directory, noCategories, []);

    expect(directory.batches).toEqual([]);
  });
});

describe('services present claims with only the users they show', () => {
  let dir: Awaited<ReturnType<typeof temporaryDirectory>>;
  let directory: RecordingDirectory;
  let claims: ClaimService;
  let receipts: ReceiptService;

  beforeEach(async () => {
    dir = await temporaryDirectory();
    const paths = localDataPaths(dir.path);
    const db = await JsonDatabase.open(paths.database, seedState);
    directory = new RecordingDirectory(seedUsers);
    const deps = {
      claims: new LocalClaimRepository(db),
      categories: new LocalCategoryRepository(db),
      users: directory,
      receipts: new LocalReceiptStorage(paths.receipts),
      clock: steppingClock(),
      ids: uuidGenerator,
      logger: silentLogger,
    };
    claims = new ClaimService(deps);
    receipts = new ReceiptService(deps);
  });

  afterEach(async () => {
    await dir.remove();
  });

  const complete = {
    categoryId: 'travel',
    amount: { amountMinor: 15_000, currency: 'MYR' },
    expenseDate: '2026-10-10',
    merchant: 'City Taxi',
    businessPurpose: 'Client visit',
  };

  /** Aisha's claim, submitted to Ben and approved by him. */
  async function approvedClaim(): Promise<string> {
    const { claimId } = await claims.create(aisha, complete);
    await claims.perform(aisha, claimId, 'SUBMIT', { expectedVersion: 1 });
    await claims.perform(ben, claimId, 'START_REVIEW', { expectedVersion: 2 });
    await claims.perform(ben, claimId, 'APPROVE', {
      expectedVersion: 3,
      comment: 'Approved.',
    });
    return claimId;
  }

  const lastBatch = () => [...(directory.batches.at(-1) ?? [])].sort();

  it('loads only the employee of a draft', async () => {
    const { claimId } = await claims.create(aisha, complete);
    directory.batches.length = 0;

    const claim = await claims.get(aisha, claimId);

    expect(directory.batches).toEqual([['u-aisha']]);
    expect(claim.employee).toEqual({
      userId: 'u-aisha',
      displayName: 'Aisha Rahman',
    });
  });

  it('loads the employee and assigned manager of a claim', async () => {
    const claimId = await approvedClaim();
    directory.batches.length = 0;

    const claim = await claims.get(ben, claimId);

    expect(directory.batches).toHaveLength(1);
    expect(lastBatch()).toEqual(['u-aisha', 'u-ben']);
    expect(claim.assignedManager?.displayName).toBe('Ben Tan');
  });

  it('loads the users of a page once each, in one call', async () => {
    await approvedClaim();
    await claims.create(aisha, complete);
    await claims.create(aisha, complete);
    directory.batches.length = 0;

    const page = await claims.listMine(aisha, { limit: 10 });

    expect(page.items).toHaveLength(3);
    expect(directory.batches).toEqual([
      expect.arrayContaining(['u-aisha', 'u-ben']),
    ]);
    expect(directory.batches[0]).toHaveLength(2);
  });

  it('does not load users for an empty page', async () => {
    const page = await claims.listMine(ravi, { limit: 10 });

    expect(page.items).toEqual([]);
    expect(directory.batches).toEqual([]);
  });

  it('loads only the actors of the history entries shown', async () => {
    const claimId = await approvedClaim();
    directory.batches.length = 0;

    const history = await claims.history(aisha, claimId, { limit: 10 });

    expect(history.items.map((entry) => entry.actor.displayName)).toEqual([
      'Aisha Rahman',
      'Aisha Rahman',
      'Ben Tan',
      'Ben Tan',
    ]);
    expect(directory.batches).toHaveLength(1);
    expect(lastBatch()).toEqual(['u-aisha', 'u-ben']);
  });

  it('loads only the claim users when presenting a receipt change', async () => {
    const { claimId, version } = await claims.create(aisha, complete);
    const upload = await receipts.upload(aisha, {
      fileName: 'taxi.pdf',
      contentType: 'application/pdf',
      content: pdfBytes,
    });
    directory.batches.length = 0;

    await receipts.attach(aisha, claimId, {
      expectedVersion: version,
      receiptId: upload.receiptId,
      contentType: upload.contentType,
      sizeBytes: upload.sizeBytes,
      checksumSha256: upload.checksumSha256,
    });

    expect(directory.batches).toEqual([['u-aisha']]);
  });
});

describe('SessionService', () => {
  const failingCatalogue: DevelopmentUserCatalogue = {
    list: () => Promise.reject(new Error('the catalogue must not be used')),
  };

  it('lists the development users in local session descriptions', async () => {
    const directory = new StaticUserDirectory(seedUsers);
    const sessions = new SessionService(directory, directory);

    const session = await sessions.describe(aisha);

    expect(session.user?.userId).toBe('u-aisha');
    expect(session.user?.manager).toEqual({
      userId: 'u-ben',
      displayName: 'Ben Tan',
    });
    expect(session.users.map((u) => u.userId)).toEqual(
      seedUsers.map((u) => u.userId),
    );
  });

  it('describes the signed-in user without the development catalogue', async () => {
    const withCatalogue = new SessionService(
      new RecordingDirectory(seedUsers),
      failingCatalogue,
    );
    const withoutCatalogue = new SessionService(
      new RecordingDirectory(seedUsers),
    );

    for (const sessions of [withCatalogue, withoutCatalogue]) {
      expect(await sessions.actorFor('u-ben')).toEqual(ben);
      expect(await sessions.describeSignedIn(ben)).toMatchObject({
        user: { userId: 'u-ben', manager: { userId: 'u-chloe' } },
        users: [],
      });
      expect(await sessions.describeSignedIn(undefined)).toEqual({
        user: null,
        users: [],
      });
    }
  });

  it('refuses to list development users without a catalogue', async () => {
    const sessions = new SessionService(new RecordingDirectory(seedUsers));

    await expect(sessions.describe(aisha)).rejects.toThrow(
      'No development user catalogue is configured.',
    );
  });
});
