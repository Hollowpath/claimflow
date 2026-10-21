import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { systemClock } from '../local/system.js';
import { DynamoDbOutboxState } from './dynamodb-outbox-state.js';
import { DynamoDbPendingOutbox } from './dynamodb-pending-outbox.js';
import { EventBridgePublisher } from './eventbridge-publisher.js';
import { OutboxPublication } from './outbox-publication.js';
import { createEmfOldestPendingOutboxAgeRecorder } from './oldest-pending-outbox-metric.js';
import { createOutboxSweeper } from './outbox-sweeper.js';

/**
 * The outbox sweeper's Lambda entry point (docs/aws-architecture.md,
 * section 15). It only wires clients and adapters to the sweeper; the
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

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const handler = createOutboxSweeper({
  pending: new DynamoDbPendingOutbox({ client: documentClient, tableName }),
  publication: new OutboxPublication({
    state: new DynamoDbOutboxState({ client: documentClient, tableName }),
    publisher: new EventBridgePublisher({
      client: new EventBridgeClient({}),
      eventBusName,
    }),
    clock: systemClock,
  }),
  clock: systemClock,
  metrics: createEmfOldestPendingOutboxAgeRecorder(),
});
