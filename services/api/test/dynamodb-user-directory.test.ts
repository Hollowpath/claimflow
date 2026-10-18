import {
  BatchGetCommand,
  GetCommand,
  type BatchGetCommandOutput,
  type DynamoDBDocumentClient,
  type GetCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import { beforeEach, describe, expect, expectTypeOf, it } from 'vitest';

import {
  DynamoDbUserDirectory,
  InvalidUserProfileError,
  maxBatchGetKeys,
  UnprocessedUserProfilesError,
  type UserProfileDocumentClient,
} from '../src/adapters/aws/dynamodb-user-directory.js';

const tableName = 'ClaimFlow';

type Item = Record<string, unknown>;

/** A stored profile item in the approved shape. */
function profileItem(userId: string, overrides: Item = {}): Item {
  return {
    PK: `USER#${userId}`,
    SK: 'PROFILE',
    entityType: 'UserProfile',
    userId,
    displayName: `Name of ${userId}`,
    title: 'Sales executive',
    roles: ['EMPLOYEE'],
    ...overrides,
  };
}

/**
 * An in-memory document client. Batch responses come back in reverse order,
 * and each planned number leaves that many keys of a call unprocessed.
 */
class FakeDocumentClient implements UserProfileDocumentClient {
  public readonly commands: (GetCommand | BatchGetCommand)[] = [];
  public readonly items = new Map<string, Item>();
  public unprocessedPlan: number[] = [];
  /** Items added to every batch response, whether requested or not. */
  public extraBatchItems: Item[] = [];

  public put(...items: Item[]): void {
    for (const item of items) {
      this.items.set(`${String(item.PK)}|${String(item.SK)}`, item);
    }
  }

  public send(command: GetCommand): Promise<GetCommandOutput>;
  public send(command: BatchGetCommand): Promise<BatchGetCommandOutput>;
  public send(
    command: GetCommand | BatchGetCommand,
  ): Promise<GetCommandOutput | BatchGetCommandOutput> {
    this.commands.push(command);
    if (command instanceof GetCommand) {
      const item = this.lookup(command.input.Key as Item);
      return Promise.resolve({
        $metadata: {},
        ...(item === undefined ? {} : { Item: item }),
      });
    }
    if (command instanceof BatchGetCommand) {
      const keys = (command.input.RequestItems?.[tableName]?.Keys ??
        []) as Item[];
      const left = Math.min(this.unprocessedPlan.shift() ?? 0, keys.length);
      const responses = keys
        .slice(left)
        .map((key) => this.lookup(key))
        .filter((item): item is Item => item !== undefined)
        .reverse()
        .concat(this.extraBatchItems);
      return Promise.resolve({
        $metadata: {},
        Responses: { [tableName]: responses },
        UnprocessedKeys:
          left === 0 ? {} : { [tableName]: { Keys: keys.slice(0, left) } },
      });
    }
    return Promise.reject(new Error('Unexpected DynamoDB command.'));
  }

  public batchCalls(): BatchGetCommand[] {
    return this.commands.filter((c) => c instanceof BatchGetCommand);
  }

  private lookup(key: Item): Item | undefined {
    return this.items.get(`${String(key.PK)}|${String(key.SK)}`);
  }
}

let client: FakeDocumentClient;
let sleeps: number[];
let directory: DynamoDbUserDirectory;

beforeEach(() => {
  client = new FakeDocumentClient();
  sleeps = [];
  directory = new DynamoDbUserDirectory({
    client,
    tableName,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
});

const keysOf = (command: BatchGetCommand) =>
  command.input.RequestItems?.[tableName]?.Keys ?? [];

it('accepts the real DynamoDB document client', () => {
  expectTypeOf<DynamoDBDocumentClient>().toExtend<UserProfileDocumentClient>();
});

describe('get', () => {
  it('reads one profile with a strongly consistent GetItem on its exact key', async () => {
    client.put(profileItem('sub-aisha', { managerId: 'sub-ben' }));

    const profile = await directory.get('sub-aisha');

    expect(client.commands).toHaveLength(1);
    expect(client.commands[0]).toBeInstanceOf(GetCommand);
    expect(client.commands[0]!.input).toEqual({
      TableName: 'ClaimFlow',
      Key: { PK: 'USER#sub-aisha', SK: 'PROFILE' },
      ConsistentRead: true,
    });
    expect(profile).toEqual({
      userId: 'sub-aisha',
      displayName: 'Name of sub-aisha',
      title: 'Sales executive',
      roles: ['EMPLOYEE'],
      managerId: 'sub-ben',
    });
  });

  it('maps a profile without a manager', async () => {
    client.put(profileItem('sub-dan', { roles: ['ADMIN'] }));

    const profile = await directory.get('sub-dan');

    expect(profile).toEqual({
      userId: 'sub-dan',
      displayName: 'Name of sub-dan',
      title: 'Sales executive',
      roles: ['ADMIN'],
    });
    expect(profile).not.toHaveProperty('managerId');
  });

  it('maps every ClaimFlow role', async () => {
    client.put(
      profileItem('sub-x', { roles: ['EMPLOYEE', 'MANAGER', 'ADMIN'] }),
    );

    expect((await directory.get('sub-x'))?.roles).toEqual([
      'EMPLOYEE',
      'MANAGER',
      'ADMIN',
    ]);
  });

  it('returns undefined when the profile does not exist', async () => {
    expect(await directory.get('sub-nobody')).toBeUndefined();
    expect(client.commands).toHaveLength(1);
  });
});

describe('stored profile validation', () => {
  it.each<[string, Item]>([
    ['a PK for another user', { PK: 'USER#sub-other' }],
    ['a wrong SK', { SK: 'PROFILE#2' }],
    ['a wrong entity type', { entityType: 'Claim' }],
    ['a missing entity type', { entityType: undefined }],
    ['a missing userId', { userId: undefined }],
    ['an empty display name', { displayName: '' }],
    ['a blank title', { title: '   ' }],
    ['a missing title', { title: undefined }],
    ['a non-string display name', { displayName: 42 }],
    ['roles that are not a list', { roles: 'ADMIN' }],
    ['roles stored as a set', { roles: new Set(['EMPLOYEE']) }],
    ['an unknown role', { roles: ['EMPLOYEE', 'SUPERUSER'] }],
    ['a lower-case role', { roles: ['admin'] }],
    ['a non-string role', { roles: [1] }],
    ['an empty manager ID', { managerId: '' }],
    ['a null manager ID', { managerId: null }],
    ['a numeric manager ID', { managerId: 7 }],
  ])('rejects an item with %s', async (_name, overrides) => {
    // Stored under the requested key, whatever its own attributes say.
    client.items.set(
      'USER#sub-aisha|PROFILE',
      profileItem('sub-aisha', overrides),
    );

    await expect(directory.get('sub-aisha')).rejects.toBeInstanceOf(
      InvalidUserProfileError,
    );
    await expect(directory.getMany(['sub-aisha'])).rejects.toBeInstanceOf(
      InvalidUserProfileError,
    );
  });

  it('rejects an item whose userId differs from the requested user', async () => {
    client.items.set(
      'USER#sub-aisha|PROFILE',
      profileItem('sub-dan', { PK: 'USER#sub-aisha' }),
    );

    await expect(directory.get('sub-aisha')).rejects.toThrow(
      'userId does not match the requested user',
    );
  });

  it('rejects a batch response containing a profile that was not requested', async () => {
    client.put(profileItem('sub-aisha'));
    client.extraBatchItems = [profileItem('sub-dan')];

    await expect(directory.getMany(['sub-aisha'])).rejects.toThrow(
      'it was not requested',
    );
  });

  it('does not reveal stored values in the error message', async () => {
    client.put(profileItem('sub-aisha', { roles: ['ROOT'], title: 'Secret' }));

    const error = await directory.get('sub-aisha').catch((e: unknown) => e);

    expect(String(error)).toContain('USER#sub-aisha');
    expect(String(error)).not.toContain('ROOT');
    expect(String(error)).not.toContain('Secret');
  });
});

describe('getMany', () => {
  it('returns an empty list without sending a command when no IDs are given', async () => {
    expect(await directory.getMany([])).toEqual([]);
    expect(client.commands).toEqual([]);
  });

  it('deduplicates IDs and reads them with one eventually consistent BatchGetItem', async () => {
    client.put(profileItem('sub-aisha'), profileItem('sub-ben'));

    const profiles = await directory.getMany([
      'sub-aisha',
      'sub-ben',
      'sub-aisha',
    ]);

    expect(client.commands).toHaveLength(1);
    expect(client.commands[0]).toBeInstanceOf(BatchGetCommand);
    expect(client.commands[0]!.input).toEqual({
      RequestItems: {
        ClaimFlow: {
          Keys: [
            { PK: 'USER#sub-aisha', SK: 'PROFILE' },
            { PK: 'USER#sub-ben', SK: 'PROFILE' },
          ],
          ConsistentRead: false,
        },
      },
    });
    expect(profiles.map((p) => p.userId).sort()).toEqual([
      'sub-aisha',
      'sub-ben',
    ]);
  });

  it('matches unordered responses and omits missing profiles', async () => {
    client.put(profileItem('sub-a'), profileItem('sub-c'));

    const profiles = await directory.getMany(['sub-a', 'sub-b', 'sub-c']);

    expect(profiles).toHaveLength(2);
    expect(new Map(profiles.map((p) => [p.userId, p.displayName]))).toEqual(
      new Map([
        ['sub-a', 'Name of sub-a'],
        ['sub-c', 'Name of sub-c'],
      ]),
    );
  });

  it('splits more than 100 distinct IDs into batches of at most 100 keys', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `sub-${i}`);
    client.put(...ids.map((id) => profileItem(id)));

    const profiles = await directory.getMany([...ids, ...ids.slice(0, 30)]);

    const batches = client.batchCalls().map((c) => keysOf(c).length);
    expect(maxBatchGetKeys).toBe(100);
    expect(batches).toEqual([100, 100, 50]);
    const requested = client.batchCalls().flatMap((c) => keysOf(c));
    expect(new Set(requested.map((k) => k.PK)).size).toBe(250);
    expect(profiles.map((p) => p.userId).sort()).toEqual([...ids].sort());
  });

  it('retries unprocessed keys with exponential backoff until all are read', async () => {
    const ids = ['sub-1', 'sub-2', 'sub-3', 'sub-4', 'sub-5'];
    client.put(...ids.map((id) => profileItem(id)));
    client.unprocessedPlan = [3, 1];

    const profiles = await directory.getMany(ids);

    expect(client.batchCalls().map((c) => keysOf(c).length)).toEqual([5, 3, 1]);
    expect(keysOf(client.batchCalls()[1]!)).toEqual(
      ids.slice(0, 3).map((id) => ({ PK: `USER#${id}`, SK: 'PROFILE' })),
    );
    expect(sleeps).toEqual([50, 100]);
    expect(profiles.map((p) => p.userId).sort()).toEqual(ids);
  });

  it('fails after the retry limit instead of returning incomplete data', async () => {
    client.put(profileItem('sub-1'), profileItem('sub-2'));
    client.unprocessedPlan = [1, 1, 1, 1, 1, 1, 1, 1];

    await expect(directory.getMany(['sub-1', 'sub-2'])).rejects.toThrow(
      new UnprocessedUserProfilesError(1, 6),
    );
    expect(client.batchCalls()).toHaveLength(6);
    expect(sleeps).toEqual([50, 100, 200, 400, 800]);
  });

  it('caps the backoff delay and honours a custom attempt limit', async () => {
    const limited = new DynamoDbUserDirectory({
      client,
      tableName,
      maxBatchAttempts: 4,
      baseRetryDelayMs: 300,
      maxRetryDelayMs: 500,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    client.put(profileItem('sub-1'));
    client.unprocessedPlan = [1, 1, 1, 1];

    await expect(limited.getMany(['sub-1'])).rejects.toBeInstanceOf(
      UnprocessedUserProfilesError,
    );
    expect(sleeps).toEqual([300, 500, 500]);
  });
});

it('sends only GetItem and BatchGetItem commands, never Scan or Query', async () => {
  client.put(profileItem('sub-a'), profileItem('sub-b'));
  client.unprocessedPlan = [1];

  await directory.get('sub-a');
  await directory.get('sub-missing');
  await directory.getMany(['sub-a', 'sub-b', 'sub-missing']);

  expect(
    new Set(client.commands.map((command) => command.constructor.name)),
  ).toEqual(new Set(['GetCommand', 'BatchGetCommand']));
});
