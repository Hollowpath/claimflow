import {
  PutEventsCommand,
  type PutEventsCommandOutput,
} from '@aws-sdk/client-eventbridge';

import { eventSource, type OutboxEvent } from '../../application/events.js';
import { encodeOutboxItem } from './dynamodb-outbox-items.js';

/**
 * Publishes outbox events to the `claimflow` event bus
 * (docs/aws-architecture.md, section 15): one `PutEvents` call of 1 to 10
 * events, each entry carrying the complete envelope as its detail. It
 * returns the SDK result unchanged; reading `FailedEntryCount` and marking
 * events published belong to the publisher workflow. Nothing retries or logs.
 */

/** The command this publisher sends; an `EventBridgeClient` provides it. */
export interface EventBusClient {
  send(command: PutEventsCommand): Promise<PutEventsCommandOutput>;
}

export interface EventBridgePublisherOptions {
  readonly client: EventBusClient;
  readonly eventBusName: string;
}

/** `PutEvents` accepts at most 10 entries per call. */
export const maxPublishBatch = 10;

export class EventBridgePublisher {
  private readonly client: EventBusClient;
  private readonly eventBusName: string;

  public constructor({ client, eventBusName }: EventBridgePublisherOptions) {
    if (typeof eventBusName !== 'string' || eventBusName.length === 0) {
      throw new TypeError('The event bus name is missing.');
    }
    this.client = client;
    this.eventBusName = eventBusName;
  }

  /**
   * One `PutEventsCommand` with an entry per event, in order. Every event is
   * validated first, with the outbox codec, so an invalid batch sends nothing.
   * The result, including per-entry failures, is returned as the SDK gave it.
   */
  public async publish(
    events: readonly OutboxEvent[],
  ): Promise<PutEventsCommandOutput> {
    if (
      !isList(events) ||
      events.length < 1 ||
      events.length > maxPublishBatch
    ) {
      throw new RangeError(`A batch must hold 1 to ${maxPublishBatch} events.`);
    }
    const batch: readonly OutboxEvent[] = events;
    for (const event of batch) {
      encodeOutboxItem(event);
    }
    return await this.client.send(
      new PutEventsCommand({
        Entries: batch.map((event) => ({
          EventBusName: this.eventBusName,
          Source: eventSource,
          DetailType: event.eventType,
          Detail: JSON.stringify(event),
        })),
      }),
    );
  }
}

/** A real list; a string or other value with a length is not a batch. */
function isList(value: unknown): value is readonly OutboxEvent[] {
  return Array.isArray(value);
}
