export const apiErrorStatus = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  SELF_REVIEW_FORBIDDEN: 403,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  INVALID_TRANSITION: 409,
  CLAIM_NOT_EDITABLE: 409,
  CLAIM_NOT_DELETABLE: 409,
  CATEGORY_IN_USE: 409,
  IDEMPOTENCY_CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  INTERNAL_ERROR: 500,
} as const;

export type ApiErrorCode = keyof typeof apiErrorStatus;

export interface FieldError {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

/** The body of every non-2xx response. */
export interface ErrorResponse {
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
    readonly requestId: string;
    readonly details?: readonly FieldError[];
  };
}
