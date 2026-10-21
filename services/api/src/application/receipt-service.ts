import { createHash } from 'node:crypto';

import type {
  AttachReceiptRequest,
  ClaimDto,
  ReceiptContentType,
  UploadedReceiptDto,
} from '@claimflow/contracts';
import {
  attachReceipt,
  detectReceiptContentType,
  hasRole,
  removeReceipt,
  sanitizeFileName,
  validateReceiptFile,
  type Actor,
  type Claim,
  type ClaimChange,
  type UploadedReceipt,
} from '@claimflow/domain';

import { assertVersion, loadVisibleClaim } from './claim-access.js';
import { ForbiddenError, NotFoundError, ValidationError } from './errors.js';
import type {
  CategoryRepository,
  ClaimRepository,
  Clock,
  IdGenerator,
  Logger,
  ReceiptStorage,
  UserDirectory,
} from './ports.js';
import {
  claimUserIds,
  loadNames,
  toClaimDto,
  toUploadedReceiptDto,
} from './presenters.js';

export interface ReceiptServiceDependencies {
  readonly claims: ClaimRepository;
  readonly categories: CategoryRepository;
  readonly users: UserDirectory;
  readonly receipts: ReceiptStorage;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
}

export interface ReceiptUpload {
  readonly fileName: string;
  readonly contentType: string;
  readonly content: Uint8Array;
}

export interface ReceiptFile {
  readonly fileName: string;
  readonly contentType: ReceiptContentType;
  readonly content: Uint8Array;
}

export function sha256Hex(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

export class ReceiptService {
  public constructor(private readonly deps: ReceiptServiceDependencies) {}

  /** Stores an upload, measured by the server, ready to attach to a claim. */
  public async upload(
    actor: Actor,
    { fileName, contentType, content }: ReceiptUpload,
  ): Promise<UploadedReceiptDto> {
    if (!hasRole(actor, 'EMPLOYEE')) {
      throw new ForbiddenError('Only employees may upload receipts.');
    }

    const violations = [
      ...validateReceiptFile({ contentType, sizeBytes: content.byteLength }),
    ];
    if (
      violations.length === 0 &&
      detectReceiptContentType(content) !== contentType
    ) {
      violations.push({
        field: 'contentType',
        code: 'INVALID_RECEIPT_TYPE',
        message: 'The file contents do not match its declared type.',
      });
    }
    if (violations.length > 0) {
      throw new ValidationError('The receipt cannot be accepted.', violations);
    }

    const upload: UploadedReceipt = {
      receiptId: this.deps.ids.newId(),
      ownerId: actor.userId,
      fileName: sanitizeFileName(fileName),
      contentType: contentType as ReceiptContentType,
      sizeBytes: content.byteLength,
      checksumSha256: sha256Hex(content),
      uploadedAt: this.deps.clock.now().toISOString(),
    };
    await this.deps.receipts.save(upload, content);
    return toUploadedReceiptDto(upload);
  }

  /** Attaches or replaces the claim's receipt after verifying the upload. */
  public async attach(
    actor: Actor,
    claimId: string,
    { expectedVersion, receiptId, ...declaration }: AttachReceiptRequest,
  ): Promise<ClaimDto> {
    const claim = await loadVisibleClaim(this.deps.claims, actor, claimId);
    assertVersion(claim, expectedVersion);

    const upload = await this.deps.receipts.getMetadata(receiptId);
    const content =
      upload === undefined
        ? undefined
        : await this.deps.receipts.read(receiptId);
    if (upload === undefined || content === undefined) {
      throw unavailable();
    }

    const change = attachReceipt(
      claim,
      upload,
      declaration,
      this.context(actor),
    );
    if (sha256Hex(content) !== upload.checksumSha256) {
      // Stored bytes no longer match the recorded metadata.
      this.deps.logger.error('receipt.integrity_failed', { receiptId });
      throw unavailable();
    }

    await this.deps.claims.update(change, claim.version);
    await this.deps.receipts.markAttached(receiptId, claimId);
    if (claim.receipt !== undefined && claim.receipt.receiptId !== receiptId) {
      await this.discard(claim.receipt.receiptId);
    }
    return this.present(change, actor);
  }

  public async remove(
    actor: Actor,
    claimId: string,
    expectedVersion: number,
  ): Promise<ClaimDto> {
    const claim = await loadVisibleClaim(this.deps.claims, actor, claimId);
    assertVersion(claim, expectedVersion);
    const change = removeReceipt(claim, this.context(actor));
    await this.deps.claims.update(change, claim.version);
    if (claim.receipt !== undefined) {
      await this.discard(claim.receipt.receiptId);
    }
    return this.present(change, actor);
  }

  /** Returns the receipt file to anyone who may view the claim. */
  public async read(actor: Actor, claimId: string): Promise<ReceiptFile> {
    const claim: Claim = await loadVisibleClaim(
      this.deps.claims,
      actor,
      claimId,
    );
    const receipt = claim.receipt;
    const content =
      receipt === undefined
        ? undefined
        : await this.deps.receipts.read(receipt.receiptId);
    if (receipt === undefined || content === undefined) {
      throw new NotFoundError('This claim has no receipt.');
    }
    return {
      fileName: receipt.fileName,
      contentType: receipt.contentType,
      content,
    };
  }

  /** Deletes uploads abandoned before being attached to any claim. */
  public async purgeAbandonedUploads(olderThanMs: number): Promise<number> {
    const cutoff = new Date(
      this.deps.clock.now().getTime() - olderThanMs,
    ).toISOString();
    return this.deps.receipts.deleteUnattachedBefore(cutoff);
  }

  private async discard(receiptId: string): Promise<void> {
    try {
      await this.deps.receipts.delete(receiptId);
    } catch (error) {
      // The claim change is already saved; an orphaned file is harmless.
      this.deps.logger.warn('receipt.delete_failed', {
        receiptId,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  private context(actor: Actor) {
    return { actor, now: this.deps.clock.now().toISOString() };
  }

  private async present(change: ClaimChange, actor: Actor): Promise<ClaimDto> {
    return toClaimDto(
      change.claim,
      actor,
      await loadNames(
        this.deps.users,
        this.deps.categories,
        claimUserIds(change.claim),
      ),
    );
  }
}

export function unavailable(): ValidationError {
  return new ValidationError('The receipt cannot be attached.', [
    {
      field: 'receiptId',
      code: 'RECEIPT_UNAVAILABLE',
      message: 'The receipt does not exist or cannot be attached.',
    },
  ]);
}
