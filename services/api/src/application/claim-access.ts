import { canViewClaim, type Actor, type Claim } from '@claimflow/domain';

import { NotFoundError, VersionConflictError } from './errors.js';
import type { ClaimRepository } from './ports.js';

/**
 * Loads a claim the actor may see. Claims the actor cannot see are reported
 * exactly like missing ones so their existence is not revealed.
 */
export async function loadVisibleClaim(
  claims: ClaimRepository,
  actor: Actor,
  claimId: string,
): Promise<Claim> {
  const claim = await claims.get(claimId);
  if (claim === undefined || !canViewClaim(claim, actor)) {
    throw new NotFoundError('Claim not found.');
  }
  return claim;
}

/** Rejects a change based on a stale copy before any work is done. */
export function assertVersion(
  current: { readonly version: number },
  expectedVersion: number,
): void {
  if (current.version !== expectedVersion) {
    throw new VersionConflictError();
  }
}
