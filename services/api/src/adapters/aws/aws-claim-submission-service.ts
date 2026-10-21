import type { Actor } from '@claimflow/domain';

import {
  AwsClaimLifecycleService,
  type AwsClaimLifecycleServiceDependencies,
  type ClaimLifecycleContext,
} from './aws-claim-lifecycle-service.js';
import type { IdempotencyRecord } from './dynamodb-idempotency-items.js';

/**
 * Claim submission and resubmission, kept as an entry point that delegates to
 * `AwsClaimLifecycleService` (docs/aws-architecture.md, sections 8 to 10 and
 * 15). All behavior, including the bounded cancellation recovery, is that of
 * the lifecycle service's `SUBMIT` action.
 */

export type AwsClaimSubmissionServiceDependencies =
  AwsClaimLifecycleServiceDependencies;

/** The creation request context, plus the correlation ID of the event. */
export type ClaimSubmissionContext = ClaimLifecycleContext;

export class AwsClaimSubmissionService {
  private readonly lifecycle: AwsClaimLifecycleService;

  public constructor(deps: AwsClaimSubmissionServiceDependencies) {
    this.lifecycle = new AwsClaimLifecycleService(deps);
  }

  /** The winning idempotency record of the submission. */
  public submit(
    actor: Actor,
    claimId: string,
    input: unknown,
    context: ClaimSubmissionContext,
  ): Promise<IdempotencyRecord> {
    return this.lifecycle.perform(actor, claimId, 'SUBMIT', input, context);
  }
}
