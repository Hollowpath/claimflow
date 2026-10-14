import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Category, Claim, ClaimHistoryEntry } from '@claimflow/domain';

import type { StoredResponse } from '../../application/ports.js';

export interface IdempotencyRecord {
  readonly fingerprint: string;
  readonly expiresAt: string;
  readonly response?: StoredResponse;
}

export interface DatabaseState {
  readonly schemaVersion: 1;
  readonly claims: Record<string, Claim>;
  /** Per claim, ordered by version. Entries are only ever appended. */
  readonly history: Record<string, ClaimHistoryEntry[]>;
  readonly categories: Record<string, Category>;
  /** Keyed by `${actorId}\u0000${key}`. */
  readonly idempotency: Record<string, IdempotencyRecord>;
}

export function emptyState(): DatabaseState {
  return {
    schemaVersion: 1,
    claims: {},
    history: {},
    categories: {},
    idempotency: {},
  };
}

/**
 * A small JSON-file database for local use. Writes run one at a time against a
 * copy of the state and are persisted with an atomic rename before the new
 * state becomes visible, so a failed write never leaves partial changes.
 */
export class JsonDatabase {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private state: DatabaseState,
    private readonly filePath: string | undefined,
  ) {}

  /** Opens the file, creating it from `seed` if it does not exist. */
  public static async open(
    filePath: string,
    seed: () => DatabaseState,
  ): Promise<JsonDatabase> {
    let state: DatabaseState;
    try {
      state = JSON.parse(await readFile(filePath, 'utf8')) as DatabaseState;
    } catch (error) {
      if (!isMissingFile(error)) {
        throw new Error(
          `Cannot read local data at ${filePath}. Fix or reset it with "npm run reset-data".`,
          { cause: error },
        );
      }
      state = seed();
      await persist(filePath, state);
    }
    if (state.schemaVersion !== 1) {
      throw new Error(
        `Unsupported local data format in ${filePath}. Reset it with "npm run reset-data".`,
      );
    }
    return new JsonDatabase(state, filePath);
  }

  /** An in-memory database for tests. */
  public static inMemory(state: DatabaseState = emptyState()): JsonDatabase {
    return new JsonDatabase(state, undefined);
  }

  /** Reads a value; the result is a copy that callers may not use to mutate. */
  public read<T>(select: (state: DatabaseState) => T): T {
    return structuredClone(select(this.state));
  }

  /**
   * Applies `change` to a working copy, persists it, then publishes it. A throw
   * from `change` aborts the write and leaves the state untouched.
   */
  public write<T>(change: (draft: DatabaseState) => T): Promise<T> {
    const run = async () => {
      const draft = structuredClone(this.state);
      const result = change(draft);
      if (this.filePath !== undefined) {
        await persist(this.filePath, draft);
      }
      this.state = draft;
      return structuredClone(result);
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

async function persist(filePath: string, state: DatabaseState): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
  await renameWithRetry(temporary, filePath);
}

/** Windows can briefly lock a file being replaced (e.g. by antivirus). */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY')) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

export function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}
