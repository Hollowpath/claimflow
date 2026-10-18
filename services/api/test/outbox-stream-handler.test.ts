import { marshall } from '@aws-sdk/util-dynamodb';
import type { DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  encodeOutboxItem,
  publishedState,
} from '../src/adapters/aws/dynamodb-outbox-items.js';
import type {
  PublicationRecord,
  PublicationResult,
} from '../src/adapters/aws/outbox-publication.js';
import {
  createOutboxStreamHandler,
  type OutboxPublicationWorkflow,
} from '../src/adapters/aws/outbox-stream-handler.js';
import { eventSource, type OutboxEvent } from '../src/application/events.js';

const claimId = '4ce0c74b-9c64-46d6-87ba-07fb71b0628c';

function eventNumber(n: number): OutboxEvent {
  return {
    eventId: `event-${String(n).padStart(4, '0')}`,
    eventType: 'claim.submitted',
    schemaVersion: 1,
    occurredAt: '2026-10-14T10:41:00.000Z',
    source: eventSource,
    aggregate: {
      type: 'claim',
      id: claimId,
      version: 4,
      previousEventVersion: null,
    },
    correlationId: 'c0ffee00-1111-2222-3333-444455556666',
    causationId: 'request-7d3e',
    actorId: 'sub-aisha',
    payload: {
      claimId,
      employeeId: 'sub-aisha',
      assignedManagerId: 'sub-ben',
      categoryId: 'travel',
      amount: { amountMinor: 45_000, currency: 'MYR' },
      submittedAt: '2026-10-14T10:41:00.000Z',
    },
  };
}

type Image = Record<string, unknown>;

/** A stream record as DynamoDB Streams delivers it. */
function streamRecord(
  eventName: 'INSERT' | 'MODIFY' | 'REMOVE',
  item: Image,
  sequence: string | undefined,
  overrides: { image?: Image | null; keys?: Image } = {},
): DynamoDBRecord {
  const image = overrides.image === undefined ? item : overrides.image;
  return {
    eventID: `id-${String(sequence)}`,
    eventName,
    eventVersion: '1.1',
    eventSource: 'aws:dynamodb',
    awsRegion: 'ap-southeast-1',
    eventSourceARN:
      'arn:aws:dynamodb:ap-southeast-1:123456789012:table/ClaimFlow/stream/2026-10-14T00:00:00.000',
    dynamodb: {
      ApproximateCreationDateTime: 1_792_000_000,
      Keys: marshall(overrides.keys ?? { PK: item.PK, SK: item.SK }) as never,
      ...(image === null
        ? {}
        : {
            NewImage: marshall(image, { removeUndefinedValues: true }) as never,
          }),
      ...(sequence === undefined ? {} : { SequenceNumber: sequence }),
      SizeBytes: 1024,
      StreamViewType: 'NEW_AND_OLD_IMAGES',
    },
  };
}

const outboxRecord = (n: number, sequence: string | undefined = `seq-${n}`) =>
  streamRecord('INSERT', encodeOutboxItem(eventNumber(n)), sequence);

const streamEvent = (...records: DynamoDBRecord[]): DynamoDBStreamEvent => ({
  Records: records,
});

class FakeWorkflow implements OutboxPublicationWorkflow {
  public readonly calls: (readonly PublicationRecord[])[] = [];
  public firstFailure: string | undefined;
  public failure: Error | undefined;

  public publish(
    records: readonly PublicationRecord[],
  ): Promise<PublicationResult> {
    this.calls.push(records);
    return this.failure === undefined
      ? Promise.resolve({ firstFailedSequenceNumber: this.firstFailure })
      : Promise.reject(this.failure);
  }
}

let workflow: FakeWorkflow;
let handler: ReturnType<typeof createOutboxStreamHandler>;

beforeEach(() => {
  workflow = new FakeWorkflow();
  handler = createOutboxStreamHandler(workflow);
});

describe('decoding and ordering', () => {
  it('passes decoded events with their sequence numbers, in stream order', async () => {
    const response = await handler(
      streamEvent(outboxRecord(1), outboxRecord(2), outboxRecord(3)),
    );

    expect(response).toEqual({ batchItemFailures: [] });
    expect(workflow.calls).toEqual([
      [1, 2, 3].map((n) => ({
        sequenceNumber: `seq-${n}`,
        event: eventNumber(n),
      })),
    ]);
  });

  it('unmarshalls numbers and nested maps exactly', async () => {
    await handler(streamEvent(outboxRecord(1)));

    const event = workflow.calls[0]![0]!.event;
    expect(event).toEqual(eventNumber(1));
    expect(
      typeof (event.payload as { amount: { amountMinor: unknown } }).amount
        .amountMinor,
    ).toBe('number');
  });

  it('handles 10 relevant records', async () => {
    const records = Array.from({ length: 10 }, (_, i) => outboxRecord(i + 1));

    expect(await handler(streamEvent(...records))).toEqual({
      batchItemFailures: [],
    });
    expect(workflow.calls[0]).toHaveLength(10);
  });

  it('rejects more than 10 relevant records, publishing nothing', async () => {
    const records = Array.from({ length: 11 }, (_, i) => outboxRecord(i + 1));

    await expect(handler(streamEvent(...records))).rejects.toThrow(RangeError);
    expect(workflow.calls).toEqual([]);
  });
});

describe('filtering', () => {
  const claimItem = {
    PK: `CLAIM#${claimId}`,
    SK: 'CLAIM',
    entityType: 'Claim',
  };

  it('ignores MODIFY and REMOVE records of outbox items', async () => {
    const item = encodeOutboxItem(eventNumber(1));

    const response = await handler(
      streamEvent(
        streamRecord('MODIFY', { ...item, state: 'PUBLISHED' }, 'seq-1'),
        streamRecord('REMOVE', item, 'seq-2', { image: null }),
      ),
    );

    expect(response).toEqual({ batchItemFailures: [] });
    expect(workflow.calls).toEqual([]);
  });

  it('ignores inserts of other items', async () => {
    const response = await handler(
      streamEvent(
        streamRecord('INSERT', claimItem, 'seq-1'),
        streamRecord(
          'INSERT',
          { PK: 'CATEGORIES', SK: 'CATEGORY#travel' },
          'seq-2',
        ),
        streamRecord('INSERT', { PK: 'X', SK: 'HISTORY#0000000001' }, 'seq-3'),
      ),
    );

    expect(response).toEqual({ batchItemFailures: [] });
    expect(workflow.calls).toEqual([]);
  });

  it('ignores irrelevant records without sequence numbers or images', async () => {
    const response = await handler(
      streamEvent(
        streamRecord('INSERT', claimItem, undefined, { image: null }),
        outboxRecord(1),
      ),
    );

    expect(response).toEqual({ batchItemFailures: [] });
    expect(workflow.calls[0]!.map((r) => r.sequenceNumber)).toEqual(['seq-1']);
  });

  it('counts only relevant records against the limit', async () => {
    const noise = Array.from({ length: 20 }, (_, i) =>
      streamRecord('INSERT', claimItem, `noise-${i}`),
    );

    await expect(
      handler(streamEvent(...noise, outboxRecord(1))),
    ).resolves.toEqual({
      batchItemFailures: [],
    });
  });

  it('handles an empty event', async () => {
    expect(await handler(streamEvent())).toEqual({ batchItemFailures: [] });
    expect(await handler({} as DynamoDBStreamEvent)).toEqual({
      batchItemFailures: [],
    });
    expect(workflow.calls).toEqual([]);
  });
});

describe('malformed relevant records', () => {
  const item = () => encodeOutboxItem(eventNumber(2));

  it.each<[string, DynamoDBRecord]>([
    ['no image', streamRecord('INSERT', item(), 'seq-2', { image: null })],
    [
      'an unknown event type',
      streamRecord(
        'INSERT',
        { ...item(), eventType: 'claim.archived' },
        'seq-2',
      ),
    ],
    [
      'free text in the payload',
      streamRecord(
        'INSERT',
        {
          ...item(),
          payload: { ...(item().payload as Image), merchant: 'Cafe' },
        },
        'seq-2',
      ),
    ],
    [
      'an unexpected attribute',
      streamRecord('INSERT', { ...item(), extra: 1 }, 'seq-2'),
    ],
    [
      'a key that does not match',
      streamRecord('INSERT', { ...item(), PK: 'CLAIM#other' }, 'seq-2'),
    ],
    [
      'an image that cannot be unmarshalled',
      {
        ...streamRecord('INSERT', item(), 'seq-2'),
        dynamodb: {
          ...streamRecord('INSERT', item(), 'seq-2').dynamodb,
          NewImage: { PK: { Q: 'x' } } as never,
        },
      },
    ],
  ])(
    'reports a record with %s as failed and still processes the others',
    async (_name, bad) => {
      const response = await handler(
        streamEvent(outboxRecord(1), bad, outboxRecord(3)),
      );

      expect(response).toEqual({
        batchItemFailures: [{ itemIdentifier: 'seq-2' }],
      });
      expect(workflow.calls).toHaveLength(1);
      expect(workflow.calls[0]!.map((r) => r.sequenceNumber)).toEqual([
        'seq-1',
        'seq-3',
      ]);
    },
  );

  it('does not call the workflow when every relevant record is malformed', async () => {
    const response = await handler(
      streamEvent(
        streamRecord('INSERT', item(), 'seq-1', { image: null }),
        streamRecord('INSERT', item(), 'seq-2', { image: null }),
      ),
    );

    expect(response).toEqual({
      batchItemFailures: [{ itemIdentifier: 'seq-1' }],
    });
    expect(workflow.calls).toEqual([]);
  });
});

describe('failures', () => {
  it("reports the workflow's first failure", async () => {
    workflow.firstFailure = 'seq-2';

    expect(
      await handler(
        streamEvent(outboxRecord(1), outboxRecord(2), outboxRecord(3)),
      ),
    ).toEqual({
      batchItemFailures: [{ itemIdentifier: 'seq-2' }],
    });
  });

  it('chooses the earlier of a decoding failure and a workflow failure', async () => {
    const bad = (n: number) =>
      streamRecord('INSERT', encodeOutboxItem(eventNumber(n)), `seq-${n}`, {
        image: null,
      });

    workflow.firstFailure = 'seq-3';
    expect(
      await handler(streamEvent(outboxRecord(1), bad(2), outboxRecord(3))),
    ).toEqual({
      batchItemFailures: [{ itemIdentifier: 'seq-2' }],
    });

    workflow.firstFailure = 'seq-1';
    expect(
      await handler(streamEvent(outboxRecord(1), bad(2), outboxRecord(3))),
    ).toEqual({
      batchItemFailures: [{ itemIdentifier: 'seq-1' }],
    });
  });

  it('returns exactly one failure entry even when several records fail', async () => {
    workflow.firstFailure = 'seq-3';
    const bad = (n: number) =>
      streamRecord('INSERT', encodeOutboxItem(eventNumber(n)), `seq-${n}`, {
        image: null,
      });

    const response = await handler(
      streamEvent(bad(1), outboxRecord(2), bad(3), outboxRecord(4)),
    );

    expect(response.batchItemFailures).toEqual([{ itemIdentifier: 'seq-1' }]);
  });

  it('uses stream order, not sequence-number order', async () => {
    workflow.firstFailure = 'z';
    const bad = streamRecord('INSERT', encodeOutboxItem(eventNumber(2)), 'a', {
      image: null,
    });

    const response = await handler(streamEvent(outboxRecord(1, 'z'), bad));

    expect(response.batchItemFailures).toEqual([{ itemIdentifier: 'z' }]);
  });
});

describe('missing sequence numbers', () => {
  it.each([undefined, ''])(
    'throws for a relevant record with sequence %j, publishing nothing',
    async (sequence) => {
      await expect(
        handler(
          streamEvent(
            outboxRecord(1),
            streamRecord('INSERT', encodeOutboxItem(eventNumber(2)), sequence),
            outboxRecord(3),
          ),
        ),
      ).rejects.toThrow('no sequence number');
      expect(workflow.calls).toEqual([]);
    },
  );
});

describe('with the workflow', () => {
  it('does not swallow an invalid batch from the workflow', async () => {
    workflow.failure = new TypeError('Sequence numbers must be unique.');

    await expect(
      handler(streamEvent(outboxRecord(1, 'dup'), outboxRecord(2, 'dup'))),
    ).rejects.toThrow('unique');
  });

  it('accepts a published-state image and leaves the decision to the workflow', async () => {
    const published = encodeOutboxItem(
      eventNumber(1),
      publishedState('2026-10-14T10:45:00.000Z'),
    );

    const response = await handler(
      streamEvent(streamRecord('INSERT', published, 'seq-1')),
    );

    expect(response).toEqual({ batchItemFailures: [] });
    expect(workflow.calls[0]).toHaveLength(1);
  });
});
