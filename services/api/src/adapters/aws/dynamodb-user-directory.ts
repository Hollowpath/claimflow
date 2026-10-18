import {
  BatchGetCommand,
  GetCommand,
  type BatchGetCommandOutput,
  type GetCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import { roles, type Role } from '@claimflow/domain';

import type { UserDirectory, UserProfile } from '../../application/ports.js';

/** The commands this adapter sends; a `DynamoDBDocumentClient` provides them. */
export interface UserProfileDocumentClient {
  send(command: GetCommand): Promise<GetCommandOutput>;
  send(command: BatchGetCommand): Promise<BatchGetCommandOutput>;
}

export interface DynamoDbUserDirectoryOptions {
  readonly client: UserProfileDocumentClient;
  readonly tableName: string;
  /** Attempts per batch, including the first; at least 1. Default 6. */
  readonly maxBatchAttempts?: number;
  /** Delay before the first retry; doubled for each later one. Default 50 ms. */
  readonly baseRetryDelayMs?: number;
  /** Longest delay between retries. Default 1,000 ms. */
  readonly maxRetryDelayMs?: number;
  /** Waits between retries; replaceable so tests do not wait. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** `BatchGetItem` accepts at most 100 keys per call. */
export const maxBatchGetKeys = 100;

const profileSortKey = 'PROFILE';
const profileEntityType = 'UserProfile';

type ProfileKey = { readonly PK: string; readonly SK: string };

/** A stored user profile that does not match the approved item shape. */
export class InvalidUserProfileError extends Error {
  public constructor(key: string, problem: string) {
    super(`The user profile item ${key} is invalid: ${problem}.`);
    this.name = 'InvalidUserProfileError';
  }
}

/** DynamoDB still had unprocessed keys after the last allowed attempt. */
export class UnprocessedUserProfilesError extends Error {
  public constructor(unprocessed: number, attempts: number) {
    super(
      `DynamoDB left ${unprocessed} user profile keys unprocessed after ${attempts} attempts.`,
    );
    this.name = 'UnprocessedUserProfilesError';
  }
}

/**
 * User profiles in the ClaimFlow table (`PK = USER#<userId>`,
 * `SK = PROFILE`): `GetItem` for one profile (U1) and `BatchGetItem` for
 * display names (U2). It never scans or queries.
 */
export class DynamoDbUserDirectory implements UserDirectory {
  private readonly client: UserProfileDocumentClient;
  private readonly tableName: string;
  private readonly maxBatchAttempts: number;
  private readonly baseRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  public constructor(options: DynamoDbUserDirectoryOptions) {
    this.client = options.client;
    this.tableName = options.tableName;
    this.maxBatchAttempts = Math.max(1, options.maxBatchAttempts ?? 6);
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 50;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 1000;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** U1: one strongly consistent `GetItem`, read on every request. */
  public async get(userId: string): Promise<UserProfile | undefined> {
    const key = profileKey(userId);
    const output = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: key,
        ConsistentRead: true,
      }),
    );
    return output.Item === undefined
      ? undefined
      : toUserProfile(output.Item, userId);
  }

  /**
   * U2: eventually consistent `BatchGetItem` calls of at most 100 keys,
   * retrying unprocessed keys with exponential backoff.
   */
  public async getMany(
    userIds: readonly string[],
  ): Promise<readonly UserProfile[]> {
    const ids = [...new Set(userIds)];
    const profiles = new Map<string, UserProfile>();
    for (let start = 0; start < ids.length; start += maxBatchGetKeys) {
      const batch = ids.slice(start, start + maxBatchGetKeys);
      for (const profile of await this.batchGet(batch)) {
        profiles.set(profile.userId, profile);
      }
    }
    return [...profiles.values()];
  }

  private async batchGet(userIds: readonly string[]): Promise<UserProfile[]> {
    const requested = new Set(userIds);
    const profiles: UserProfile[] = [];
    let keys: readonly Record<string, unknown>[] = userIds.map(profileKey);

    for (let attempt = 1; ; attempt += 1) {
      const output = await this.client.send(
        new BatchGetCommand({
          RequestItems: {
            [this.tableName]: { Keys: [...keys], ConsistentRead: false },
          },
        }),
      );
      for (const item of output.Responses?.[this.tableName] ?? []) {
        const profile = toUserProfile(item);
        if (!requested.has(profile.userId)) {
          throw new InvalidUserProfileError(
            String(item.PK),
            'it was not requested',
          );
        }
        profiles.push(profile);
      }

      keys = output.UnprocessedKeys?.[this.tableName]?.Keys ?? [];
      if (keys.length === 0) {
        return profiles;
      }
      if (attempt >= this.maxBatchAttempts) {
        throw new UnprocessedUserProfilesError(keys.length, attempt);
      }
      await this.sleep(this.retryDelayMs(attempt));
    }
  }

  /** 50, 100, 200, ... ms with the defaults, capped at the maximum. */
  private retryDelayMs(attempt: number): number {
    return Math.min(
      this.maxRetryDelayMs,
      this.baseRetryDelayMs * 2 ** (attempt - 1),
    );
  }
}

function profileKey(userId: string): ProfileKey {
  return { PK: `USER#${userId}`, SK: profileSortKey };
}

/**
 * Validates a stored profile item. A malformed item fails instead of being
 * used, because it carries authorization data.
 */
function toUserProfile(
  item: Record<string, unknown>,
  expectedUserId?: string,
): UserProfile {
  const key = typeof item.PK === 'string' ? item.PK : '(no PK)';
  const fail = (problem: string): never => {
    throw new InvalidUserProfileError(key, problem);
  };

  const userId = nonEmptyString(item.userId) ?? fail('userId is missing');
  if (expectedUserId !== undefined && userId !== expectedUserId) {
    fail('userId does not match the requested user');
  }
  if (item.PK !== `USER#${userId}`) {
    fail('PK does not match userId');
  }
  if (item.SK !== profileSortKey) {
    fail(`SK is not ${profileSortKey}`);
  }
  if (item.entityType !== profileEntityType) {
    fail(`entityType is not ${profileEntityType}`);
  }
  const displayName =
    nonEmptyString(item.displayName) ?? fail('displayName is missing');
  const title = nonEmptyString(item.title) ?? fail('title is missing');
  if (!Array.isArray(item.roles) || !item.roles.every(isRole)) {
    fail('roles must be a list of EMPLOYEE, MANAGER, or ADMIN');
  }
  const userRoles = item.roles as Role[];

  let managerId: string | undefined;
  if (item.managerId !== undefined) {
    managerId =
      nonEmptyString(item.managerId) ?? fail('managerId must not be empty');
  }

  return {
    userId,
    displayName,
    title,
    roles: [...new Set(userRoles)],
    ...(managerId === undefined ? {} : { managerId }),
  };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : undefined;
}

function isRole(value: unknown): value is Role {
  return (roles as readonly unknown[]).includes(value);
}
