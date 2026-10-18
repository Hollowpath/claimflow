import { createHash, randomUUID } from 'node:crypto';

import {
  apiBasePath,
  headers,
  idempotencyKeySchema,
  maxReceiptSizeBytes,
} from '@claimflow/contracts';
import type { Actor } from '@claimflow/domain';

import {
  NotFoundError,
  PayloadTooLargeError,
  UnauthenticatedError,
  ValidationError,
} from '../application/errors.js';
import type { StoredResponse } from '../application/ports.js';
import { isTraceId } from '../application/tracing.js';
import type { Application } from '../composition.js';
import { toErrorReply } from './http-errors.js';
import type { Reply, Route, RouteContext } from './routes.js';

export const maxJsonBytes = 64 * 1024;

/** An API request, independent of the transport that received it. */
export interface ApiRequest {
  readonly method: string;
  /** The URL path, including the API base path. */
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  /** One value per header, keyed by lower-case name. */
  readonly headers: Readonly<Record<string, string>>;
  /**
   * The Cognito `sub` claim of a token that API Gateway's JWT authorizer has
   * already validated. Only that transport sets it; local requests leave it
   * unset. It identifies the user but carries no roles or permissions.
   */
  readonly verifiedSubject?: string;
  /**
   * Reads the whole body, or returns `undefined` as soon as the body is known
   * to exceed `limitBytes`. Called at most once, and only when a route needs
   * the body.
   */
  readonly readBody: (limitBytes: number) => Promise<Uint8Array | undefined>;
}

/** An API response for the transport to write. */
export interface ApiResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** JSON text, binary file content, or no body. */
  readonly body?: string | Uint8Array;
}

/** The signed-in actor for a request, or `undefined` if there is none. */
export type AuthenticationResolver = (
  request: ApiRequest,
) => Promise<Actor | undefined>;

/** Processes one API request. It never rejects; failures become responses. */
export type ApiHandler = (request: ApiRequest) => Promise<ApiResponse>;

export interface ApiHandlerOptions {
  readonly routes: readonly Route[];
  readonly authenticate: AuthenticationResolver;
}

interface CompiledRoute {
  readonly route: Route;
  readonly pattern: RegExp;
  readonly paramNames: readonly string[];
}

/**
 * Creates the request pipeline shared by every transport: routing,
 * authentication, body parsing, idempotency, error conversion, request and
 * correlation IDs, response headers, and request logging.
 */
export function createApiHandler(
  app: Pick<Application, 'idempotency' | 'logger'>,
  options: ApiHandlerOptions,
): ApiHandler {
  const routes = options.routes.map(compile);
  return (request) => handle(app, routes, options.authenticate, request);
}

async function handle(
  app: Pick<Application, 'idempotency' | 'logger'>,
  routes: readonly CompiledRoute[],
  authenticate: AuthenticationResolver,
  request: ApiRequest,
): Promise<ApiResponse> {
  const started = performance.now();
  const requestId = randomUUID();
  const incomingCorrelation = headerValue(request, headers.correlationId);
  const correlationId =
    incomingCorrelation !== undefined && isTraceId(incomingCorrelation)
      ? incomingCorrelation
      : requestId;
  const { method } = request;
  const path = request.path.startsWith(`${apiBasePath}/`)
    ? request.path.slice(apiBasePath.length)
    : undefined;
  const match =
    path === undefined ? undefined : findRoute(routes, method, path);
  let actorId: string | undefined;
  let reply: Reply;
  let replayed = false;
  let failure: unknown;

  try {
    if (path === undefined || match === undefined) {
      throw new NotFoundError('No such endpoint.');
    }
    const { route, params } = match;
    const actor = await authenticate(request);
    actorId = actor?.userId;
    if (route.auth && actor === undefined) {
      throw new UnauthenticatedError();
    }

    const raw = await readBody(request, route);
    const context: RouteContext = {
      actor,
      params,
      query: request.query,
      body: route.body === 'json' ? parseJson(raw, request) : undefined,
      raw,
      header: (name) => headerValue(request, name),
    };

    if (route.idempotent && actor !== undefined) {
      const key = idempotencyKeySchema.safeParse(
        headerValue(request, headers.idempotencyKey),
      );
      if (!key.success) {
        throw new ValidationError(
          'A valid Idempotency-Key header is required.',
          [
            {
              field: headers.idempotencyKey,
              code: 'INVALID',
              message: key.error.issues[0]?.message ?? 'Required.',
            },
          ],
        );
      }
      const fingerprint = createHash('sha256')
        .update(
          `${method} ${path}\n${headerValue(request, headers.fileName) ?? ''}\n`,
        )
        .update(raw)
        .digest('hex');
      const result = await app.idempotency.run(
        actor.userId,
        key.data,
        fingerprint,
        async (): Promise<StoredResponse> => {
          try {
            const { status, body } = await route.handle(context);
            return { status, body };
          } catch (error) {
            const errorReply = toErrorReply(error, requestId);
            if (errorReply.status >= 500) {
              throw error;
            }
            return errorReply;
          }
        },
      );
      replayed = result.replayed;
      reply = result.response;
    } else {
      reply = await route.handle(context);
    }
  } catch (error) {
    failure = error;
    reply = toErrorReply(error, requestId);
  }

  const fields = {
    requestId,
    correlationId,
    method,
    route: match?.route.path ?? 'unmatched',
    operation: match?.route.operation ?? 'unmatched',
    actorId,
    claimId: match?.params.claimId,
    status: reply.status,
    outcome:
      reply.status >= 500 ? 'error' : reply.status >= 400 ? 'rejected' : 'ok',
    replayed,
    durationMs: Math.round(performance.now() - started),
  };
  if (reply.status >= 500) {
    app.logger.error('http.request', {
      ...fields,
      error: failure instanceof Error ? failure.stack : String(failure),
    });
  } else {
    app.logger.info('http.request', fields);
  }

  return toResponse(reply, {
    [headers.requestId]: requestId,
    [headers.correlationId]: correlationId,
    ...(replayed ? { 'Idempotent-Replayed': 'true' } : {}),
  });
}

function compile(route: Route): CompiledRoute {
  const paramNames: string[] = [];
  const source = route.path.replace(/:(\w+)/g, (_match, name: string) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  return { route, pattern: new RegExp(`^${source}$`), paramNames };
}

/** The matching route, or `undefined`, also when a segment is malformed. */
function findRoute(
  routes: readonly CompiledRoute[],
  method: string,
  path: string,
): { route: Route; params: Record<string, string> } | undefined {
  for (const { route, pattern, paramNames } of routes) {
    const found = route.method === method ? pattern.exec(path) : null;
    if (found !== null) {
      const params: Record<string, string> = {};
      for (const [index, name] of paramNames.entries()) {
        const value = decodeSegment(found[index + 1] ?? '');
        if (value === undefined) {
          return undefined;
        }
        params[name] = value;
      }
      return { route, params };
    }
  }
  return undefined;
}

function decodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

function headerValue(request: ApiRequest, name: string): string | undefined {
  return request.headers[name.toLowerCase()];
}

async function readBody(
  request: ApiRequest,
  route: Route,
): Promise<Uint8Array> {
  if (route.body === 'none') {
    return new Uint8Array();
  }
  const limit = route.body === 'raw' ? maxReceiptSizeBytes : maxJsonBytes;
  const body = await request.readBody(limit);
  if (body === undefined) {
    throw new PayloadTooLargeError(
      route.body === 'raw'
        ? 'Receipts must be 10 MB or smaller.'
        : 'The request body is too large.',
    );
  }
  return body;
}

function parseJson(raw: Uint8Array, request: ApiRequest): unknown {
  if (raw.byteLength === 0) {
    return undefined;
  }
  const contentType = headerValue(request, 'content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new ValidationError('Send the request body as application/json.');
  }
  try {
    return JSON.parse(Buffer.from(raw).toString('utf8'));
  } catch {
    throw new ValidationError('The request body is not valid JSON.');
  }
}

function toResponse(
  reply: Reply,
  extraHeaders: Record<string, string>,
): ApiResponse {
  const responseHeaders = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
    ...reply.headers,
  };
  if (reply.file !== undefined) {
    return {
      status: reply.status,
      headers: {
        ...responseHeaders,
        'Content-Length': String(reply.file.byteLength),
      },
      body: reply.file,
    };
  }
  if (reply.body === undefined) {
    return { status: reply.status, headers: responseHeaders };
  }
  return {
    status: reply.status,
    headers: {
      ...responseHeaders,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(reply.body),
  };
}
