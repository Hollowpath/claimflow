export const domainErrorCodes = [
  'VALIDATION_FAILED',
  'FORBIDDEN',
  'SELF_REVIEW_FORBIDDEN',
  'INVALID_TRANSITION',
  'CLAIM_NOT_EDITABLE',
  'CLAIM_NOT_DELETABLE',
] as const;

export type DomainErrorCode = (typeof domainErrorCodes)[number];

export const violationCodes = [
  'REQUIRED',
  'TOO_LONG',
  'INVALID_AMOUNT',
  'INVALID_CURRENCY',
  'CURRENCY_MISMATCH',
  'INVALID_DATE',
  'FUTURE_DATE',
  'CATEGORY_NOT_FOUND',
  'CATEGORY_INACTIVE',
  'LIMIT_EXCEEDED',
  'RECEIPT_REQUIRED',
  'NO_RECEIPT',
  'RECEIPT_UNAVAILABLE',
  'RECEIPT_MISMATCH',
  'INVALID_RECEIPT_TYPE',
  'INVALID_RECEIPT_SIZE',
  'INVALID_CHECKSUM',
  'NO_MANAGER_ASSIGNED',
  'COMMENT_REQUIRED',
  'INVALID_SETTING',
] as const;

export type ViolationCode = (typeof violationCodes)[number];

/** One problem with one input field. */
export interface Violation {
  readonly field: string;
  readonly code: ViolationCode;
  readonly message: string;
}

export class DomainError extends Error {
  public constructor(
    public readonly code: DomainErrorCode,
    message: string,
    public readonly violations: readonly Violation[] = [],
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

/** Throws a single `VALIDATION_FAILED` error carrying every violation. */
export function throwIfViolations(
  violations: readonly Violation[],
  message: string,
): void {
  if (violations.length > 0) {
    throw new DomainError('VALIDATION_FAILED', message, violations);
  }
}
