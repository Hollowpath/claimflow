import { idempotencyKeySchema, idSchema } from '@claimflow/contracts';

import {
  expiresAfter,
  isResultReference,
  type CompletedRequest,
  type PersistedResult,
} from '../../application/commit.js';
import { idempotencyRetentionMs } from '../../application/idempotency.js';
import type { StoredResponse } from '../../application/ports.js';
import {
  AttributeReader,
  failWith,
  ItemEncodingError,
  ItemIntegrityError,
  type DynamoItem,
  type Fail,
} from './dynamodb-items.js';

/**
 * Pure codecs for idempotency records (docs/aws-architecture.md, sections 7
 * and 10): the stored result of a request, keyed by the actor and the
 * client's idempotency key.
 */

export const idempotencyEntityType = 'IdempotencyRecord';

/**
 * A stored result: `COMPLETED` for a committed success (2xx), which may be a
 * response snapshot or a result reference, `REJECTED` for a business
 * rejection (4xx), which is always a response snapshot, stored so that
 * retries get the same answer.
 */
export type IdempotencyRecord =
  | (CompletedRequest & { readonly outcome: 'COMPLETED' })
  | (Omit<CompletedRequest, 'response'> & {
      readonly outcome: 'REJECTED';
      readonly response: StoredResponse;
    });

export type IdempotencyOutcome = IdempotencyRecord['outcome'];

/** DynamoDB allows 32 levels of nesting; the body sits two levels down. */
const maxBodyDepth = 30;
/** UTF-8 bytes of canonical JSON; keeps a record inside DynamoDB's 400 KB. */
export const maxResponseBodyBytes = 300 * 1024;
const fingerprintPattern = /^[a-f0-9]{64}$/;

export function idempotencyKey(actorId: string, key: string) {
  return { PK: `IDEMPOTENCY#${actorId}#${key}`, SK: 'IDEMPOTENCY' } as const;
}

/**
 * The condition on every idempotency `Put` (section 9), with `:nowEpoch` the
 * current time in epoch seconds: no record exists, or the existing one has
 * expired. The strict `<` matches the lookup, so a record expiring exactly
 * now still counts as present.
 */
export const idempotencyWriteCondition =
  'attribute_not_exists(PK) OR expiresAt < :nowEpoch';

const recordAttributes = new Set([
  'PK',
  'SK',
  'entityType',
  'fingerprint',
  'outcome',
  'response',
  'createdAt',
  'expiresAt',
]);

export function encodeIdempotencyItem(record: IdempotencyRecord): DynamoItem {
  const { response } = record;
  const item: DynamoItem = {
    ...idempotencyKey(record.actorId, record.key),
    entityType: idempotencyEntityType,
    fingerprint: record.fingerprint,
    outcome: record.outcome,
    response: encodeResponse(response),
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
  readRecord(item, failWith(ItemEncodingError, item));
  return item;
}

export function decodeIdempotencyItem(item: DynamoItem): IdempotencyRecord {
  return readRecord(item, failWith(ItemIntegrityError, item));
}

function readRecord(item: DynamoItem, fail: Fail): IdempotencyRecord {
  const read = new AttributeReader(item, fail);
  read.noIndexes();
  read.allowOnly(recordAttributes);
  read.entityType(idempotencyEntityType);

  const [actorId, key] = splitPartitionKey(item.PK, fail);
  read.keys(idempotencyKey(actorId, key));

  const fingerprint = read.check('fingerprint', (value) =>
    fingerprintPattern.test(value),
  );
  const outcome = read.oneOf<IdempotencyOutcome>('outcome', [
    'COMPLETED',
    'REJECTED',
  ]);
  const createdAt = read.timestamp('createdAt');
  const expiresAt = read.positiveInteger('expiresAt');
  if (expiresAt !== expiresAfter(new Date(createdAt), idempotencyRetentionMs)) {
    fail('expiresAt must be exactly 24 hours after createdAt');
  }

  const response = readResponse(read.map('response'), outcome, fail);
  const common = { actorId, key, fingerprint, createdAt, expiresAt };
  if (outcome === 'COMPLETED') {
    return { ...common, outcome, response };
  }
  if (isResultReference(response)) {
    return fail('response.resultRef is only valid for a COMPLETED 201 result');
  }
  return { ...common, outcome, response };
}

/**
 * The attribute map of a persisted result. A mixed shape (a body together with
 * a reference) is kept as supplied so that the codec check below refuses it.
 */
function encodeResponse(response: PersistedResult): DynamoItem {
  if (isResultReference(response)) {
    const { body } = response as { body?: unknown };
    return {
      status: response.status,
      resultRef: response.resultRef,
      ...(body === undefined ? {} : { body }),
    };
  }
  return response.body === undefined
    ? { status: response.status }
    : { status: response.status, body: response.body };
}

/** `IDEMPOTENCY#<actorId>#<key>`: neither part may contain `#`. */
function splitPartitionKey(pk: unknown, fail: Fail): [string, string] {
  if (typeof pk !== 'string' || !pk.startsWith('IDEMPOTENCY#')) {
    return fail('its key is not an idempotency key');
  }
  const [actorId = '', key = '', ...rest] = pk
    .slice('IDEMPOTENCY#'.length)
    .split('#');
  if (rest.length > 0 || !idSchema.safeParse(actorId).success) {
    return fail('its key does not name a valid actor');
  }
  if (!idempotencyKeySchema.safeParse(key).success) {
    return fail('its key does not hold a valid idempotency key');
  }
  return [actorId, key];
}

/**
 * Completed results are 2xx and rejected results 4xx. A 204 response has no
 * body; every other response has a JSON-compatible body. A result reference
 * is valid only for a completed 201 result, has no body, and holds exactly
 * one receipt ID.
 */
function readResponse(
  read: AttributeReader,
  outcome: IdempotencyOutcome,
  fail: Fail,
): PersistedResult {
  read.allowOnly(new Set(['status', 'body', 'resultRef']));
  const status = read.positiveInteger('status');
  if (read.has('resultRef')) {
    if (outcome !== 'COMPLETED' || status !== 201) {
      fail('response.resultRef is only valid for a COMPLETED 201 result');
    }
    if (read.has('body')) {
      fail('response.body must be absent with response.resultRef');
    }
    const reference = read.map('resultRef');
    reference.allowOnly(new Set(['receiptId']));
    return { status: 201, resultRef: { receiptId: reference.id('receiptId') } };
  }
  const [low, high] = outcome === 'COMPLETED' ? [200, 299] : [400, 499];
  if (status < low || status > high) {
    fail(`response.status is not valid for a ${outcome} result`);
  }
  if (status === 204) {
    if (read.has('body')) {
      fail('response.body must be absent for status 204');
    }
    return { status, body: undefined };
  }
  if (!read.has('body')) {
    fail('response.body is missing');
  }
  const body = read.json('body', maxBodyDepth, maxResponseBodyBytes);
  return { status, body };
}
