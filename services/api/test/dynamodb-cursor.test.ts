import type { Claim } from '@claimflow/domain';
import { describe, expect, it } from 'vitest';

import {
  cursorIndexes,
  decodeCursor,
  encodeClaimCursor,
  encodeHistoryCursor,
  maxCursorLength,
  type CursorList,
} from '../src/adapters/aws/dynamodb-cursor.js';
import { canonicalJson } from '../src/adapters/aws/transaction-token.js';
import { ValidationError } from '../src/application/errors.js';

const claimId = '4ce0c74b-9c64-46d6-87ba-07fb71b0628c';
const at = '2026-10-14T10:41:00.000Z';

const claim: Claim = {
  claimId,
  employeeId: 'sub-aisha',
  assignedManagerId: 'sub-ben',
  status: 'SUBMITTED',
  version: 4,
  createdAt: '2026-10-14T10:30:00.000Z',
  updatedAt: at,
  submittedAt: at,
};

const employee: CursorList = { list: 'employee', employeeId: 'sub-aisha' };
const queue: CursorList = { list: 'queue', managerId: 'sub-ben' };
const submitted: CursorList = { list: 'status', status: 'SUBMITTED' };
const all: CursorList = { list: 'all' };
const history: CursorList = { list: 'history', claimId };

const claimTableKey = { PK: `CLAIM#${claimId}`, SK: 'CLAIM' };
const activity = `${at}#${claimId}`;

/** Builds a canonically encoded cursor from any envelope. */
const craft = (envelope: unknown) =>
  Buffer.from(canonicalJson(envelope), 'utf8').toString('base64url');

const envelopeOf = (cursor: string): unknown =>
  JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));

function expectInvalid(cursor: string, list: CursorList) {
  let error: unknown;
  try {
    decodeCursor(cursor, list);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(ValidationError);
  expect((error as ValidationError).details).toEqual([
    {
      field: 'cursor',
      code: 'INVALID_CURSOR',
      message: 'Start again from the first page.',
    },
  ]);
}

describe('cursor encoding', () => {
  it('is base64url canonical JSON in the approved version 1 format', () => {
    const cursor = encodeClaimCursor(employee, claim);

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor.length).toBeLessThanOrEqual(maxCursorLength);
    expect(envelopeOf(cursor)).toEqual({
      v: 1,
      list: 'employee',
      index: 'GSI1',
      key: {
        PK: `CLAIM#${claimId}`,
        SK: 'CLAIM',
        GSI1PK: 'EMPLOYEE#sub-aisha',
        GSI1SK: activity,
      },
    });
    expect(Buffer.from(cursor, 'base64url').toString('utf8')).toBe(
      canonicalJson(envelopeOf(cursor)),
    );
  });

  it.each<[string, CursorList, Record<string, string>]>([
    [
      'employee',
      employee,
      { ...claimTableKey, GSI1PK: 'EMPLOYEE#sub-aisha', GSI1SK: activity },
    ],
    [
      'queue',
      queue,
      { ...claimTableKey, GSI2PK: 'MANAGER#sub-ben#OPEN', GSI2SK: activity },
    ],
    [
      'status',
      submitted,
      { ...claimTableKey, GSI3PK: 'STATUS#SUBMITTED', GSI3SK: activity },
    ],
    ['all', all, { ...claimTableKey, GSI4PK: 'CLAIM', GSI4SK: activity }],
  ])('round-trips the %s list key', (_name, list, key) => {
    const cursor = encodeClaimCursor(
      list as Exclude<CursorList, { list: 'history' }>,
      claim,
    );

    expect(envelopeOf(cursor)).toMatchObject({
      list: list.list,
      index: cursorIndexes[list.list],
    });
    expect(decodeCursor(cursor, list)).toEqual(key);
  });

  it('round-trips the history key on the base table', () => {
    const cursor = encodeHistoryCursor({
      claimId,
      version: 12,
      action: 'UPDATE',
      toStatus: 'DRAFT',
      actorId: 'sub-aisha',
      occurredAt: at,
    });

    expect(envelopeOf(cursor)).toMatchObject({
      list: 'history',
      index: 'table',
    });
    expect(decodeCursor(cursor, history)).toEqual({
      PK: `CLAIM#${claimId}`,
      SK: 'HISTORY#0000000012',
    });
  });

  it('refuses a queue cursor for a claim that is not open', () => {
    expect(() =>
      encodeClaimCursor(queue as Exclude<CursorList, { list: 'history' }>, {
        ...claim,
        status: 'APPROVED',
      }),
    ).toThrow(RangeError);
  });
});

describe('cursor validation', () => {
  const valid = {
    v: 1,
    list: 'employee',
    index: 'GSI1',
    key: { ...claimTableKey, GSI1PK: 'EMPLOYEE#sub-aisha', GSI1SK: activity },
  };
  const withKey = (changes: Record<string, unknown>) => ({
    ...valid,
    key: { ...valid.key, ...changes },
  });

  it('accepts a well-formed cursor', () => {
    expect(decodeCursor(craft(valid), employee)).toEqual(valid.key);
  });

  it.each<[string, string]>([
    ['an empty cursor', ''],
    ['a cursor over 512 characters', 'A'.repeat(maxCursorLength + 1)],
    ['characters outside base64url', `${craft(valid).slice(0, -2)}+/`],
    ['base64 padding', `${craft(valid)}==`],
    ['text that is not JSON', Buffer.from('not json').toString('base64url')],
    [
      'JSON with whitespace',
      Buffer.from(JSON.stringify(valid, null, 1)).toString('base64url'),
    ],
    [
      'JSON with keys out of canonical order',
      Buffer.from(
        JSON.stringify({
          v: 1,
          list: 'employee',
          index: 'GSI1',
          key: valid.key,
        }),
      ).toString('base64url'),
    ],
    [
      'a duplicated JSON key',
      Buffer.from(
        canonicalJson(valid).replace('"v":1', '"v":1,"v":1'),
      ).toString('base64url'),
    ],
    ['a JSON array', craft([valid])],
    ['a JSON string', craft('cursor')],
  ])('rejects %s', (_name, cursor) => {
    expectInvalid(cursor, employee);
  });

  it('rejects a cursor longer than 512 characters before decoding it', () => {
    const long = craft(withKey({ GSI1SK: `${at}#${'a'.repeat(400)}` }));

    expect(long.length).toBeGreaterThan(maxCursorLength);
    expectInvalid(long, employee);
  });

  it.each<[string, unknown]>([
    ['a missing version', { list: 'employee', index: 'GSI1', key: valid.key }],
    ['an extra envelope field', { ...valid, sig: 'x' }],
    ['version 2', { ...valid, v: 2 }],
    ['the version as text', { ...valid, v: '1' }],
    ['another list', { ...valid, list: 'queue' }],
    ['another index', { ...valid, index: 'GSI3' }],
    ['a key that is not an object', { ...valid, key: 'CLAIM' }],
    ['a key that is a list', { ...valid, key: [valid.key] }],
    [
      'a missing key attribute',
      { ...valid, key: { ...claimTableKey, GSI1PK: 'EMPLOYEE#sub-aisha' } },
    ],
    ['an extra key attribute', withKey({ GSI2PK: 'MANAGER#sub-ben#OPEN' })],
    ['a numeric key value', withKey({ SK: 1 })],
    ['a null key value', withKey({ GSI1SK: null })],
    ['another partition', withKey({ GSI1PK: 'EMPLOYEE#sub-ravi' })],
    ['the outbox partition', withKey({ GSI1PK: 'OUTBOX#PENDING' })],
    ['a table key outside claims', withKey({ PK: 'CATEGORIES' })],
    ['a claim ID that cannot be a key', withKey({ PK: 'CLAIM#a#b' })],
    ['a history sort key', withKey({ SK: 'HISTORY#0000000001' })],
    ['a sort key without a timestamp', withKey({ GSI1SK: `#${claimId}` })],
    ['a date-only sort key', withKey({ GSI1SK: `2026-10-14#${claimId}` })],
    [
      'a sort key for another claim',
      withKey({ GSI1SK: `${at}#00000000-9c64-46d6-87ba-07fb71b0628c` }),
    ],
  ])('rejects %s', (_name, envelope) => {
    expectInvalid(craft(envelope), employee);
  });

  it('binds claim cursors to the caller, the status, and the list', () => {
    const aisha = encodeClaimCursor(employee, claim);
    const status = encodeClaimCursor(submitted, claim);
    const everything = encodeClaimCursor(all, claim);

    expectInvalid(aisha, { list: 'employee', employeeId: 'sub-ravi' });
    expectInvalid(aisha, queue);
    expectInvalid(status, { list: 'status', status: 'APPROVED' });
    expectInvalid(status, all);
    expectInvalid(everything, submitted);
    expectInvalid(encodeClaimCursor(queue, claim), {
      list: 'queue',
      managerId: 'sub-chloe',
    });
  });

  it('binds history cursors to the claim and the history list', () => {
    const cursor = craft({
      v: 1,
      list: 'history',
      index: 'table',
      key: { PK: `CLAIM#${claimId}`, SK: 'HISTORY#0000000004' },
    });

    expect(decodeCursor(cursor, history)).toBeDefined();
    expectInvalid(cursor, { list: 'history', claimId: 'other-claim' });
    expectInvalid(cursor, employee);
  });

  it.each<[string, Record<string, unknown>]>([
    ['an unpadded version', { SK: 'HISTORY#4' }],
    ['version zero', { SK: 'HISTORY#0000000000' }],
    ['a claim sort key', { SK: 'CLAIM' }],
    ['an index attribute', { GSI1PK: 'EMPLOYEE#sub-aisha' }],
  ])('rejects a history cursor with %s', (_name, changes) => {
    expectInvalid(
      craft({
        v: 1,
        list: 'history',
        index: 'table',
        key: { PK: `CLAIM#${claimId}`, SK: 'HISTORY#0000000004', ...changes },
      }),
      history,
    );
  });
});
