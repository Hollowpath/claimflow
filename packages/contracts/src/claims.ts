import {
  claimStatuses,
  type ClaimAction,
  type ClaimHistoryAction,
  type ClaimStatus,
  type ReceiptContentType,
} from '@claimflow/domain';
import { z } from 'zod';

import {
  expectedVersionSchema,
  idSchema,
  moneySchema,
  pageQuerySchema,
  type MoneyDto,
  type PersonRef,
} from './common.js';

// Shape limits only; the domain applies the precise business rules.
const details = {
  categoryId: idSchema,
  amount: moneySchema,
  expenseDate: z.string().max(32),
  merchant: z.string().max(1000),
  businessPurpose: z.string().max(4000),
};

export const createClaimRequestSchema = z.strictObject(
  z.object(details).partial().shape,
);

/** `null` clears a field; an absent field is left unchanged. */
export const updateClaimRequestSchema = z.strictObject({
  expectedVersion: expectedVersionSchema,
  categoryId: details.categoryId.nullable().optional(),
  amount: details.amount.nullable().optional(),
  expenseDate: details.expenseDate.nullable().optional(),
  merchant: details.merchant.nullable().optional(),
  businessPurpose: details.businessPurpose.nullable().optional(),
});

export const claimActionRequestSchema = z.strictObject({
  expectedVersion: expectedVersionSchema,
});

export const claimDecisionRequestSchema = z.strictObject({
  expectedVersion: expectedVersionSchema,
  comment: z.string().max(4000),
});

export const attachReceiptRequestSchema = z.strictObject({
  expectedVersion: expectedVersionSchema,
  receiptId: idSchema,
  contentType: z.string().max(100),
  sizeBytes: z.number().int().nonnegative(),
  checksumSha256: z.string().max(128),
});

export const claimListQuerySchema = pageQuerySchema;

export const adminClaimListQuerySchema = pageQuerySchema.extend({
  status: z.enum(claimStatuses).optional(),
});

export type CreateClaimRequest = z.infer<typeof createClaimRequestSchema>;
export type UpdateClaimRequest = z.infer<typeof updateClaimRequestSchema>;
export type ClaimActionRequest = z.infer<typeof claimActionRequestSchema>;
export type ClaimDecisionRequest = z.infer<typeof claimDecisionRequestSchema>;
export type AttachReceiptRequest = z.infer<typeof attachReceiptRequestSchema>;

/** URL segment for each lifecycle action, e.g. `/claims/{id}/start-review`. */
export const claimActionPaths: Readonly<Record<ClaimAction, string>> = {
  SUBMIT: 'submit',
  START_REVIEW: 'start-review',
  APPROVE: 'approve',
  REJECT: 'reject',
  REOPEN: 'reopen',
  MARK_PAID: 'mark-paid',
};

export interface ReceiptDto {
  readonly receiptId: string;
  readonly fileName: string;
  readonly contentType: ReceiptContentType;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
  readonly attachedAt: string;
}

export interface UploadedReceiptDto {
  readonly receiptId: string;
  readonly fileName: string;
  readonly contentType: ReceiptContentType;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
  readonly uploadedAt: string;
}

/**
 * The JSON declaration of the presigned-upload flow (`POST /receipts` on the
 * AWS path). The server validates every field; none identifies the owner.
 */
export interface ReceiptUploadDeclaration {
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
}

/** A presigned POST form: the target URL and the fields to send with the file. */
export interface UploadFormDto {
  readonly url: string;
  readonly fields: Readonly<Record<string, string>>;
}

/** The `201` reply of the presigned-upload flow. */
export interface ReceiptUploadTargetDto {
  readonly receiptId: string;
  readonly form: UploadFormDto;
}

/** The reply of `GET /claims/{claimId}/receipt` on the AWS path. */
export interface ReceiptDownloadDto {
  /** A short-lived presigned S3 URL; it is the credential, so never log it. */
  readonly url: string;
  readonly expiresAt: string;
}

export interface ClaimDto {
  readonly claimId: string;
  readonly employee: PersonRef;
  readonly assignedManager?: PersonRef;
  readonly categoryId?: string;
  readonly categoryName?: string;
  readonly amount?: MoneyDto;
  readonly expenseDate?: string;
  readonly merchant?: string;
  readonly businessPurpose?: string;
  readonly receipt?: ReceiptDto;
  readonly status: ClaimStatus;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly submittedAt?: string;
  readonly reviewedAt?: string;
  /** What the current user may do, computed by the backend. */
  readonly permissions: {
    readonly canEdit: boolean;
    readonly canDelete: boolean;
    readonly actions: readonly ClaimAction[];
  };
}

export interface ClaimHistoryEntryDto {
  readonly version: number;
  readonly action: ClaimHistoryAction;
  readonly fromStatus?: ClaimStatus;
  readonly toStatus: ClaimStatus;
  readonly actor: PersonRef;
  readonly occurredAt: string;
  readonly comment?: string;
}
