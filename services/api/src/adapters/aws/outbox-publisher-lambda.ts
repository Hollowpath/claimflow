import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { systemClock } from '../local/system.js';
import { DynamoDbOutboxState } from './dynamodb-outbox-state.js';
import { EventBridgePublisher } from './eventbridge-publisher.js';
import { OutboxPublication } from './outbox-publication.js';
import { createOutboxStreamHandler } from './outbox-stream-handler.js';

/**
 * The outbox publisher's Lambda entry point (docs/aws-architecture.md,
 * section 15). It only wires clients and adapters to the stream handler; the
 * clients are built once per execution environment, outside the handler.
 */

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`The ${name} environment variable is missing.`);
  }
  return value;
}

const tableName = requiredEnvironment('CLAIMFLOW_TABLE_NAME');
const eventBusName = requiredEnvironment('CLAIMFLOW_EVENT_BUS_NAME');

export const handler = createOutboxStreamHandler(
  new OutboxPublication({
    state: new DynamoDbOutboxState({
      client: DynamoDBDocumentClient.from(new DynamoDBClient({})),
      tableName,
    }),
    publisher: new EventBridgePublisher({
      client: new EventBridgeClient({}),
      eventBusName,
    }),
    clock: systemClock,
  }),
);
