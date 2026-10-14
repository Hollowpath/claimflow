import { IdempotencyConflictError } from './errors.js';
import type { Clock, IdempotencyStore, StoredResponse } from './ports.js';

export const idempotencyRetentionMs = 24 * 60 * 60 * 1000;

/**
 * Runs a retryable operation at most once per actor and key. A retry with the
 * same request gets the original response; reusing the key for a different
 * request is refused. Unexpected failures release the key so it can be retried.
 */
export class Idempotency {
  public constructor(
    private readonly store: IdempotencyStore,
    private readonly clock: Clock,
  ) {}

  public async run(
    actorId: string,
    key: string,
    fingerprint: string,
    execute: () => Promise<StoredResponse>,
  ): Promise<{ response: StoredResponse; replayed: boolean }> {
    const expiresAt = new Date(
      this.clock.now().getTime() + idempotencyRetentionMs,
    ).toISOString();
    const begun = await this.store.begin(actorId, key, fingerprint, expiresAt);

    switch (begun.outcome) {
      case 'completed':
        return { response: begun.response, replayed: true };
      case 'mismatch':
        throw new IdempotencyConflictError(
          'This idempotency key was already used for a different request.',
        );
      case 'in-progress':
        throw new IdempotencyConflictError(
          'A request with this idempotency key is still being processed.',
        );
      case 'started':
        break;
    }

    let response: StoredResponse;
    try {
      response = await execute();
    } catch (error) {
      await this.store.abandon(actorId, key);
      throw error;
    }
    await this.store.complete(actorId, key, response);
    return { response, replayed: false };
  }
}
