import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

import {
  apiBasePath,
  headers,
  idempotencyKeySchema,
  maxReceiptSizeBytes,
} from '@claimflow/contracts';

import {
  NotFoundError,
  PayloadTooLargeError,
  UnauthenticatedError,
  ValidationError,
} from '../application/errors.js';
import type { StoredResponse } from '../application/ports.js';
import type { Application } from '../composition.js';
import { toErrorReply } from './http-errors.js';
import {
  createRoutes,
  type Reply,
  type Route,
  type RouteContext,
} from './routes.js';
import type { SessionCookies } from './session-cookie.js';

const maxJsonBytes = 64 * 1024;
const correlationIdPattern = /^[A-Za-z0-9_.:-]{1,128}$/;

export interface ServerOptions {
  readonly cookies: SessionCookies;
  /** Directory of the built web app to serve, if any. */
  readonly webRoot?: string;
}

interface CompiledRoute {
  readonly route: Route;
  readonly pattern: RegExp;
  readonly paramNames: readonly string[];
}

export function createHttpServer(
  app: Application,
  options: ServerOptions,
): Server {
  const routes = createRoutes(app, options.cookies).map(compile);
  return createServer((request, response) => {
    void handle(app, routes, options, request, response);
  });
}

async function handle(
  app: Application,
  routes: readonly CompiledRoute[],
  options: ServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const started = performance.now();
  const requestId = randomUUID();
  const incomingCorrelation = request.headers['x-correlation-id'];
  const correlationId =
    typeof incomingCorrelation === 'string' &&
    correlationIdPattern.test(incomingCorrelation)
      ? incomingCorrelation
      : requestId;
  const url = new URL(request.url ?? '/', 'http://localhost');
  const method = request.method ?? 'GET';

  if (!url.pathname.startsWith(`${apiBasePath}/`)) {
    await serveWeb(options.webRoot, url.pathname, method, response);
    return;
  }

  const path = url.pathname.slice(apiBasePath.length);
  const match = findRoute(routes, method, path);
  let actorId: string | undefined;
  let reply: Reply;
  let replayed = false;
  let failure: unknown;

  try {
    if (match === undefined) {
      throw new NotFoundError('No such endpoint.');
    }
    const { route, params } = match;
    const userId = options.cookies.read(request.headers.cookie);
    const actor =
      userId === undefined ? undefined : await app.sessions.actorFor(userId);
    actorId = actor?.userId;
    if (route.auth && actor === undefined) {
      throw new UnauthenticatedError();
    }

    const raw =
      route.body === 'none' ? new Uint8Array() : await readBody(request, route);
    const context: RouteContext = {
      actor,
      params,
      query: Object.fromEntries(url.searchParams),
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

  send(response, reply, {
    [headers.requestId]: requestId,
    [headers.correlationId]: correlationId,
    ...(replayed ? { 'Idempotent-Replayed': 'true' } : {}),
  });

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
}

function compile(route: Route): CompiledRoute {
  const paramNames: string[] = [];
  const source = route.path.replace(/:(\w+)/g, (_match, name: string) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  return { route, pattern: new RegExp(`^${source}$`), paramNames };
}

function findRoute(
  routes: readonly CompiledRoute[],
  method: string,
  path: string,
): { route: Route; params: Record<string, string> } | undefined {
  for (const { route, pattern, paramNames } of routes) {
    const found = route.method === method ? pattern.exec(path) : null;
    if (found !== null) {
      const params: Record<string, string> = {};
      paramNames.forEach((name, index) => {
        params[name] = decodeURIComponent(found[index + 1] ?? '');
      });
      return { route, params };
    }
  }
  return undefined;
}

function headerValue(
  request: IncomingMessage,
  name: string,
): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

async function readBody(
  request: IncomingMessage,
  route: Route,
): Promise<Uint8Array> {
  const limit = route.body === 'raw' ? maxReceiptSizeBytes : maxJsonBytes;
  const tooLarge = new PayloadTooLargeError(
    route.body === 'raw'
      ? 'Receipts must be 10 MB or smaller.'
      : 'The request body is too large.',
  );
  const declared = Number(request.headers['content-length'] ?? 0);
  if (declared > limit) {
    request.resume();
    throw tooLarge;
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    if (total > limit) {
      request.resume();
      throw tooLarge;
    }
    chunks.push(buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function parseJson(raw: Uint8Array, request: IncomingMessage): unknown {
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

function send(
  response: ServerResponse,
  reply: Reply,
  extraHeaders: Record<string, string>,
): void {
  response.statusCode = reply.status;
  const allHeaders = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
    ...reply.headers,
  };
  for (const [name, value] of Object.entries(allHeaders)) {
    response.setHeader(name, value);
  }
  if (reply.file !== undefined) {
    response.setHeader('Content-Length', reply.file.byteLength);
    response.end(reply.file);
  } else if (reply.body === undefined) {
    response.end();
  } else {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(reply.body));
  }
}

const staticTypes: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.map': 'application/json',
};

/** Serves the built single-page app, falling back to index.html. */
async function serveWeb(
  webRoot: string | undefined,
  pathname: string,
  method: string,
  response: ServerResponse,
): Promise<void> {
  if (webRoot === undefined || (method !== 'GET' && method !== 'HEAD')) {
    response.statusCode = 404;
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.end('Not found. The web app runs on http://localhost:5173.');
    return;
  }

  const root = resolve(webRoot);
  let file = resolve(join(root, decodeURIComponent(pathname)));
  if (!file.startsWith(root + sep) || !(await isFile(file))) {
    file = join(root, 'index.html');
  }
  response.statusCode = 200;
  response.setHeader(
    'Content-Type',
    staticTypes[extname(file)] ?? 'application/octet-stream',
  );
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(method === 'HEAD' ? undefined : await readFile(file));
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
