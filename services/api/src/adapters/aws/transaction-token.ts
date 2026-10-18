import { createHash } from 'node:crypto';

/**
 * Deterministic `ClientRequestToken`s for `TransactWriteItems`
 * (docs/aws-architecture.md, section 8). The token depends only on its
 * inputs, never on time, randomness, or process state.
 */

/** A value that cannot be serialized canonically. */
export class UnsupportedCanonicalValueError extends Error {
  public constructor(path: string, problem: string) {
    super(`Cannot canonicalize ${path}: ${problem}.`);
    this.name = 'UnsupportedCanonicalValueError';
  }
}

/**
 * JSON with the keys of every object sorted, at every level, and arrays kept
 * in order. Only JSON values are accepted: `undefined`, functions, symbols,
 * big integers, non-finite numbers, sparse arrays, cycles, and objects other
 * than plain objects and arrays are rejected.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, '$', new Set());
}

function serialize(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): string {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new UnsupportedCanonicalValueError(path, 'not a finite number');
      }
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new UnsupportedCanonicalValueError(path, `a ${typeof value}`);
  }
  if (value === null) {
    return 'null';
  }
  if (ancestors.has(value)) {
    throw new UnsupportedCanonicalValueError(path, 'a cycle');
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw new UnsupportedCanonicalValueError(
            `${path}[${index}]`,
            'a missing array element',
          );
        }
        items.push(serialize(value[index], `${path}[${index}]`, ancestors));
      }
      return `[${items.join(',')}]`;
    }

    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new UnsupportedCanonicalValueError(path, 'not a plain object');
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new UnsupportedCanonicalValueError(path, 'a symbol key');
    }
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${serialize(record[key], `${path}.${key}`, ancestors)}`,
      );
    return `{${members.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

export interface TransactionTokenInput {
  /** The actor, or the consumer name for consumer transactions. */
  readonly actorId: string;
  /** The application idempotency key, or the event ID for consumers. */
  readonly idempotencyKey: string;
  /** The request fingerprint. */
  readonly fingerprint: string;
  /**
   * The complete `TransactWriteItems` input, without `ClientRequestToken`,
   * as JSON-compatible values.
   */
  readonly transaction: unknown;
}

/** `ClientRequestToken` allows at most 36 characters; this uses 32. */
export const transactionTokenLength = 32;

/**
 * The first 32 lowercase hexadecimal characters of SHA-256 over the actor ID,
 * idempotency key, fingerprint, and the SHA-256 of the canonical transaction.
 */
export function transactionRequestToken({
  actorId,
  idempotencyKey,
  fingerprint,
  transaction,
}: TransactionTokenInput): string {
  if (
    typeof transaction === 'object' &&
    transaction !== null &&
    'ClientRequestToken' in transaction
  ) {
    throw new UnsupportedCanonicalValueError(
      '$.ClientRequestToken',
      'the token cannot be part of its own payload',
    );
  }
  const transactionHash = sha256(canonicalJson(transaction));
  return sha256(
    canonicalJson([actorId, idempotencyKey, fingerprint, transactionHash]),
  ).slice(0, transactionTokenLength);
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
