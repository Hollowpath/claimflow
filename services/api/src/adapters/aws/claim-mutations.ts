import { claimActionPaths } from '@claimflow/contracts';
import type { ClaimAction } from '@claimflow/domain';

import { isResultReference } from '../../application/commit.js';
import type { StoredResponse } from '../../application/ports.js';
import type {
  IdempotentMutation,
  IdempotentMutationRequest,
} from '../../http/api-handler.js';
import type { AwsCategoryService } from './aws-category-service.js';
import type { AwsClaimCreationService } from './aws-claim-creation-service.js';
import type { AwsClaimDraftEditingService } from './aws-claim-draft-editing-service.js';
import type { AwsClaimLifecycleService } from './aws-claim-lifecycle-service.js';
import type {
  AwsDraftDeletionService,
  AwsReceiptRemovalService,
} from './aws-claim-removal-services.js';
import type { AwsReceiptUploadTargetService } from './aws-receipt-upload-target-service.js';
import type { AwsReceiptAttachmentService } from './aws-receipt-attachment-service.js';
import type { IdempotencyRecord } from './dynamodb-idempotency-items.js';

/**
 * Adapters from the AWS claim services to the request pipeline's opt-in
 * `IdempotentMutation` seam (docs/aws-architecture.md, section 10). Each one
 * turns the pipeline's context into the service's request context and the
 * winning stored record into the stored response. The claim ID comes only from
 * the matched route's path parameters, and a lifecycle action only from the
 * server-side registration of its operation, never from the body. A result
 * reference is not a response and never occurs for these operations, so it is
 * refused as a programming error (a generic `500`). No persistence type
 * reaches the browser contracts.
 */

/** The stored response of a record, refusing a result reference. */
export function storedResponse(record: IdempotencyRecord): StoredResponse {
  if (isResultReference(record.response)) {
    throw new TypeError('A claim mutation cannot store a result reference.');
  }
  return { status: record.response.status, body: record.response.body };
}

const context = (request: IdempotentMutationRequest) => ({
  idempotencyKey: request.idempotencyKey,
  fingerprint: request.fingerprint,
  now: request.now,
  requestId: request.requestId,
});

/** The route's claim ID, as the matched route decoded it. */
function claimIdOf(request: IdempotentMutationRequest): string {
  const claimId = request.params.claimId;
  if (claimId === undefined) {
    throw new TypeError('The route has no claim ID.');
  }
  return claimId;
}

/** `claim.create`: the claim is created from the body. */
export function claimCreationMutation(
  service: Pick<AwsClaimCreationService, 'create'>,
): IdempotentMutation {
  return async (request) =>
    storedResponse(
      await service.create(request.actor, request.body, context(request)),
    );
}

/** `claim.update`: the draft named by the route is edited with the body. */
export function claimEditMutation(
  service: Pick<AwsClaimDraftEditingService, 'update'>,
): IdempotentMutation {
  return async (request) =>
    storedResponse(
      await service.update(
        request.actor,
        claimIdOf(request),
        request.body,
        context(request),
      ),
    );
}

/** One lifecycle action, fixed by the registration and not by the request. */
export function claimLifecycleMutation(
  service: Pick<AwsClaimLifecycleService, 'perform'>,
  action: ClaimAction,
): IdempotentMutation {
  return async (request) =>
    storedResponse(
      await service.perform(
        request.actor,
        claimIdOf(request),
        action,
        request.body,
        { ...context(request), correlationId: request.correlationId },
      ),
    );
}

/**
 * The six lifecycle routes, keyed by their operation names (`claim.submit`,
 * `claim.start-review`, and so on), each bound to its own action.
 */
export function claimLifecycleMutations(
  service: Pick<AwsClaimLifecycleService, 'perform'>,
): Record<string, IdempotentMutation> {
  return Object.fromEntries(
    (Object.entries(claimActionPaths) as [ClaimAction, string][]).map(
      ([action, segment]) => [
        `claim.${segment}`,
        claimLifecycleMutation(service, action),
      ],
    ),
  );
}

/** The pipeline's context plus the correlation ID of the cleanup events. */
const eventContext = (request: IdempotentMutationRequest) => ({
  ...context(request),
  correlationId: request.correlationId,
});

/** `receipt.attach`: attaches or replaces the receipt of the route's claim. */
export function receiptAttachMutation(
  service: Pick<AwsReceiptAttachmentService, 'attach'>,
): IdempotentMutation {
  return async (request) =>
    storedResponse(
      await service.attach(
        request.actor,
        claimIdOf(request),
        request.body,
        eventContext(request),
      ),
    );
}

/** `receipt.remove`: removes the receipt of the route's claim (`200`). */
export function receiptRemoveMutation(
  service: Pick<AwsReceiptRemovalService, 'remove'>,
): IdempotentMutation {
  return async (request) =>
    storedResponse(
      await service.remove(
        request.actor,
        claimIdOf(request),
        request.body,
        eventContext(request),
      ),
    );
}

/** `claim.delete`: deletes the route's never-submitted draft (`204`). */
export function claimDeleteMutation(
  service: Pick<AwsDraftDeletionService, 'delete'>,
): IdempotentMutation {
  return async (request) =>
    storedResponse(
      await service.delete(
        request.actor,
        claimIdOf(request),
        request.body,
        eventContext(request),
      ),
    );
}

/** The route's category ID, as the matched route decoded it. */
function categoryIdOf(request: IdempotentMutationRequest): string {
  const categoryId = request.params.categoryId;
  if (categoryId === undefined) {
    throw new TypeError('The route has no category ID.');
  }
  return categoryId;
}

/** `category.create`: the category is created from the body (`201`). */
export function categoryCreateMutation(
  service: Pick<AwsCategoryService, 'create'>,
): IdempotentMutation {
  return async (request) =>
    storedResponse(
      await service.create(request.actor, request.body, eventContext(request)),
    );
}

/** `category.update`: the route's category is changed with the body. */
export function categoryUpdateMutation(
  service: Pick<AwsCategoryService, 'update'>,
): IdempotentMutation {
  return async (request) =>
    storedResponse(
      await service.update(
        request.actor,
        categoryIdOf(request),
        request.body,
        eventContext(request),
      ),
    );
}

/** `category.delete`: the route's unused category is deleted (`204`). */
export function categoryDeleteMutation(
  service: Pick<AwsCategoryService, 'delete'>,
): IdempotentMutation {
  return async (request) =>
    storedResponse(
      await service.delete(
        request.actor,
        categoryIdOf(request),
        request.body,
        eventContext(request),
      ),
    );
}

/**
 * The body mode to register next to `receiptUploadTargetMutation`: this AWS
 * operation reads its declaration as JSON, where the local route reads raw
 * bytes. It is chosen here, never inferred from the content type.
 */
export const receiptUploadTargetBodyModes = {
  'receipt.upload': 'json',
} as const;

/**
 * `receipt.upload` for the AWS path: `201` with `{ receiptId, form }`. Only
 * a reference is stored, so a replay returns the same receipt with a newly
 * signed form; a stored rejection is returned unchanged. Every API response is
 * `no-store`, which matters because the form is a short-lived capability; the
 * form is never logged or persisted.
 */
export function receiptUploadTargetMutation(
  service: Pick<AwsReceiptUploadTargetService, 'create'>,
): IdempotentMutation {
  return async (request) => {
    const { record, upload } = await service.create(
      request.actor,
      request.body,
      context(request),
    );
    if (!isResultReference(record.response)) {
      return storedResponse(record);
    }
    if (upload === undefined) {
      throw new TypeError('A receipt reference has no upload form.');
    }
    return {
      status: 201,
      body: {
        receiptId: upload.receiptId,
        form: { url: upload.form.url, fields: upload.form.fields },
      },
    };
  };
}
