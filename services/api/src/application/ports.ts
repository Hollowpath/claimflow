import type {
  Category,
  Claim,
  ClaimChange,
  ClaimHistoryEntry,
  ClaimStatus,
  Role,
  UploadedReceipt,
} from '@claimflow/domain';

export interface PageRequest {
  readonly limit: number;
  /** Opaque cursor from a previous page. */
  readonly cursor?: string | undefined;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export interface ClaimRepository {
  get(claimId: string): Promise<Claim | undefined>;
  /** Stores a new claim and its first history entry together. */
  create(change: ClaimChange): Promise<void>;
  /**
   * Stores the claim and its history entry together, only if the stored claim
   * is still at `expectedVersion`; otherwise fails with `VersionConflictError`.
   */
  update(change: ClaimChange, expectedVersion: number): Promise<void>;
  /**
   * Removes a claim and its history together, only if the stored claim is
   * still at `expectedVersion`; otherwise fails with `VersionConflictError`.
   */
  delete(claimId: string, expectedVersion: number): Promise<void>;
  /** Whether any claim, in any status, refers to the category. */
  existsForCategory(categoryId: string): Promise<boolean>;
  /** Most recently updated first. */
  listByEmployee(employeeId: string, page: PageRequest): Promise<Page<Claim>>;
  /** SUBMITTED and UNDER_REVIEW claims assigned to a manager, oldest first. */
  listOpenForManager(
    managerId: string,
    page: PageRequest,
  ): Promise<Page<Claim>>;
  /** All claims, or those in one status; most recently updated first. */
  listByStatus(
    status: ClaimStatus | undefined,
    page: PageRequest,
  ): Promise<Page<Claim>>;
  /** Oldest first. */
  listHistory(
    claimId: string,
    page: PageRequest,
  ): Promise<Page<ClaimHistoryEntry>>;
}

export interface CategoryRepository {
  get(categoryId: string): Promise<Category | undefined>;
  list(): Promise<readonly Category[]>;
  create(category: Category): Promise<void>;
  /** Fails with `VersionConflictError` unless still at `expectedVersion`. */
  update(category: Category, expectedVersion: number): Promise<void>;
  /** Fails with `VersionConflictError` unless still at `expectedVersion`. */
  delete(categoryId: string, expectedVersion: number): Promise<void>;
}

export interface UserProfile {
  readonly userId: string;
  readonly displayName: string;
  readonly title: string;
  readonly roles: readonly Role[];
  readonly managerId?: string;
}

export interface UserDirectory {
  get(userId: string): Promise<UserProfile | undefined>;
  list(): Promise<readonly UserProfile[]>;
}

export interface ReceiptStorage {
  save(receipt: UploadedReceipt, content: Uint8Array): Promise<void>;
  getMetadata(receiptId: string): Promise<UploadedReceipt | undefined>;
  read(receiptId: string): Promise<Uint8Array | undefined>;
  markAttached(receiptId: string, claimId: string): Promise<void>;
  delete(receiptId: string): Promise<void>;
  /** Removes uploads never attached to a claim. Returns how many. */
  deleteUnattachedBefore(instant: string): Promise<number>;
}

export interface StoredResponse {
  readonly status: number;
  readonly body: unknown;
}

export type IdempotencyBegin =
  | { readonly outcome: 'started' }
  | { readonly outcome: 'in-progress' }
  | { readonly outcome: 'mismatch' }
  | { readonly outcome: 'completed'; readonly response: StoredResponse };

export interface IdempotencyStore {
  /** Atomically claims `key` for `scope` or reports its existing state. */
  begin(
    scope: string,
    key: string,
    fingerprint: string,
    expiresAt: string,
  ): Promise<IdempotencyBegin>;
  complete(scope: string, key: string, response: StoredResponse): Promise<void>;
  /** Releases a claimed key after an unexpected failure so it can be retried. */
  abandon(scope: string, key: string): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  newId(): string;
}

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}
