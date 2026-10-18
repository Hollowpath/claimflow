import { idSchema } from '@claimflow/contracts';
import type { Claim, ClaimHistoryEntry, ClaimStatus } from '@claimflow/domain';

import { ValidationError } from '../../application/errors.js';
import {
  claimIndexAttributes,
  claimKey,
  historyKey,
  isIsoTimestamp,
} from './dynamodb-items.js';
import { canonicalJson } from './transaction-token.js';

/**
 * Version 1 pagination cursors (docs/aws-architecture.md, section 13):
 * base64url-encoded canonical JSON naming the list, its index, and the key of
 * the last item returned. A cursor becomes an `ExclusiveStartKey` only after
 * every check against the requested list has passed.
 */

export const maxCursorLength = 512;

/** The list a page belongs to, with the values that bind its cursor. */
export type CursorList =
  | { readonly list: 'employee'; readonly employeeId: string }
  | { readonly list: 'queue'; readonly managerId: string }
  | { readonly list: 'status'; readonly status: ClaimStatus }
  | { readonly list: 'all' }
  | { readonly list: 'history'; readonly claimId: string };

/** The cursor `index` of each list; `table` is the base table. */
export const cursorIndexes = {
  employee: 'GSI1',
  queue: 'GSI2',
  status: 'GSI3',
  all: 'GSI4',
  history: 'table',
} as const;

export type ExclusiveStartKey = Readonly<Record<string, string>>;

/** The cursor for the page after `claim` in a claim list. */
export function encodeClaimCursor(
  list: Exclude<CursorList, { list: 'history' }>,
  claim: Claim,
): string {
  const index = cursorIndexes[list.list];
  const indexes = claimIndexAttributes(claim);
  const partition = indexes[`${index}PK`];
  const sort = indexes[`${index}SK`];
  if (partition === undefined || sort === undefined) {
    throw new RangeError(`The claim is not in ${index}.`);
  }
  return encodeCursor(list, {
    ...claimKey(claim.claimId),
    [`${index}PK`]: partition,
    [`${index}SK`]: sort,
  });
}

/** The cursor for the page after `entry` in a claim's history. */
export function encodeHistoryCursor(entry: ClaimHistoryEntry): string {
  return encodeCursor(
    { list: 'history', claimId: entry.claimId },
    historyKey(entry.claimId, entry.version),
  );
}

function encodeCursor(list: CursorList, key: ExclusiveStartKey): string {
  const cursor = Buffer.from(
    canonicalJson({
      v: 1,
      list: list.list,
      index: cursorIndexes[list.list],
      key,
    }),
    'utf8',
  ).toString('base64url');
  if (cursor.length > maxCursorLength) {
    throw new RangeError('The cursor would exceed 512 characters.');
  }
  return cursor;
}

/**
 * The `ExclusiveStartKey` a cursor stands for, if it is a valid cursor for
 * exactly this list; otherwise `ValidationError` with `INVALID_CURSOR`.
 */
export function decodeCursor(
  cursor: string,
  list: CursorList,
): ExclusiveStartKey {
  if (cursor.length === 0 || cursor.length > maxCursorLength) {
    throw invalidCursor();
  }
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  // Node decodes base64url leniently, so only the exact re-encoding counts.
  if (Buffer.from(text, 'utf8').toString('base64url') !== cursor) {
    throw invalidCursor();
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
    // Whitespace, key order, duplicate keys, or escapes the encoder would
    // not have produced make the cursor non-canonical.
    if (canonicalJson(envelope) !== text) {
      throw invalidCursor();
    }
  } catch {
    throw invalidCursor();
  }

  if (
    !isRecord(envelope) ||
    !hasExactly(envelope, ['index', 'key', 'list', 'v']) ||
    envelope.v !== 1 ||
    envelope.list !== list.list ||
    envelope.index !== cursorIndexes[list.list] ||
    !isRecord(envelope.key)
  ) {
    throw invalidCursor();
  }
  const key = envelope.key;
  const expected = expectedKeyShape(list);
  if (
    !hasExactly(key, Object.keys(expected)) ||
    !Object.values(key).every((value) => typeof value === 'string')
  ) {
    throw invalidCursor();
  }
  const values = key as Record<string, string>;
  for (const [name, valid] of Object.entries(expected)) {
    if (!valid(values[name] ?? '', values)) {
      throw invalidCursor();
    }
  }
  return { ...values };
}

type KeyCheck = (
  value: string,
  key: Readonly<Record<string, string>>,
) => boolean;

const isId = (value: string) => idSchema.safeParse(value).success;

/** `CLAIM#<id>` */
const claimPartition: KeyCheck = (value) =>
  value.startsWith('CLAIM#') && isId(value.slice('CLAIM#'.length));

/** `<ISO-8601 instant>#<id>`, where the ID is the claim in `PK`. */
const activitySortKey: KeyCheck = (value, key) => {
  const separator = value.indexOf('#');
  return (
    separator > 0 &&
    isIsoTimestamp(value.slice(0, separator)) &&
    `CLAIM#${value.slice(separator + 1)}` === key.PK
  );
};

/** The attributes a list's cursor key must have, each with its check. */
function expectedKeyShape(list: CursorList): Record<string, KeyCheck> {
  const equals =
    (expected: string): KeyCheck =>
    (value) =>
      value === expected;
  switch (list.list) {
    case 'employee':
      return claimIndexShape('GSI1', `EMPLOYEE#${list.employeeId}`);
    case 'queue':
      return claimIndexShape('GSI2', `MANAGER#${list.managerId}#OPEN`);
    case 'status':
      return claimIndexShape('GSI3', `STATUS#${list.status}`);
    case 'all':
      return claimIndexShape('GSI4', 'CLAIM');
    case 'history':
      return {
        PK: equals(`CLAIM#${list.claimId}`),
        SK: (value) =>
          /^HISTORY#\d{10}$/.test(value) && value !== 'HISTORY#0000000000',
      };
  }

  function claimIndexShape(
    index: string,
    partition: string,
  ): Record<string, KeyCheck> {
    return {
      PK: claimPartition,
      SK: equals('CLAIM'),
      [`${index}PK`]: equals(partition),
      [`${index}SK`]: activitySortKey,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactly(value: object, names: readonly string[]): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === names.length && names.every((name) => keys.includes(name))
  );
}

/** The same error, and message, as the local runtime's cursors. */
function invalidCursor(): ValidationError {
  return new ValidationError('The page cursor is not valid.', [
    {
      field: 'cursor',
      code: 'INVALID_CURSOR',
      message: 'Start again from the first page.',
    },
  ]);
}
