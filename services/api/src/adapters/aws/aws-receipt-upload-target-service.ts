import {
  hasRole,
  isChecksumSha256,
  sanitizeFileName,
  validateReceiptFile,
  type Actor,
  type Violation,
} from '@claimflow/domain';
import { z } from 'zod';

import {
  expiresAfter,
  toEpochSeconds,
  type CompletedRequest,
} from '../../application/commit.js';
import { ForbiddenError, ValidationError } from '../../application/errors.js';
import { idempotencyRetentionMs } from '../../application/idempotency.js';
import type { IdGenerator } from '../../application/ports.js';
import {
  businessRejection,
  checkContext,
  type ClaimCreationContext,
} from './aws-claim-creation-service.js';
import { pendingReceiptExpiresAt } from './dynamodb-receipt-items.js';
import type {
  PreparedReceiptRejection,
  PreparedReceiptUpload,
  ReceiptUploadCoordinator,
  ReceiptUploadRequest,
  ReceiptUploadResult,
} from './receipt-upload-coordinator.js';

/**
 * The receipt upload-target flow of docs/aws-architecture.md, section 11,
 * "Upload", as an isolated application flow that no route or composition uses
 * yet: a declaration `{ fileName, contentType, sizeBytes, checksumSha256 }`
 * becomes pending receipt metadata, an atomic idempotency record holding only
 * a reference to the receipt, and a fresh presigned upload form. It runs
 * through `ReceiptUploadCoordinator.run`, so a replay returns the stored
 * result (with a new form for the same receipt) before the declaration is
 * parsed or any ID is generated. Only inside the lazy preparation does it
 * check that the actor is an employee, parse the declaration with a strict
 * schema (so no owner or identity can come from the input), apply the existing
 * receipt rules and file-name sanitizer, generate the receipt ID, and build
 * the pending record with the actor as owner and the request time as upload
 * time. Expected authorization and declaration errors become explicit
 * `REJECTED` records through the same safe mapping as the claim services;
 * dependency, codec, and signing failures propagate unchanged. A signing
 * failure after the commit leaves the metadata in place, and a retry
 * recovers through the lookup. The raw-byte local upload, the browser
 * contracts, and the production wiring are unchanged.
 */

export interface AwsReceiptUploadTargetServiceDependencies {
  readonly uploads: Pick<ReceiptUploadCoordinator, 'run'>;
  readonly ids: IdGenerator;
}

/** Shape only; the domain applies the receipt rules. */
const declarationSchema = z.strictObject({
  fileName: z.string().min(1).max(1000),
  contentType: z.string().max(255),
  sizeBytes: z.number(),
  checksumSha256: z.string().max(128),
});

export class AwsReceiptUploadTargetService {
  public constructor(
    private readonly deps: AwsReceiptUploadTargetServiceDependencies,
  ) {
    if (typeof deps?.uploads?.run !== 'function') {
      throw new TypeError('The upload coordinator is missing.');
    }
    if (typeof deps.ids?.newId !== 'function') {
      throw new TypeError('The ID generator is missing.');
    }
  }

  /**
   * The governing idempotency record and, when it is a receipt reference, the
   * receipt ID with its fresh upload form. Whether this request committed or
   * replayed is not reported.
   */
  public create(
    actor: Actor,
    input: unknown,
    context: ClaimCreationContext,
  ): Promise<ReceiptUploadResult> {
    checkContext(actor, context);
    const request: ReceiptUploadRequest = {
      actorId: actor.userId,
      key: context.idempotencyKey,
      fingerprint: context.fingerprint,
      nowEpoch: toEpochSeconds(new Date(context.now)),
    };
    const expiresAt = expiresAfter(
      new Date(context.now),
      idempotencyRetentionMs,
    );
    return this.deps.uploads.run(request, () =>
      this.prepare(actor, input, context, expiresAt),
    );
  }

  private prepare(
    actor: Actor,
    input: unknown,
    context: ClaimCreationContext,
    expiresAt: number,
  ): Promise<PreparedReceiptUpload | PreparedReceiptRejection> {
    let declaration: z.infer<typeof declarationSchema>;
    try {
      if (!hasRole(actor, 'EMPLOYEE')) {
        throw new ForbiddenError('Only employees may upload receipts.');
      }
      declaration = declarationSchema.parse(input);
      const violations: Violation[] = [...validateReceiptFile(declaration)];
      if (!isChecksumSha256(declaration.checksumSha256)) {
        violations.push({
          field: 'checksumSha256',
          code: 'INVALID_CHECKSUM',
          message: 'The checksum must be a lower-case SHA-256 hex digest.',
        });
      }
      if (violations.length > 0) {
        throw new ValidationError(
          'The receipt cannot be accepted.',
          violations,
        );
      }
    } catch (error) {
      return Promise.resolve(
        businessRejection(error, actor, context, expiresAt),
      );
    }

    // Only now, with an acceptable declaration, is an ID generated.
    const receiptId = this.deps.ids.newId();
    const completed: CompletedRequest = {
      actorId: actor.userId,
      key: context.idempotencyKey,
      fingerprint: context.fingerprint,
      response: { status: 201, resultRef: { receiptId } },
      createdAt: context.now,
      expiresAt,
    };
    return Promise.resolve({
      pending: {
        receiptId,
        ownerId: actor.userId,
        state: 'PENDING',
        fileName: sanitizeFileName(declaration.fileName),
        declaredContentType:
          declaration.contentType as PreparedReceiptUpload['pending']['declaredContentType'],
        declaredSizeBytes: declaration.sizeBytes,
        declaredChecksumSha256: declaration.checksumSha256,
        uploadedAt: context.now,
        expiresAt: pendingReceiptExpiresAt(context.now),
      },
      completed,
    });
  }
}
