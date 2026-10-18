import type { Money } from '@claimflow/domain';

/**
 * Outbox events (docs/aws-architecture.md, section 15). Payloads contain
 * identifiers, amounts, categories, and timestamps only: never merchants,
 * business purposes, decision comments, or other free text.
 */

export const eventSource = 'claimflow.api';

/** The identifiers, amount, and category shared by every claim event. */
export interface ClaimEventPayload {
  readonly claimId: string;
  readonly employeeId: string;
  readonly assignedManagerId: string;
  readonly categoryId: string;
  readonly amount: Money;
}

/** The policy fields of a category, which category events may carry. */
export interface CategoryPolicyFields {
  readonly currency: string;
  readonly maxAmountMinor: number;
  readonly receiptRequiredAboveMinor: number;
}

export interface CategoryEventPayload {
  readonly categoryId: string;
  /** The category version the event describes. */
  readonly version: number;
}

/** The payload of each event type. */
export interface EventPayloads {
  readonly 'claim.submitted': ClaimEventPayload & {
    readonly submittedAt: string;
  };
  readonly 'claim.review-started': ClaimEventPayload;
  readonly 'claim.approved': ClaimEventPayload & {
    readonly reviewedAt: string;
  };
  readonly 'claim.rejected': ClaimEventPayload & {
    readonly reviewedAt: string;
  };
  readonly 'claim.reopened': ClaimEventPayload;
  readonly 'claim.paid': ClaimEventPayload & {
    readonly paidBy: string;
    readonly paidAt: string;
  };
  readonly 'category.created': CategoryEventPayload &
    CategoryPolicyFields & { readonly active: boolean };
  /** Only the policy fields that changed. */
  readonly 'category.policy-changed': CategoryEventPayload &
    Partial<CategoryPolicyFields>;
  readonly 'category.deactivated': CategoryEventPayload;
  readonly 'category.activated': CategoryEventPayload;
  readonly 'category.deleted': CategoryEventPayload;
  readonly 'internal.receipt-object-deletion-requested': {
    readonly claimId: string;
    readonly receiptId: string;
    readonly objectKey: string;
  };
  readonly 'internal.claim-history-purge-requested': {
    readonly claimId: string;
  };
}

export type OutboxEventType = keyof EventPayloads;

/** How each event type is routed, and the aggregate it describes. */
export const eventCatalog = {
  'claim.submitted': { kind: 'publishable', aggregateType: 'claim' },
  'claim.review-started': { kind: 'publishable', aggregateType: 'claim' },
  'claim.approved': { kind: 'publishable', aggregateType: 'claim' },
  'claim.rejected': { kind: 'publishable', aggregateType: 'claim' },
  'claim.reopened': { kind: 'publishable', aggregateType: 'claim' },
  'claim.paid': { kind: 'publishable', aggregateType: 'claim' },
  'category.created': { kind: 'publishable', aggregateType: 'category' },
  'category.policy-changed': {
    kind: 'publishable',
    aggregateType: 'category',
  },
  'category.deactivated': { kind: 'publishable', aggregateType: 'category' },
  'category.activated': { kind: 'publishable', aggregateType: 'category' },
  'category.deleted': { kind: 'publishable', aggregateType: 'category' },
  'internal.receipt-object-deletion-requested': {
    kind: 'internal',
    aggregateType: 'claim',
  },
  'internal.claim-history-purge-requested': {
    kind: 'internal',
    aggregateType: 'claim',
  },
} as const satisfies Record<
  OutboxEventType,
  {
    readonly kind: 'publishable' | 'internal';
    readonly aggregateType: 'claim' | 'category';
  }
>;

export const outboxEventTypes = Object.keys(
  eventCatalog,
) as readonly OutboxEventType[];

type Catalog = typeof eventCatalog;

/** The aggregate an event describes. */
export interface EventAggregate<T extends OutboxEventType = OutboxEventType> {
  readonly type: Catalog[T]['aggregateType'];
  readonly id: string;
  /** The aggregate version this event describes. */
  readonly version: number;
  /**
   * The version of the aggregate's previous publishable event, or `null` for
   * its first one. Always `null` for internal events, which are not part of
   * the published sequence.
   */
  readonly previousEventVersion: Catalog[T]['kind'] extends 'internal'
    ? null
    : number | null;
}

/** The stable envelope of one outbox event. */
export interface OutboxEventEnvelope<
  T extends OutboxEventType = OutboxEventType,
> {
  /** From the `IdGenerator`; consumers deduplicate on it. */
  readonly eventId: string;
  readonly eventType: T;
  readonly schemaVersion: 1;
  /** ISO 8601, assigned immediately before the transaction. */
  readonly occurredAt: string;
  readonly source: typeof eventSource;
  readonly aggregate: EventAggregate<T>;
  readonly correlationId: string;
  readonly causationId: string;
  readonly actorId: string;
  readonly payload: EventPayloads[T];
}

/** Any outbox event, discriminated by `eventType`. */
export type OutboxEvent = {
  [T in OutboxEventType]: OutboxEventEnvelope<T>;
}[OutboxEventType];
