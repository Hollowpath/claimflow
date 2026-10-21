import type {
  ClaimDto,
  ClaimHistoryEntryDto,
  ClaimStatus,
  Page,
  PageQuery,
} from '@claimflow/contracts';
import { hasRole, type Actor, type Claim } from '@claimflow/domain';

import { loadVisibleClaim } from './claim-access.js';
import { ForbiddenError } from './errors.js';
import type {
  CategoryRepository,
  ClaimRepository,
  UserDirectory,
} from './ports.js';
import {
  claimUserIds,
  loadNames,
  toClaimDto,
  toHistoryDto,
} from './presenters.js';

/**
 * The five claim reads: get, history, the employee's own list, the manager's
 * review queue, and the administrator's list. They need only the repository's
 * read methods, so the local runtime and the AWS readers share this one set of
 * access rules, role restrictions, pagination, and presentation.
 */
export interface ClaimQueryServiceDependencies {
  readonly claims: Pick<
    ClaimRepository,
    | 'get'
    | 'listByEmployee'
    | 'listOpenForManager'
    | 'listByStatus'
    | 'listHistory'
  >;
  readonly categories: Pick<CategoryRepository, 'list'>;
  readonly users: UserDirectory;
}

export class ClaimQueryService {
  public constructor(private readonly deps: ClaimQueryServiceDependencies) {}

  public async get(actor: Actor, claimId: string): Promise<ClaimDto> {
    const claim = await loadVisibleClaim(this.deps.claims, actor, claimId);
    return this.present(claim, actor);
  }

  public async listMine(
    actor: Actor,
    page: PageQuery,
  ): Promise<Page<ClaimDto>> {
    if (!hasRole(actor, 'EMPLOYEE')) {
      throw new ForbiddenError('Only employees have their own claims.');
    }
    return this.presentPage(
      await this.deps.claims.listByEmployee(actor.userId, page),
      actor,
    );
  }

  public async listReviewQueue(
    actor: Actor,
    page: PageQuery,
  ): Promise<Page<ClaimDto>> {
    if (!hasRole(actor, 'MANAGER')) {
      throw new ForbiddenError('Only managers have a review queue.');
    }
    return this.presentPage(
      await this.deps.claims.listOpenForManager(actor.userId, page),
      actor,
    );
  }

  public async listAll(
    actor: Actor,
    status: ClaimStatus | undefined,
    page: PageQuery,
  ): Promise<Page<ClaimDto>> {
    if (!hasRole(actor, 'ADMIN')) {
      throw new ForbiddenError('Only administrators can list all claims.');
    }
    return this.presentPage(
      await this.deps.claims.listByStatus(status, page),
      actor,
    );
  }

  public async history(
    actor: Actor,
    claimId: string,
    page: PageQuery,
  ): Promise<Page<ClaimHistoryEntryDto>> {
    await loadVisibleClaim(this.deps.claims, actor, claimId);
    const entries = await this.deps.claims.listHistory(claimId, page);
    const names = await this.names(entries.items.map((entry) => entry.actorId));
    return {
      items: entries.items.map((entry) => toHistoryDto(entry, names)),
      ...(entries.nextCursor === undefined
        ? {}
        : { nextCursor: entries.nextCursor }),
    };
  }

  private names(userIds: Iterable<string>) {
    return loadNames(this.deps.users, this.deps.categories, userIds);
  }

  private async present(claim: Claim, actor: Actor): Promise<ClaimDto> {
    return toClaimDto(claim, actor, await this.names(claimUserIds(claim)));
  }

  private async presentPage(
    page: { items: readonly Claim[]; nextCursor?: string },
    actor: Actor,
  ): Promise<Page<ClaimDto>> {
    const names = await this.names(page.items.flatMap(claimUserIds));
    return {
      items: page.items.map((claim) => toClaimDto(claim, actor, names)),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  }
}
