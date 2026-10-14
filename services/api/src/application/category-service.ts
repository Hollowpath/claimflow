import type {
  CategoryDto,
  CreateCategoryRequest,
  UpdateCategoryRequest,
} from '@claimflow/contracts';
import {
  assertMayDeleteCategory,
  createCategory,
  updateCategory,
  type Actor,
  type CategorySettings,
} from '@claimflow/domain';

import { assertVersion } from './claim-access.js';
import { ApplicationError, NotFoundError } from './errors.js';
import type {
  CategoryRepository,
  ClaimRepository,
  Clock,
  IdGenerator,
} from './ports.js';
import { toCategoryDto } from './presenters.js';

export interface CategoryServiceDependencies {
  readonly categories: CategoryRepository;
  readonly claims: ClaimRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export class CategoryService {
  public constructor(private readonly deps: CategoryServiceDependencies) {}

  /** Every signed-in user may read categories to fill in and review claims. */
  public async list(): Promise<CategoryDto[]> {
    const categories = await this.deps.categories.list();
    return [...categories]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(toCategoryDto);
  }

  public async create(
    actor: Actor,
    request: CreateCategoryRequest,
  ): Promise<CategoryDto> {
    const category = createCategory(
      this.deps.ids.newId(),
      { ...request, active: request.active ?? true },
      this.context(actor),
    );
    await this.deps.categories.create(category);
    return toCategoryDto(category);
  }

  public async update(
    actor: Actor,
    categoryId: string,
    { expectedVersion, ...changes }: UpdateCategoryRequest,
  ): Promise<CategoryDto> {
    const current = await this.deps.categories.get(categoryId);
    if (current === undefined) {
      throw new NotFoundError('Category not found.');
    }
    assertVersion(current, expectedVersion);
    const updated = updateCategory(
      current,
      definedOnly(changes),
      this.context(actor),
    );
    await this.deps.categories.update(updated, current.version);
    return toCategoryDto(updated);
  }

  /**
   * Deletes a category that no claim uses. Categories in use must be
   * deactivated instead so existing claims keep a valid category.
   */
  public async delete(
    actor: Actor,
    categoryId: string,
    expectedVersion: number,
  ): Promise<void> {
    assertMayDeleteCategory(actor);
    const current = await this.deps.categories.get(categoryId);
    if (current === undefined) {
      throw new NotFoundError('Category not found.');
    }
    assertVersion(current, expectedVersion);
    if (await this.deps.claims.existsForCategory(categoryId)) {
      throw new ApplicationError(
        'CATEGORY_IN_USE',
        'This category is used by existing claims. Deactivate it instead.',
      );
    }
    await this.deps.categories.delete(categoryId, current.version);
  }

  private context(actor: Actor) {
    return { actor, now: this.deps.clock.now().toISOString() };
  }
}

function definedOnly(
  changes: Omit<UpdateCategoryRequest, 'expectedVersion'>,
): Partial<CategorySettings> {
  return Object.fromEntries(
    Object.entries(changes).filter(([, value]) => value !== undefined),
  );
}
