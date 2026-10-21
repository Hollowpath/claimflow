import type {
  ClaimAction,
  ClaimDto,
  ClaimHistoryEntryDto,
  ClaimStatus,
  CreateClaimRequest,
  Page,
  PageQuery,
  UpdateClaimRequest,
} from '@claimflow/contracts';
import {
  approveClaim,
  assertMayDeleteClaim,
  createDraftClaim,
  markClaimPaid,
  rejectClaim,
  reopenClaim,
  startReview,
  submitClaim,
  updateDraftClaim,
  type Actor,
  type Category,
  type Claim,
  type ClaimChange,
  type CommandContext,
} from '@claimflow/domain';

import { assertVersion, loadVisibleClaim } from './claim-access.js';
import { ClaimQueryService } from './claim-query-service.js';
import type {
  CategoryRepository,
  ClaimRepository,
  Clock,
  IdGenerator,
  Logger,
  ReceiptStorage,
  UserDirectory,
} from './ports.js';
import { claimUserIds, loadNames, toClaimDto } from './presenters.js';

export interface ClaimServiceDependencies {
  readonly claims: ClaimRepository;
  readonly categories: CategoryRepository;
  readonly users: UserDirectory;
  readonly receipts: ReceiptStorage;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
}

export interface ActionInput {
  readonly expectedVersion: number;
  /** Required for APPROVE and REJECT; ignored otherwise. */
  readonly comment?: string;
}

export class ClaimService {
  private readonly queries: ClaimQueryService;

  public constructor(private readonly deps: ClaimServiceDependencies) {
    this.queries = new ClaimQueryService(deps);
  }

  public get(actor: Actor, claimId: string): Promise<ClaimDto> {
    return this.queries.get(actor, claimId);
  }

  public listMine(actor: Actor, page: PageQuery): Promise<Page<ClaimDto>> {
    return this.queries.listMine(actor, page);
  }

  public listReviewQueue(
    actor: Actor,
    page: PageQuery,
  ): Promise<Page<ClaimDto>> {
    return this.queries.listReviewQueue(actor, page);
  }

  public listAll(
    actor: Actor,
    status: ClaimStatus | undefined,
    page: PageQuery,
  ): Promise<Page<ClaimDto>> {
    return this.queries.listAll(actor, status, page);
  }

  public history(
    actor: Actor,
    claimId: string,
    page: PageQuery,
  ): Promise<Page<ClaimHistoryEntryDto>> {
    return this.queries.history(actor, claimId, page);
  }

  public async create(
    actor: Actor,
    request: CreateClaimRequest,
  ): Promise<ClaimDto> {
    const category = await this.findCategory(request.categoryId);
    const change = createDraftClaim(
      this.deps.ids.newId(),
      request,
      category,
      this.context(actor),
    );
    await this.deps.claims.create(change);
    return this.present(change.claim, actor);
  }

  /** Deletes a never-submitted draft with its history and receipt file. */
  public async delete(
    actor: Actor,
    claimId: string,
    expectedVersion: number,
  ): Promise<void> {
    const claim = await loadVisibleClaim(this.deps.claims, actor, claimId);
    assertVersion(claim, expectedVersion);
    assertMayDeleteClaim(claim, actor);
    await this.deps.claims.delete(claimId, claim.version);

    if (claim.receipt !== undefined) {
      const { receiptId } = claim.receipt;
      try {
        await this.deps.receipts.delete(receiptId);
      } catch (error) {
        // The claim is already gone; an orphaned file is harmless.
        this.deps.logger.warn('receipt.delete_failed', {
          receiptId,
          error: error instanceof Error ? error.message : 'unknown',
        });
      }
    }
  }

  public async update(
    actor: Actor,
    claimId: string,
    { expectedVersion, ...changes }: UpdateClaimRequest,
  ): Promise<ClaimDto> {
    const claim = await loadVisibleClaim(this.deps.claims, actor, claimId);
    assertVersion(claim, expectedVersion);
    const category =
      typeof changes.categoryId === 'string'
        ? await this.findCategory(changes.categoryId)
        : undefined;
    const change = updateDraftClaim(
      claim,
      changes,
      category,
      this.context(actor),
    );
    return this.save(change, claim, actor);
  }

  public async perform(
    actor: Actor,
    claimId: string,
    action: ClaimAction,
    { expectedVersion, comment = '' }: ActionInput,
  ): Promise<ClaimDto> {
    const claim = await loadVisibleClaim(this.deps.claims, actor, claimId);
    assertVersion(claim, expectedVersion);
    const context = this.context(actor);

    let change: ClaimChange;
    switch (action) {
      case 'SUBMIT':
        change = submitClaim(
          claim,
          await this.findCategory(claim.categoryId),
          context,
        );
        break;
      case 'START_REVIEW':
        change = startReview(claim, context);
        break;
      case 'APPROVE':
        change = approveClaim(claim, comment, context);
        break;
      case 'REJECT':
        change = rejectClaim(claim, comment, context);
        break;
      case 'REOPEN':
        change = reopenClaim(claim, context);
        break;
      case 'MARK_PAID':
        change = markClaimPaid(claim, context);
        break;
    }
    return this.save(change, claim, actor);
  }

  private async save(
    change: ClaimChange,
    previous: Claim,
    actor: Actor,
  ): Promise<ClaimDto> {
    await this.deps.claims.update(change, previous.version);
    return this.present(change.claim, actor);
  }

  private async findCategory(
    categoryId: string | undefined,
  ): Promise<Category | undefined> {
    return categoryId === undefined
      ? undefined
      : this.deps.categories.get(categoryId);
  }

  private context(actor: Actor): CommandContext {
    return { actor, now: this.deps.clock.now().toISOString() };
  }

  private names(userIds: Iterable<string>) {
    return loadNames(this.deps.users, this.deps.categories, userIds);
  }

  private async present(claim: Claim, actor: Actor): Promise<ClaimDto> {
    return toClaimDto(claim, actor, await this.names(claimUserIds(claim)));
  }
}
