import {
  openReviewStatuses,
  type Category,
  type Claim,
  type ClaimChange,
  type ClaimStatus,
} from '@claimflow/domain';

import {
  ApplicationError,
  VersionConflictError,
} from '../../application/errors.js';
import type {
  CategoryRepository,
  ClaimRepository,
  IdempotencyBegin,
  IdempotencyStore,
  Page,
  PageRequest,
  StoredResponse,
} from '../../application/ports.js';
import type { Clock } from '../../application/ports.js';
import type { DatabaseState, JsonDatabase } from './json-database.js';
import { compareKeys, paginate } from './pagination.js';

const byUpdated = (claim: Claim) => `${claim.updatedAt}|${claim.claimId}`;
const bySubmitted = (claim: Claim) =>
  `${claim.submittedAt ?? ''}|${claim.claimId}`;

export class LocalClaimRepository implements ClaimRepository {
  public constructor(private readonly db: JsonDatabase) {}

  public get(claimId: string): Promise<Claim | undefined> {
    return Promise.resolve(this.db.read((state) => state.claims[claimId]));
  }

  public async create({ claim, history }: ClaimChange): Promise<void> {
    await this.db.write((state) => {
      if (state.claims[claim.claimId] !== undefined) {
        throw new ApplicationError('VERSION_CONFLICT', 'Claim already exists.');
      }
      state.claims[claim.claimId] = claim;
      state.history[claim.claimId] = [history];
    });
  }

  public async update(
    { claim, history }: ClaimChange,
    expectedVersion: number,
  ): Promise<void> {
    await this.db.write((state) => {
      const current = state.claims[claim.claimId];
      if (current === undefined || current.version !== expectedVersion) {
        throw new VersionConflictError();
      }
      state.claims[claim.claimId] = claim;
      (state.history[claim.claimId] ??= []).push(history);
    });
  }

  public async delete(claimId: string, expectedVersion: number): Promise<void> {
    await this.db.write((state) => {
      if (state.claims[claimId]?.version !== expectedVersion) {
        throw new VersionConflictError();
      }
      delete state.claims[claimId];
      delete state.history[claimId];
    });
  }

  public existsForCategory(categoryId: string): Promise<boolean> {
    return Promise.resolve(
      this.db.read((state) =>
        Object.values(state.claims).some((c) => c.categoryId === categoryId),
      ),
    );
  }

  public listByEmployee(
    employeeId: string,
    page: PageRequest,
  ): Promise<Page<Claim>> {
    return this.list(
      (claim) => claim.employeeId === employeeId,
      byUpdated,
      'desc',
      page,
      `employee:${employeeId}`,
    );
  }

  public listOpenForManager(
    managerId: string,
    page: PageRequest,
  ): Promise<Page<Claim>> {
    return this.list(
      (claim) =>
        claim.assignedManagerId === managerId &&
        openReviewStatuses.includes(claim.status),
      bySubmitted,
      'asc',
      page,
      `manager:${managerId}`,
    );
  }

  public listByStatus(
    status: ClaimStatus | undefined,
    page: PageRequest,
  ): Promise<Page<Claim>> {
    return this.list(
      (claim) => status === undefined || claim.status === status,
      byUpdated,
      'desc',
      page,
      `status:${status ?? '*'}`,
    );
  }

  public listHistory(claimId: string, page: PageRequest) {
    const entries = this.db.read((state) => state.history[claimId] ?? []);
    const keyOf = (entry: { version: number }) =>
      entry.version.toString().padStart(10, '0');
    return Promise.resolve(
      paginate(entries, keyOf, 'asc', page, `history:${claimId}`),
    );
  }

  private list(
    include: (claim: Claim) => boolean,
    keyOf: (claim: Claim) => string,
    direction: 'asc' | 'desc',
    page: PageRequest,
    listName: string,
  ): Promise<Page<Claim>> {
    const order = compareKeys(direction);
    const sorted = this.db
      .read((state) => Object.values(state.claims))
      .filter(include)
      .sort((a, b) => order(keyOf(a), keyOf(b)));
    return Promise.resolve(paginate(sorted, keyOf, direction, page, listName));
  }
}

export class LocalCategoryRepository implements CategoryRepository {
  public constructor(private readonly db: JsonDatabase) {}

  public get(categoryId: string): Promise<Category | undefined> {
    return Promise.resolve(
      this.db.read((state) => state.categories[categoryId]),
    );
  }

  public list(): Promise<readonly Category[]> {
    return Promise.resolve(
      this.db.read((state) => Object.values(state.categories)),
    );
  }

  public async create(category: Category): Promise<void> {
    await this.db.write((state) => {
      if (state.categories[category.categoryId] !== undefined) {
        throw new ApplicationError(
          'VERSION_CONFLICT',
          'Category already exists.',
        );
      }
      state.categories[category.categoryId] = category;
    });
  }

  public async update(
    category: Category,
    expectedVersion: number,
  ): Promise<void> {
    await this.db.write((state) => {
      if (state.categories[category.categoryId]?.version !== expectedVersion) {
        throw new VersionConflictError();
      }
      state.categories[category.categoryId] = category;
    });
  }

  public async delete(
    categoryId: string,
    expectedVersion: number,
  ): Promise<void> {
    await this.db.write((state) => {
      if (state.categories[categoryId]?.version !== expectedVersion) {
        throw new VersionConflictError();
      }
      delete state.categories[categoryId];
    });
  }
}

export class LocalIdempotencyStore implements IdempotencyStore {
  public constructor(
    private readonly db: JsonDatabase,
    private readonly clock: Clock,
  ) {}

  public begin(
    actorId: string,
    key: string,
    fingerprint: string,
    expiresAt: string,
  ): Promise<IdempotencyBegin> {
    const now = this.clock.now().toISOString();
    return this.db.write((state): IdempotencyBegin => {
      removeExpired(state, now);
      const id = recordId(actorId, key);
      const existing = state.idempotency[id];
      if (existing === undefined) {
        state.idempotency[id] = { fingerprint, expiresAt };
        return { outcome: 'started' };
      }
      if (existing.fingerprint !== fingerprint) {
        return { outcome: 'mismatch' };
      }
      return existing.response === undefined
        ? { outcome: 'in-progress' }
        : { outcome: 'completed', response: existing.response };
    });
  }

  public async complete(
    actorId: string,
    key: string,
    response: StoredResponse,
  ): Promise<void> {
    await this.db.write((state) => {
      const id = recordId(actorId, key);
      const existing = state.idempotency[id];
      if (existing !== undefined) {
        state.idempotency[id] = { ...existing, response };
      }
    });
  }

  public async abandon(actorId: string, key: string): Promise<void> {
    await this.db.write((state) => {
      delete state.idempotency[recordId(actorId, key)];
    });
  }
}

function recordId(actorId: string, key: string): string {
  return `${actorId}\u0000${key}`;
}

function removeExpired(state: DatabaseState, now: string): void {
  for (const [id, record] of Object.entries(state.idempotency)) {
    if (record.expiresAt <= now) {
      delete state.idempotency[id];
    }
  }
}
