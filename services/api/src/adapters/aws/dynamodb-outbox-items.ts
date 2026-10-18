import { isCurrencyCode } from '@claimflow/domain';

import { expiresAfter, type EpochSeconds } from '../../application/commit.js';
import {
  eventCatalog,
  eventSource,
  outboxEventTypes,
  type OutboxEvent,
  type OutboxEventType,
} from '../../application/events.js';
import { isTraceId } from '../../application/tracing.js';
import {
  AttributeReader,
  categoriesPartitionKey,
  claimKey,
  failWith,
  indexAttributes,
  ItemEncodingError,
  ItemIntegrityError,
  type DynamoItem,
  type Fail,
} from './dynamodb-items.js';

/**
 * Pure codecs for outbox items (docs/aws-architecture.md, sections 5, 7, and
 * 15). The event envelope is the application's; the publication state is
 * persistence-only and kept beside it.
 */

export const outboxEntityType = 'OutboxEvent';
export const pendingOutboxPartition = 'OUTBOX#PENDING';

/** Published events are kept for 7 days after publication (section 14). */
export const publishedRetentionMs = 7 * 24 * 60 * 60 * 1000;

/**
 * `PENDING` items are in the GSI4 pending partition and never expire;
 * `PUBLISHED` items leave the index and expire 7 days after publication.
 */
export type OutboxState =
  | { readonly state: 'PENDING' }
  | {
      readonly state: 'PUBLISHED';
      readonly publishedAt: string;
      readonly expiresAt: EpochSeconds;
    };

export interface StoredOutboxEvent {
  readonly event: OutboxEvent;
  readonly state: OutboxState;
}

export const pendingState: OutboxState = { state: 'PENDING' };

/** The published state, with its TTL 7 days after `publishedAt`. */
export function publishedState(publishedAt: string): OutboxState {
  return {
    state: 'PUBLISHED',
    publishedAt,
    expiresAt: expiresAfter(new Date(publishedAt), publishedRetentionMs),
  };
}

/** `CLAIM#<id>` for claim and cleanup events, `CATEGORIES` for categories. */
export function outboxPartitionKey(event: OutboxEvent): string {
  return event.aggregate.type === 'category'
    ? categoriesPartitionKey
    : claimKey(event.aggregate.id).PK;
}

export function outboxSortKey(occurredAt: string, eventId: string): string {
  return `OUTBOX#${occurredAt}#${eventId}`;
}

export function outboxKey(event: OutboxEvent) {
  return {
    PK: outboxPartitionKey(event),
    SK: outboxSortKey(event.occurredAt, event.eventId),
  } as const;
}

/** The GSI4 attributes of a pending event (access pattern O1). */
export function pendingIndexAttributes(event: OutboxEvent) {
  return {
    GSI4PK: pendingOutboxPartition,
    GSI4SK: `${event.occurredAt}#${event.eventId}`,
  } as const;
}

const outboxAttributes = new Set([
  'PK',
  'SK',
  'entityType',
  'eventId',
  'eventType',
  'schemaVersion',
  'occurredAt',
  'source',
  'aggregate',
  'correlationId',
  'causationId',
  'actorId',
  'payload',
  'state',
  'publishedAt',
  'expiresAt',
  // Index attributes are allowed here so that the index rules report them.
  ...indexAttributes,
]);

export function encodeOutboxItem(
  event: OutboxEvent,
  state: OutboxState = pendingState,
): DynamoItem {
  const item: DynamoItem = {
    ...outboxKey(event),
    entityType: outboxEntityType,
    eventId: event.eventId,
    eventType: event.eventType,
    schemaVersion: event.schemaVersion,
    occurredAt: event.occurredAt,
    source: event.source,
    aggregate: { ...event.aggregate },
    correlationId: event.correlationId,
    causationId: event.causationId,
    actorId: event.actorId,
    payload: { ...event.payload },
    ...(state.state === 'PENDING'
      ? { state: 'PENDING', ...pendingIndexAttributes(event) }
      : {
          state: 'PUBLISHED',
          publishedAt: state.publishedAt,
          expiresAt: state.expiresAt,
        }),
  };
  readOutbox(item, failWith(ItemEncodingError, item));
  return item;
}

export function decodeOutboxItem(item: DynamoItem): StoredOutboxEvent {
  return readOutbox(item, failWith(ItemIntegrityError, item));
}

function readOutbox(item: DynamoItem, fail: Fail): StoredOutboxEvent {
  const read = new AttributeReader(item, fail);
  read.allowOnly(outboxAttributes);
  read.entityType(outboxEntityType);

  const eventType = read.oneOf<OutboxEventType>('eventType', outboxEventTypes);
  const { kind, aggregateType } = eventCatalog[eventType];
  if (item.schemaVersion !== 1) {
    fail('schemaVersion is not 1');
  }
  if (item.source !== eventSource) {
    fail(`source is not ${eventSource}`);
  }
  const eventId = read.id('eventId');
  const occurredAt = read.timestamp('occurredAt');
  const correlationId = read.check('correlationId', isTraceId);
  const causationId = read.check('causationId', isTraceId);
  const actorId = read.id('actorId');

  const aggregateRead = read.map('aggregate');
  aggregateRead.allowOnly(
    new Set(['type', 'id', 'version', 'previousEventVersion']),
  );
  const type = aggregateRead.oneOf('type', ['claim', 'category']);
  if (type !== aggregateType) {
    fail(`aggregate.type must be ${aggregateType} for ${eventType}`);
  }
  const id = aggregateRead.id('id');
  const version = aggregateRead.positiveInteger('version');
  const previous = (item.aggregate as DynamoItem).previousEventVersion;
  let previousEventVersion: number | null;
  if (previous === null) {
    previousEventVersion = null;
  } else if (kind === 'internal') {
    return fail('aggregate.previousEventVersion must be null for this event');
  } else {
    previousEventVersion = aggregateRead.positiveInteger(
      'previousEventVersion',
    );
    if (previousEventVersion >= version) {
      fail('aggregate.previousEventVersion must be below aggregate.version');
    }
  }

  const payload = readPayload(
    eventType,
    read.map('payload'),
    { id, version },
    fail,
  );

  const event = {
    eventId,
    eventType,
    schemaVersion: 1,
    occurredAt,
    source: eventSource,
    aggregate: { type, id, version, previousEventVersion },
    correlationId,
    causationId,
    actorId,
    payload,
  } as OutboxEvent;

  read.keys(outboxKey(event));
  const state = readState(read, item, event, fail);
  return { event, state };
}

function readState(
  read: AttributeReader,
  item: DynamoItem,
  event: OutboxEvent,
  fail: Fail,
): OutboxState {
  const state = read.oneOf('state', ['PENDING', 'PUBLISHED']);
  if (state === 'PENDING') {
    if (read.has('publishedAt') || read.has('expiresAt')) {
      fail('a pending event must not have publishedAt or expiresAt');
    }
    read.indexes(pendingIndexAttributes(event));
    return pendingState;
  }

  read.noIndexes();
  const publishedAt = read.timestamp('publishedAt');
  if (publishedAt < event.occurredAt) {
    fail('publishedAt is before occurredAt');
  }
  const expected = publishedState(publishedAt);
  if (expected.state !== 'PUBLISHED' || item.expiresAt !== expected.expiresAt) {
    return fail('expiresAt must be 7 days after publishedAt');
  }
  return expected;
}

/** The exact payload fields of each event type. */
function readPayload(
  eventType: OutboxEventType,
  read: AttributeReader,
  aggregate: { readonly id: string; readonly version: number },
  fail: Fail,
): Record<string, unknown> {
  const claimFields = () => {
    const claimId = read.id('claimId');
    if (claimId !== aggregate.id) {
      fail('payload.claimId does not match the aggregate');
    }
    return {
      claimId,
      employeeId: read.id('employeeId'),
      assignedManagerId: read.id('assignedManagerId'),
      categoryId: read.id('categoryId'),
      amount: read.money('amount'),
    };
  };
  const categoryFields = () => {
    const categoryId = read.id('categoryId');
    if (categoryId !== aggregate.id) {
      fail('payload.categoryId does not match the aggregate');
    }
    const version = read.positiveInteger('version');
    if (version !== aggregate.version) {
      fail('payload.version does not match the aggregate');
    }
    return { categoryId, version };
  };
  const claimIdOnly = () => {
    const claimId = read.id('claimId');
    if (claimId !== aggregate.id) {
      fail('payload.claimId does not match the aggregate');
    }
    return { claimId };
  };
  const exactly = (fields: readonly string[]) =>
    read.allowOnly(new Set(fields));

  const claimBase = [
    'claimId',
    'employeeId',
    'assignedManagerId',
    'categoryId',
    'amount',
  ];
  const policy = ['currency', 'maxAmountMinor', 'receiptRequiredAboveMinor'];

  switch (eventType) {
    case 'claim.submitted':
      exactly([...claimBase, 'submittedAt']);
      return { ...claimFields(), submittedAt: read.timestamp('submittedAt') };
    case 'claim.review-started':
    case 'claim.reopened':
      exactly(claimBase);
      return claimFields();
    case 'claim.approved':
    case 'claim.rejected':
      exactly([...claimBase, 'reviewedAt']);
      return { ...claimFields(), reviewedAt: read.timestamp('reviewedAt') };
    case 'claim.paid':
      exactly([...claimBase, 'paidBy', 'paidAt']);
      return {
        ...claimFields(),
        paidBy: read.id('paidBy'),
        paidAt: read.timestamp('paidAt'),
      };
    case 'category.created':
      exactly(['categoryId', 'version', 'active', ...policy]);
      return {
        ...categoryFields(),
        active: read.boolean('active'),
        ...readPolicy(read, policy, fail),
      };
    case 'category.policy-changed': {
      exactly(['categoryId', 'version', ...policy]);
      const present = policy.filter((field) => read.has(field));
      if (present.length === 0) {
        fail('payload must contain at least one changed policy field');
      }
      return { ...categoryFields(), ...readPolicy(read, present, fail) };
    }
    case 'category.deactivated':
    case 'category.activated':
    case 'category.deleted':
      exactly(['categoryId', 'version']);
      return categoryFields();
    case 'internal.receipt-object-deletion-requested': {
      exactly(['claimId', 'receiptId', 'objectKey']);
      const receiptId = read.id('receiptId');
      const objectKey = read.string('objectKey');
      if (objectKey !== `receipts/${receiptId}`) {
        fail('payload.objectKey must be the attached receipt object');
      }
      return { ...claimIdOnly(), receiptId, objectKey };
    }
    case 'internal.claim-history-purge-requested':
      exactly(['claimId']);
      return claimIdOnly();
  }
}

function readPolicy(
  read: AttributeReader,
  fields: readonly string[],
  fail: Fail,
): Record<string, string | number> {
  const values: Record<string, string | number> = {};
  for (const field of fields) {
    if (field === 'currency') {
      values.currency = read.check('currency', isCurrencyCode);
    } else if (field === 'maxAmountMinor') {
      values.maxAmountMinor = read.positiveInteger('maxAmountMinor');
    } else if (field === 'receiptRequiredAboveMinor') {
      values.receiptRequiredAboveMinor = read.nonNegativeInteger(
        'receiptRequiredAboveMinor',
      );
    } else {
      fail('payload has an unexpected field');
    }
  }
  return values;
}
