import { unmarshall } from '@aws-sdk/util-dynamodb';
import type {
  DynamoDBBatchResponse,
  DynamoDBRecord,
  DynamoDBStreamEvent,
} from 'aws-lambda';

import { decodeOutboxItem } from './dynamodb-outbox-items.js';
import { maxPublishBatch } from './eventbridge-publisher.js';
import type {
  PublicationRecord,
  PublicationResult,
} from './outbox-publication.js';

/**
 * The DynamoDB Streams handler of the outbox publisher
 * (docs/aws-architecture.md, section 15). It accepts the records the event
 * source mapping's filter lets through (an `INSERT` whose sort key starts
 * with `OUTBOX#`), decodes each new image strictly, and hands the events to
 * the publication workflow. It builds no clients and is not a Lambda entry
 * point itself.
 */

/** The workflow the handler delegates to. */
export interface OutboxPublicationWorkflow {
  publish(records: readonly PublicationRecord[]): Promise<PublicationResult>;
}

export type OutboxStreamHandler = (
  event: DynamoDBStreamEvent,
) => Promise<DynamoDBBatchResponse>;

/**
 * A handler for batches of up to 10 relevant records. A relevant record
 * without a sequence number, or a larger batch, throws so that Lambda retries
 * the whole batch. A relevant record with a malformed image is reported as
 * failed, without stopping the others. The response names the first failed
 * sequence number in stream order, or none.
 */
export function createOutboxStreamHandler(
  publication: OutboxPublicationWorkflow,
): OutboxStreamHandler {
  return async (event) => {
    const relevant = (event.Records ?? []).filter(isOutboxInsert);
    if (relevant.length > maxPublishBatch) {
      throw new RangeError(
        `A batch must hold at most ${maxPublishBatch} outbox records.`,
      );
    }

    // Every relevant record needs a sequence number, or no failure could be
    // reported for it; check before anything is published.
    const sequenced = relevant.map((record) => {
      const sequenceNumber = record.dynamodb?.SequenceNumber;
      if (typeof sequenceNumber !== 'string' || sequenceNumber.length === 0) {
        throw new TypeError('A stream record has no sequence number.');
      }
      return { record, sequenceNumber };
    });

    const decoded: PublicationRecord[] = [];
    let firstDecodeFailure: string | undefined;
    for (const { record, sequenceNumber } of sequenced) {
      const outboxEvent = decodeNewImage(record);
      if (outboxEvent === undefined) {
        firstDecodeFailure ??= sequenceNumber;
      } else {
        decoded.push({ sequenceNumber, event: outboxEvent });
      }
    }

    const workflowFailure =
      decoded.length === 0
        ? undefined
        : (await publication.publish(decoded)).firstFailedSequenceNumber;

    const first = earliest(
      sequenced.map((s) => s.sequenceNumber),
      [firstDecodeFailure, workflowFailure],
    );
    return {
      batchItemFailures: first === undefined ? [] : [{ itemIdentifier: first }],
    };
  };
}

/** The approved filter: an `INSERT` of an item whose sort key is an outbox key. */
function isOutboxInsert(record: DynamoDBRecord): boolean {
  return (
    record?.eventName === 'INSERT' &&
    typeof record.dynamodb?.Keys?.SK?.S === 'string' &&
    record.dynamodb.Keys.SK.S.startsWith('OUTBOX#')
  );
}

/** The decoded event, or `undefined` for a missing or malformed image. */
function decodeNewImage(record: DynamoDBRecord) {
  const image = record.dynamodb?.NewImage;
  if (image === undefined) {
    return undefined;
  }
  try {
    return decodeOutboxItem(
      unmarshall(image as Parameters<typeof unmarshall>[0]),
    ).event;
  } catch {
    return undefined;
  }
}

/** The candidate that comes first in stream order. */
function earliest(
  order: readonly string[],
  candidates: readonly (string | undefined)[],
): string | undefined {
  let best: string | undefined;
  for (const candidate of candidates) {
    if (
      candidate !== undefined &&
      (best === undefined || order.indexOf(candidate) < order.indexOf(best))
    ) {
      best = candidate;
    }
  }
  return best;
}
