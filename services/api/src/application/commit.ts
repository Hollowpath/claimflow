import type { OutboxEvent } from './events.js';
import type { StoredResponse } from './ports.js';

/**
 * A DynamoDB TTL value: whole seconds since the Unix epoch. DynamoDB ignores
 * TTL attributes that are not numbers, so ISO strings are never used here.
 */
export type EpochSeconds = number;

/** Whole seconds since the Unix epoch, rounded down. */
export function toEpochSeconds(date: Date): EpochSeconds {
  const ms = date.getTime();
  if (!Number.isFinite(ms)) {
    throw new RangeError('Cannot convert an invalid date to epoch seconds.');
  }
  return Math.floor(ms / 1000);
}

/** The TTL value `durationMs` after `now`. */
export function expiresAfter(now: Date, durationMs: number): EpochSeconds {
  return toEpochSeconds(new Date(now.getTime() + durationMs));
}

/**
 * A reference to a result that is rebuilt on replay instead of stored
 * (docs/aws-architecture.md, section 10, "Reconstructed results"). Only a
 * receipt upload uses one: the presigned form is never persisted.
 */
export interface ResultReference {
  readonly receiptId: string;
}

/** A persisted result that is a reference, with no response body. */
export interface StoredResultReference {
  readonly status: 201;
  readonly resultRef: ResultReference;
}

/**
 * What an idempotency record persists: either a response snapshot or, for a
 * committed receipt upload, a result reference. The two shapes are mutually
 * exclusive. The local `StoredResponse` contract is unchanged.
 */
export type PersistedResult = StoredResponse | StoredResultReference;

/** Whether a persisted result is a reference rather than a snapshot. */
export function isResultReference(
  result: PersistedResult,
): result is StoredResultReference {
  return 'resultRef' in result;
}

/** The application result stored under an idempotency key with the change. */
export interface CompletedRequest {
  readonly actorId: string;
  /** The client's `Idempotency-Key`. */
  readonly key: string;
  /** SHA-256 of the method, path, and body that the key was first used for. */
  readonly fingerprint: string;
  /** The status and body replayed to retries, or a result reference. */
  readonly response: PersistedResult;
  /** ISO 8601 creation time. */
  readonly createdAt: string;
  /** TTL: exactly `idempotencyRetentionMs` (24 hours) after `createdAt`. */
  readonly expiresAt: EpochSeconds;
}

/**
 * Commits only if the category is still at the version the application read,
 * and, when `mustBeActive`, still active (section 9).
 */
export interface CategoryGuard {
  readonly categoryId: string;
  readonly readVersion: number;
  readonly mustBeActive: boolean;
}

/**
 * Everything committed atomically with a change: its outbox events, its
 * idempotency result, and the category guard it depends on (section 18).
 */
export interface CommitOptions {
  readonly events: readonly OutboxEvent[];
  readonly idempotency?: CompletedRequest;
  readonly categoryGuard?: CategoryGuard;
}
