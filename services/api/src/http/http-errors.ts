import {
  apiErrorStatus,
  type ApiErrorCode,
  type ErrorResponse,
  type FieldError,
} from '@claimflow/contracts';
import { DomainError } from '@claimflow/domain';
import { ZodError } from 'zod';

import { ApplicationError } from '../application/errors.js';

export interface ErrorReply {
  readonly status: number;
  readonly body: ErrorResponse;
}

/**
 * Converts any thrown value to a safe JSON error. Unexpected errors become a
 * generic 500 so internal details never reach the client.
 */
export function toErrorReply(error: unknown, requestId: string): ErrorReply {
  if (error instanceof ApplicationError) {
    return reply(error.code, error.message, requestId, error.details);
  }
  if (error instanceof DomainError) {
    return reply(error.code, error.message, requestId, error.violations);
  }
  if (error instanceof ZodError) {
    return reply(
      'VALIDATION_FAILED',
      'The request is not valid.',
      requestId,
      error.issues.map((issue) => ({
        field: issue.path.join('.') || 'body',
        code: 'INVALID',
        message: issue.message,
      })),
    );
  }
  return reply(
    'INTERNAL_ERROR',
    'Something went wrong. Please try again.',
    requestId,
  );
}

function reply(
  code: ApiErrorCode,
  message: string,
  requestId: string,
  details: readonly FieldError[] = [],
): ErrorReply {
  return {
    status: apiErrorStatus[code],
    body: {
      error: {
        code,
        message,
        requestId,
        ...(details.length === 0
          ? {}
          : {
              details: details.map(({ field, code: c, message: m }) => ({
                field,
                code: c,
                message: m,
              })),
            }),
      },
    },
  };
}
