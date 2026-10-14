import type { ApiErrorCode, FieldError } from '@claimflow/contracts';

/** An expected failure with a safe, user-facing message. */
export class ApplicationError extends Error {
  public constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly details: readonly FieldError[] = [],
  ) {
    super(message);
    this.name = 'ApplicationError';
  }
}

export class NotFoundError extends ApplicationError {
  public constructor(message = 'The requested item was not found.') {
    super('NOT_FOUND', message);
  }
}

export class ForbiddenError extends ApplicationError {
  public constructor(message: string) {
    super('FORBIDDEN', message);
  }
}

export class UnauthenticatedError extends ApplicationError {
  public constructor() {
    super('UNAUTHENTICATED', 'Choose a local user to continue.');
  }
}

export class ValidationError extends ApplicationError {
  public constructor(message: string, details: readonly FieldError[] = []) {
    super('VALIDATION_FAILED', message, details);
  }
}

export class VersionConflictError extends ApplicationError {
  public constructor() {
    super(
      'VERSION_CONFLICT',
      'This item was changed by someone else. Reload it and try again.',
    );
  }
}

export class IdempotencyConflictError extends ApplicationError {
  public constructor(message: string) {
    super('IDEMPOTENCY_CONFLICT', message);
  }
}

export class PayloadTooLargeError extends ApplicationError {
  public constructor(message: string) {
    super('PAYLOAD_TOO_LARGE', message);
  }
}
