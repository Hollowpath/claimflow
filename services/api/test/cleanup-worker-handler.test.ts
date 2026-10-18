import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { beforeEach, describe, expect, it } from 'vitest';

import { parseOutboxEnvelope } from '../src/adapters/aws/dynamodb-outbox-items.js';
import {
  createCleanupWorkerHandler,
  type CleanupWorkerDependencies,
} from '../src/adapters/aws/cleanup-worker-handler.js';
import { eventSource, type OutboxEvent } from '../src/application/events.js';

const claimId = '4ce0c74b-9c64-46d6-87ba-07fb71b0628c';
const at = '2026-10-14T11:05:00.000Z';

const header = (n: number) => ({
  eventId: `event-${String(n).padStart(4, '0')}`,
  schemaVersion: 1 as const,
  occurredAt: at,
  source: eventSource as typeof eventSource,
  correlationId: 'c0ffee00-1111-2222-3333-444455556667',
  causationId: 'request-8a41',
  actorId: 'sub-aisha',
});

const receiptDeletion = (n: number, receiptId = `r-${n}`): OutboxEvent => ({
  ...header(n),
  eventType: 'internal.receipt-object-deletion-requested',
  aggregate: {
    type: 'claim',
    id: claimId,
    version: 6,
    previousEventVersion: null,
  },
  payload: { claimId, receiptId, objectKey: `receipts/${receiptId}` },
});

const historyPurge = (n: number, id = claimId): OutboxEvent => ({
  ...header(n),
  eventType: 'internal.claim-history-purge-requested',
  aggregate: { type: 'claim', id, version: 2, previousEventVersion: null },
  payload: { claimId: id },
});

const submitted: OutboxEvent = {
  ...header(9),
  eventType: 'claim.submitted',
  aggregate: {
    type: 'claim',
    id: claimId,
    version: 4,
    previousEventVersion: null,
  },
  payload: {
    claimId,
    employeeId: 'sub-aisha',
    assignedManagerId: 'sub-ben',
    categoryId: 'travel',
    amount: { amountMinor: 45_000, currency: 'MYR' },
    submittedAt: at,
  },
};

/** The EventBridge event as an SQS target receives it. */
const wrapper = (event: unknown, overrides: Record<string, unknown> = {}) => ({
  version: '0',
  id: 'a4f2b5c1-0000-4000-8000-000000000001',
  'detail-type': (event as { eventType?: string }).eventType,
  source: 'claimflow.api',
  account: '123456789012',
  time: at,
  region: 'ap-southeast-1',
  resources: [],
  detail: event,
  ...overrides,
});

function sqsRecord(messageId: string | undefined, body: string): SQSRecord {
  return {
    messageId: messageId as string,
    receiptHandle: `handle-${String(messageId)}`,
    body,
    attributes: {
      ApproximateReceiveCount: '1',
      SentTimestamp: '1792000000000',
      SenderId: 'AIDAEXAMPLE',
      ApproximateFirstReceiveTimestamp: '1792000000001',
    },
    messageAttributes: {},
    md5OfBody: 'd41d8cd98f00b204e9800998ecf8427e',
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:ap-southeast-1:123456789012:claimflow-cleanup',
    awsRegion: 'ap-southeast-1',
  };
}

const message = (
  id: string,
  event: unknown,
  overrides: Record<string, unknown> = {},
) => sqsRecord(id, JSON.stringify(wrapper(event, overrides)));

const sqsEvent = (...records: SQSRecord[]): SQSEvent => ({ Records: records });

class FakeDependencies implements CleanupWorkerDependencies {
  public readonly finals: string[] = [];
  public readonly pendings: string[] = [];
  public readonly purges: string[] = [];
  public failFinal = new Set<string>();
  public failPurge = new Set<string>();

  public objects = {
    deleteFinal: (receiptId: string): Promise<void> => {
      this.finals.push(receiptId);
      return this.failFinal.has(receiptId)
        ? Promise.reject(new Error(`denied ${receiptId}`))
        : Promise.resolve();
    },
  };

  public history = {
    purge: (id: string): Promise<void> => {
      this.purges.push(id);
      return this.failPurge.has(id)
        ? Promise.reject(new Error(`throttled ${id}`))
        : Promise.resolve();
    },
  };
}

let deps: FakeDependencies;
let handler: ReturnType<typeof createCleanupWorkerHandler>;

beforeEach(() => {
  deps = new FakeDependencies();
  handler = createCleanupWorkerHandler(deps);
});

const failures = (...ids: string[]) => ({
  batchItemFailures: ids.map((itemIdentifier) => ({ itemIdentifier })),
});
const nothingDone = () =>
  expect([deps.finals, deps.pendings, deps.purges].flat()).toEqual([]);

describe('routing', () => {
  it('routes a receipt deletion to the final-object deletion only', async () => {
    expect(
      await handler(sqsEvent(message('m-1', receiptDeletion(1, 'r-7731')))),
    ).toEqual(failures());

    expect(deps.finals).toEqual(['r-7731']);
    expect(deps.pendings).toEqual([]);
    expect(deps.purges).toEqual([]);
  });

  it('routes a history purge to the purger', async () => {
    expect(await handler(sqsEvent(message('m-1', historyPurge(1))))).toEqual(
      failures(),
    );

    expect(deps.purges).toEqual([claimId]);
    expect(deps.finals).toEqual([]);
  });

  it('processes a mixed batch, each record on its own', async () => {
    const response = await handler(
      sqsEvent(
        message('m-1', receiptDeletion(1)),
        message('m-2', historyPurge(2)),
        message('m-3', receiptDeletion(3)),
      ),
    );

    expect(response).toEqual(failures());
    expect(deps.finals.sort()).toEqual(['r-1', 'r-3']);
    expect(deps.purges).toEqual([claimId]);
  });

  it('accepts an empty batch', async () => {
    expect(await handler(sqsEvent())).toEqual(failures());
    expect(await handler({} as SQSEvent)).toEqual(failures());
    nothingDone();
  });

  it('is harmless on duplicate delivery', async () => {
    const duplicate = message('m-1', receiptDeletion(1));

    expect(
      await handler(sqsEvent(duplicate, { ...duplicate, messageId: 'm-2' })),
    ).toEqual(failures());
    expect(await handler(sqsEvent(duplicate))).toEqual(failures());
    expect(deps.finals).toEqual(['r-1', 'r-1', 'r-1']);
  });

  it('accepts the optional replay name', async () => {
    expect(
      await handler(
        sqsEvent(
          message('m-1', historyPurge(1), { 'replay-name': 'replay-1' }),
        ),
      ),
    ).toEqual(failures());
  });
});

describe('bodies', () => {
  it.each<[string, string]>([
    ['malformed JSON', '{not json'],
    ['an empty body', ''],
    ['null', 'null'],
    ['a number', '42'],
    ['a string', '"hello"'],
    ['a list', '[]'],
    ['an object with no fields', '{}'],
  ])('fails only the record with %s', async (_name, body) => {
    const response = await handler(
      sqsEvent(
        message('m-1', historyPurge(1)),
        sqsRecord('m-2', body),
        message('m-3', receiptDeletion(3)),
      ),
    );

    expect(response).toEqual(failures('m-2'));
    expect(deps.purges).toHaveLength(1);
    expect(deps.finals).toEqual(['r-3']);
  });

  it('fails a record whose body is not a string', async () => {
    const record = {
      ...sqsRecord('m-1', ''),
      body: undefined as unknown as string,
    };

    expect(await handler(sqsEvent(record))).toEqual(failures('m-1'));
  });
});

describe('the EventBridge wrapper', () => {
  const event = () => historyPurge(1);
  const without = (name: string) => {
    const copy: Record<string, unknown> = wrapper(event());
    delete copy[name];
    return sqsRecord('m-1', JSON.stringify(copy));
  };

  it.each([
    'version',
    'id',
    'detail-type',
    'source',
    'account',
    'time',
    'region',
    'resources',
    'detail',
  ])('rejects a wrapper without %s', async (name) => {
    expect(await handler(sqsEvent(without(name)))).toEqual(failures('m-1'));
    nothingDone();
  });

  it.each<[string, Record<string, unknown>]>([
    ['another version', { version: '1' }],
    ['another source', { source: 'aws.events' }],
    ['a different source casing', { source: 'ClaimFlow.api' }],
    ['a detail type that is not a string', { 'detail-type': 7 }],
    ['resources that are not a list', { resources: 'none' }],
    ['an unexpected field', { extra: true }],
    ['a detail that is not an object', { detail: 'purge' }],
    ['a null detail', { detail: null }],
    ['a list detail', { detail: [] }],
  ])('rejects a wrapper with %s', async (_name, override) => {
    expect(await handler(sqsEvent(message('m-1', event(), override)))).toEqual(
      failures('m-1'),
    );
    nothingDone();
  });

  it.each<[string, Record<string, unknown>]>([
    ['an empty id', { id: '' }],
    ['a numeric id', { id: 7 }],
    ['a missing-length account', { account: '12345678901' }],
    ['a too long account', { account: '1234567890123' }],
    ['a non-digit account', { account: '12345678901a' }],
    ['a numeric account', { account: 123_456_789_012 }],
    ['an empty time', { time: '' }],
    ['a date-only time', { time: '2026-10-14' }],
    ['a time without a zone', { time: '2026-10-14T11:05:00' }],
    ['a time with a space', { time: '2026-10-14 11:05:00Z' }],
    ['an impossible date', { time: '2026-02-30T11:05:00Z' }],
    ['an impossible hour', { time: '2026-10-14T24:05:00Z' }],
    ['an impossible minute', { time: '2026-10-14T11:60:00Z' }],
    ['an impossible second', { time: '2026-10-14T11:05:60Z' }],
    ['an impossible offset', { time: '2026-10-14T11:05:00+24:00' }],
    ['a numeric time', { time: 1_792_000_000 }],
    ['an empty region', { region: '' }],
    ['a numeric region', { region: 1 }],
    ['a numeric resource', { resources: ['arn:aws:x', 7] }],
    ['a null resource', { resources: [null] }],
    ['an empty replay name', { 'replay-name': '' }],
    ['a numeric replay name', { 'replay-name': 5 }],
    ['a null replay name', { 'replay-name': null }],
  ])('rejects a wrapper with %s', async (_name, override) => {
    expect(
      await handler(sqsEvent(message('m-1', historyPurge(1), override))),
    ).toEqual(failures('m-1'));
    nothingDone();
  });

  it.each([
    '2026-10-14T11:05:00Z',
    '2026-10-14T11:05:00.000Z',
    '2026-10-14T11:05:00.123456Z',
    '2026-10-14T19:05:00+08:00',
    '2024-02-29T00:00:00Z',
  ])('accepts the EventBridge time %s', async (time) => {
    expect(
      await handler(sqsEvent(message('m-1', historyPurge(1), { time }))),
    ).toEqual(failures());
    expect(deps.purges).toEqual([claimId]);
  });

  it('accepts resources that are strings, and a non-empty replay name', async () => {
    const response = await handler(
      sqsEvent(
        message('m-1', historyPurge(1), {
          resources: [
            'arn:aws:events:ap-southeast-1:123456789012:rule/claimflow-cleanup',
          ],
          'replay-name': 'replay-1',
        }),
      ),
    );

    expect(response).toEqual(failures());
  });

  it('keeps wrapper errors fixed and value-free', async () => {
    const response = await handler(
      sqsEvent(
        message('m-1', historyPurge(1), { account: 'Salary review', id: '' }),
      ),
    );

    expect(JSON.stringify(response)).toBe(
      '{"batchItemFailures":[{"itemIdentifier":"m-1"}]}',
    );
  });

  it('rejects a detail type that does not match the event', async () => {
    const response = await handler(
      sqsEvent(
        message('m-1', historyPurge(1), {
          'detail-type': 'internal.receipt-object-deletion-requested',
        }),
      ),
    );

    expect(response).toEqual(failures('m-1'));
    nothingDone();
  });
});

describe('the embedded event', () => {
  it('rejects publishable events, even with a matching detail type', async () => {
    expect(await handler(sqsEvent(message('m-1', submitted)))).toEqual(
      failures('m-1'),
    );
    nothingDone();
  });

  it('rejects an unknown event type', async () => {
    const unknown = {
      ...historyPurge(1),
      eventType: 'internal.everything-requested',
    };

    expect(await handler(sqsEvent(message('m-1', unknown)))).toEqual(
      failures('m-1'),
    );
    nothingDone();
  });

  it.each<[string, (e: Record<string, unknown>) => unknown]>([
    ['an extra field', (e) => ({ ...e, extra: 1 })],
    [
      'a missing field',
      (e) =>
        Object.fromEntries(
          Object.entries(e).filter(([k]) => k !== 'causationId'),
        ),
    ],
    ['schema version 2', (e) => ({ ...e, schemaVersion: 2 })],
    ['another source', (e) => ({ ...e, source: 'elsewhere' })],
    ['a bad timestamp', (e) => ({ ...e, occurredAt: '2026-10-14' })],
    ['a bad trace ID', (e) => ({ ...e, correlationId: 'not valid!' })],
    ['a bad event ID', (e) => ({ ...e, eventId: 'a#b' })],
    ['a bad actor', (e) => ({ ...e, actorId: 'sub aisha' })],
    ['a missing aggregate', (e) => ({ ...e, aggregate: null })],
    [
      'a wrong aggregate type',
      (e) => ({
        ...e,
        aggregate: { ...(e.aggregate as object), type: 'category' },
      }),
    ],
    [
      'a previous event version on an internal event',
      (e) => ({
        ...e,
        aggregate: { ...(e.aggregate as object), previousEventVersion: 1 },
      }),
    ],
    [
      'an extra aggregate field',
      (e) => ({ ...e, aggregate: { ...(e.aggregate as object), name: 'x' } }),
    ],
    [
      'a payload for another claim',
      (e) => ({ ...e, payload: { claimId: 'other-claim' } }),
    ],
    [
      'an extra payload field',
      (e) => ({
        ...e,
        payload: { ...(e.payload as object), fileName: 'x.pdf' },
      }),
    ],
    ['a missing payload', (e) => ({ ...e, payload: undefined })],
  ])('rejects a purge event with %s', async (_name, change) => {
    const bad = change(historyPurge(1) as unknown as Record<string, unknown>);

    expect(await handler(sqsEvent(message('m-1', bad)))).toEqual(
      failures('m-1'),
    );
    nothingDone();
  });

  it.each<[string, (e: Record<string, unknown>) => unknown]>([
    [
      'another object key',
      (e) => ({
        ...e,
        payload: { ...(e.payload as object), objectKey: 'uploads/pending/r-1' },
      }),
    ],
    [
      'a receipt ID with a path',
      (e) => ({
        ...e,
        payload: { claimId, receiptId: '../r-1', objectKey: 'receipts/../r-1' },
      }),
    ],
    [
      'a missing receipt ID',
      (e) => ({ ...e, payload: { claimId, objectKey: 'receipts/r-1' } }),
    ],
    [
      'a payload for another claim',
      (e) => ({
        ...e,
        payload: { ...(e.payload as object), claimId: 'other-claim' },
      }),
    ],
  ])('rejects a receipt deletion with %s', async (_name, change) => {
    const bad = change(
      receiptDeletion(1) as unknown as Record<string, unknown>,
    );

    expect(await handler(sqsEvent(message('m-1', bad)))).toEqual(
      failures('m-1'),
    );
    nothingDone();
  });

  it('validates with the outbox codec rules', () => {
    expect(parseOutboxEnvelope(receiptDeletion(1))).toEqual(receiptDeletion(1));
    expect(() =>
      parseOutboxEnvelope({ ...receiptDeletion(1), extra: 1 }),
    ).toThrow();
    expect(() => parseOutboxEnvelope(null)).toThrow();
    expect(() => parseOutboxEnvelope([])).toThrow();
  });
});

describe('dependency failures', () => {
  it('fails a record whose final-object deletion fails, and continues', async () => {
    deps.failFinal.add('r-2');

    const response = await handler(
      sqsEvent(
        message('m-1', receiptDeletion(1)),
        message('m-2', receiptDeletion(2)),
        message('m-3', historyPurge(3)),
      ),
    );

    expect(response).toEqual(failures('m-2'));
    expect(deps.finals.sort()).toEqual(['r-1', 'r-2']);
    expect(deps.purges).toEqual([claimId]);
  });

  it('fails a record whose purge fails', async () => {
    deps.failPurge.add(claimId);

    expect(
      await handler(
        sqsEvent(
          message('m-1', historyPurge(1)),
          message('m-2', receiptDeletion(2)),
        ),
      ),
    ).toEqual(failures('m-1'));
    expect(deps.finals).toEqual(['r-2']);
  });

  it('fails a record whose dependency throws synchronously', async () => {
    const sync = createCleanupWorkerHandler({
      objects: {
        deleteFinal: () => {
          throw new Error('sync');
        },
      },
      history: deps.history,
    });

    expect(
      await sync(
        sqsEvent(
          message('m-1', receiptDeletion(1)),
          message('m-2', historyPurge(2)),
        ),
      ),
    ).toEqual(failures('m-1'));
  });
});

describe('batch responses', () => {
  it('returns every failed message ID in input order and omits successes', async () => {
    deps.failFinal.add('r-4');
    const response = await handler(
      sqsEvent(
        sqsRecord('m-z', '{bad'),
        message('m-b', receiptDeletion(2)),
        message('m-a', receiptDeletion(4)),
        message('m-y', submitted),
        message('m-c', historyPurge(5)),
      ),
    );

    expect(response).toEqual(failures('m-z', 'm-a', 'm-y'));
  });

  it('reports each failed message even when bodies are identical', async () => {
    const response = await handler(
      sqsEvent(sqsRecord('m-1', 'x'), sqsRecord('m-2', 'x')),
    );

    expect(response).toEqual(failures('m-1', 'm-2'));
  });
});

describe('message IDs', () => {
  it.each([undefined, ''])(
    'throws for a record with message ID %j before any cleanup',
    async (id) => {
      await expect(
        handler(
          sqsEvent(
            message('m-1', receiptDeletion(1)),
            sqsRecord(id, JSON.stringify(wrapper(historyPurge(2)))),
          ),
        ),
      ).rejects.toThrow('no message ID');
      nothingDone();
    },
  );
});

describe('safe errors', () => {
  it('uses a fixed message and echoes nothing supplied', async () => {
    const error = await handler(
      sqsEvent(
        message('m-1', historyPurge(1)),
        sqsRecord(undefined, 'Salary review r-secret'),
      ),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe('An SQS record has no message ID.');
  });

  it('puts only message IDs in the response, never bodies or dependency errors', async () => {
    deps.failFinal.add('r-secret');
    const response = await handler(
      sqsEvent(
        message('m-1', receiptDeletion(1, 'r-secret')),
        sqsRecord('m-2', 'Salary review'),
      ),
    );

    expect(JSON.stringify(response)).toBe(
      '{"batchItemFailures":[{"itemIdentifier":"m-1"},{"itemIdentifier":"m-2"}]}',
    );
  });
});
