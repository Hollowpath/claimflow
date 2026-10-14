import {
  apiBasePath,
  headers,
  type ApiErrorCode,
  type ErrorResponse,
  type FieldError,
} from '@claimflow/contracts';

/** A failed API call with the server's safe message and field details. */
export class ApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: ApiErrorCode | 'NETWORK_ERROR',
    message: string,
    public readonly details: readonly FieldError[] = [],
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  public get isConflict(): boolean {
    return this.code === 'VERSION_CONFLICT';
  }
}

export interface RequestOptions {
  readonly json?: unknown;
  readonly file?: File;
  readonly signal?: AbortSignal;
}

type UnauthenticatedListener = () => void;
let onUnauthenticated: UnauthenticatedListener = () => undefined;

/** Lets the session provider react when the server forgets the session. */
export function setUnauthenticatedListener(
  listener: UnauthenticatedListener,
): void {
  onUnauthenticated = listener;
}

const retryDelayMs = 300;
const unreachableMessage =
  'Cannot reach the ClaimFlow API. Check that it is running.';

/**
 * Calls the local API. Every mutation carries a fresh idempotency key that is
 * reused if a network failure forces one automatic retry, so a request that
 * reached the server is never applied twice.
 */
export async function request<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const requestHeaders: Record<string, string> = {};
  let body: BodyInit | undefined;
  if (options.file !== undefined) {
    body = options.file;
    requestHeaders['Content-Type'] = options.file.type;
    requestHeaders[headers.fileName] = encodeURIComponent(options.file.name);
  } else if (options.json !== undefined) {
    body = JSON.stringify(options.json);
    requestHeaders['Content-Type'] = 'application/json';
  }
  if (method !== 'GET' && !path.startsWith('/session')) {
    requestHeaders[headers.idempotencyKey] = crypto.randomUUID();
  }

  const init: RequestInit = {
    method,
    headers: requestHeaders,
    credentials: 'same-origin',
    ...(body === undefined ? {} : { body }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };

  let response: Response;
  try {
    response = await fetch(`${apiBasePath}${path}`, init);
  } catch (error) {
    if (options.signal?.aborted === true) {
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    try {
      response = await fetch(`${apiBasePath}${path}`, init);
    } catch {
      throw new ApiError(0, 'NETWORK_ERROR', unreachableMessage);
    }
  }

  if (response.status === 204) {
    return undefined as T;
  }
  if (response.ok) {
    return (await response.json()) as T;
  }

  const error = await toApiError(response);
  if (error.code === 'UNAUTHENTICATED') {
    onUnauthenticated();
  }
  throw error;
}

async function toApiError(response: Response): Promise<ApiError> {
  try {
    const { error } = (await response.json()) as ErrorResponse;
    return new ApiError(
      response.status,
      error.code,
      error.message,
      error.details ?? [],
      error.requestId,
    );
  } catch {
    // The API always answers with a JSON error, so anything else came from
    // something in between, such as the dev proxy when the API is down.
    return new ApiError(response.status, 'NETWORK_ERROR', unreachableMessage);
  }
}
