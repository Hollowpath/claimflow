import {
  adminClaimListQuerySchema,
  claimListQuerySchema,
  idSchema,
} from '@claimflow/contracts';

import type { ClaimQueryService } from '../../application/claim-query-service.js';
import { NotFoundError } from '../../application/errors.js';
import type {
  ReadOperation,
  ReadOperationRequest,
} from '../../http/api-handler.js';
import type { AwsReceiptDownloadService } from './aws-receipt-download-service.js';

/**
 * The five claim reads as opt-in `ReadOperation`s for the request pipeline,
 * keyed by their route operation names. Each parses the route's path
 * parameter and query exactly as the route handler does, then calls the one
 * shared `ClaimQueryService`, so access rules (an invisible claim is a missing
 * one), role restrictions, pagination, and presentation are those of the local
 * runtime. They are meant to run over the AWS readers; nothing here touches
 * persistence directly.
 */

/** The route's claim ID, as the matched route decoded it; invalid is not found. */
function claimIdOf(request: ReadOperationRequest): string {
  const parsed = idSchema.safeParse(request.params.claimId);
  if (!parsed.success) {
    throw new NotFoundError();
  }
  return parsed.data;
}

export function claimReadOperations(
  service: Pick<
    ClaimQueryService,
    'get' | 'history' | 'listMine' | 'listReviewQueue' | 'listAll'
  >,
): Record<string, ReadOperation> {
  return {
    'claim.get': async (request) => ({
      status: 200,
      body: await service.get(request.actor, claimIdOf(request)),
    }),
    'claim.history': async (request) => ({
      status: 200,
      body: await service.history(
        request.actor,
        claimIdOf(request),
        claimListQuerySchema.parse(request.query),
      ),
    }),
    'claim.list_mine': async (request) => ({
      status: 200,
      body: await service.listMine(
        request.actor,
        claimListQuerySchema.parse(request.query),
      ),
    }),
    'claim.list_review_queue': async (request) => ({
      status: 200,
      body: await service.listReviewQueue(
        request.actor,
        claimListQuerySchema.parse(request.query),
      ),
    }),
    'claim.list_all': async (request) => {
      const { status, ...page } = adminClaimListQuerySchema.parse(
        request.query,
      );
      return {
        status: 200,
        body: await service.listAll(request.actor, status, page),
      };
    },
  };
}

/**
 * `receipt.read` for the AWS path: the documented `{ url, expiresAt }` reply,
 * with `no-store` caching because the URL is a short-lived capability. The
 * local runtime keeps its binary download.
 */
export function receiptDownloadRead(
  service: Pick<AwsReceiptDownloadService, 'download'>,
): ReadOperation {
  return async (request) => ({
    status: 200,
    body: await service.download(request.actor, claimIdOf(request)),
    headers: { 'Cache-Control': 'no-store' },
  });
}
