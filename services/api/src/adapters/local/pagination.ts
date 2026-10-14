import { ValidationError } from '../../application/errors.js';
import type { Page, PageRequest } from '../../application/ports.js';

/**
 * Cursor pagination over items already sorted by a unique, string-comparable
 * key. The cursor is opaque to clients and bound to the list it came from, so
 * items added or removed between pages never cause skips or repeats.
 */
export function paginate<T>(
  sorted: readonly T[],
  keyOf: (item: T) => string,
  direction: 'asc' | 'desc',
  page: PageRequest,
  listName: string,
): Page<T> {
  const after =
    page.cursor === undefined ? undefined : decode(page.cursor, listName);
  const remaining =
    after === undefined
      ? sorted
      : sorted.filter((item) =>
          direction === 'asc' ? keyOf(item) > after : keyOf(item) < after,
        );
  const items = remaining.slice(0, page.limit);
  const last = items.at(-1);
  return remaining.length > page.limit && last !== undefined
    ? { items, nextCursor: encode(listName, keyOf(last)) }
    : { items };
}

export function compareKeys(direction: 'asc' | 'desc') {
  return (a: string, b: string) =>
    direction === 'asc' ? compare(a, b) : compare(b, a);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function encode(list: string, after: string): string {
  return Buffer.from(JSON.stringify({ l: list, a: after })).toString(
    'base64url',
  );
}

function decode(cursor: string, list: string): string {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as { l?: unknown; a?: unknown };
    if (parsed.l === list && typeof parsed.a === 'string') {
      return parsed.a;
    }
  } catch {
    // Fall through to the validation error below.
  }
  throw new ValidationError('The page cursor is not valid.', [
    {
      field: 'cursor',
      code: 'INVALID_CURSOR',
      message: 'Start again from the first page.',
    },
  ]);
}
