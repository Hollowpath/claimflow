import { maxReceiptSizeBytes } from '@claimflow/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ValidationError } from '../src/application/errors.js';
import type { LogFields, Logger } from '../src/application/ports.js';
import {
  createLocalApplication,
  type Application,
} from '../src/composition.js';
import {
  createApiHandler,
  maxJsonBytes,
  type ApiHandler,
  type ApiRequest,
  type ApiResponse,
} from '../src/http/api-handler.js';
import { createLocalApiHandler } from '../src/http/local-api.js';
import type { Reply, Route } from '../src/http/routes.js';
import { SessionCookies } from '../src/http/session-cookie.js';
import { actors, steppingClock, temporaryDirectory } from './support.js';

interface LogEntry {
  readonly level: 'info' | 'warn' | 'error';
  readonly event: string;
  readonly fields: LogFields | undefined;
}

class RecordingLogger implements Logger {
  public readonly entries: LogEntry[] = [];
  public info(event: string, fields?: LogFields): void {
    this.entries.push({ level: 'info', event, fields });
  }
  public warn(event: string, fields?: LogFields): void {
    this.entries.push({ level: 'warn', event, fields });
  }
  public error(event: string, fields?: LogFields): void {
    this.entries.push({ level: 'error', event, fields });
  }
}

interface TestRequest extends ApiRequest {
  /** The limits passed to each `readBody` call. */
  readonly bodyReads: number[];
}

function request(
  method: string,
  path: string,
  init: {
    readonly headers?: Record<string, string>;
    readonly query?: Record<string, string>;
    readonly body?: string | Uint8Array;
  } = {},
): TestRequest {
  const bodyReads: number[] = [];
  const body =
    typeof init.body === 'string'
      ? new TextEncoder().encode(init.body)
      : (init.body ?? new Uint8Array());
  return {
    method,
    path,
    query: init.query ?? {},
    headers: init.headers ?? {},
    bodyReads,
    readBody: (limitBytes) => {
      bodyReads.push(limitBytes);
      return Promise.resolve(body.byteLength > limitBytes ? undefined : body);
    },
  };
}

const json = (
  body: unknown,
  headers: Record<string, string> = {},
): { headers: Record<string, string>; body: string } => ({
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

function bodyOf(response: ApiResponse): any {
  expect(typeof response.body).toBe('string');
  return JSON.parse(response.body as string);
}

const ok = (body: unknown): Reply => ({ status: 200, body });

let dir: Awaited<ReturnType<typeof temporaryDirectory>>;
let app: Application;
let logger: RecordingLogger;
let handler: ApiHandler;
let authenticated: ApiRequest[];
let created: number;

/** Routes that exercise each pipeline feature without application services. */
function testRoutes(): Route[] {
  const base = { auth: false, idempotent: false, body: 'none' } as const;
  return [
    {
      ...base,
      method: 'GET',
      path: '/items/:itemId',
      operation: 'item.get',
      handle: (context) =>
        Promise.resolve(
          ok({
            itemId: context.params.itemId,
            query: context.query,
            header: context.header('X-Test') ?? null,
          }),
        ),
    },
    {
      ...base,
      method: 'GET',
      path: '/private',
      operation: 'private.get',
      auth: true,
      handle: (context) =>
        Promise.resolve(ok({ userId: context.actor?.userId })),
    },
    {
      ...base,
      method: 'POST',
      path: '/items',
      operation: 'item.create',
      auth: true,
      idempotent: true,
      body: 'json',
      handle: (context) => {
        created += 1;
        return Promise.resolve({
          status: 201,
          body: { received: context.body, created },
        });
      },
    },
    {
      ...base,
      method: 'POST',
      path: '/rejections',
      operation: 'rejection.create',
      auth: true,
      idempotent: true,
      body: 'json',
      handle: () => {
        created += 1;
        throw new ValidationError('Rejected.');
      },
    },
    {
      ...base,
      method: 'POST',
      path: '/files',
      operation: 'file.upload',
      auth: true,
      idempotent: true,
      body: 'raw',
      handle: (context) =>
        Promise.resolve({
          status: 201,
          body: { size: context.raw.byteLength },
        }),
    },
    {
      ...base,
      method: 'GET',
      path: '/files/:fileId',
      operation: 'file.read',
      handle: () =>
        Promise.resolve({
          status: 200,
          file: new Uint8Array([1, 2, 3]),
          headers: { 'Content-Type': 'application/pdf' },
        }),
    },
    {
      ...base,
      method: 'GET',
      path: '/broken',
      operation: 'broken.get',
      handle: () => Promise.reject(new Error('internal detail')),
    },
  ];
}

beforeEach(async () => {
  dir = await temporaryDirectory();
  logger = new RecordingLogger();
  app = await createLocalApplication({
    dataDirectory: dir.path,
    clock: steppingClock(),
    logger,
  });
  authenticated = [];
  created = 0;
  handler = createApiHandler(app, {
    routes: testRoutes(),
    authenticate: (apiRequest) => {
      authenticated.push(apiRequest);
      return Promise.resolve(
        apiRequest.headers['x-test-user'] === 'aisha'
          ? actors.aisha
          : undefined,
      );
    },
  });
});

afterEach(async () => {
  await dir.remove();
});

const asAisha = { 'x-test-user': 'aisha' };
/** Signed in as Aisha with an idempotency key; keys need at least 8 characters. */
const key = (name: string) => ({
  ...asAisha,
  'idempotency-key': `test-key-${name}`,
});

describe('routing', () => {
  it('matches routes below the API base path and decodes parameters', async () => {
    const response = await handler(
      request('GET', '/api/v1/items/a%20b', {
        query: { page: '2' },
        headers: { 'x-test': 'value' },
      }),
    );

    expect(response.status).toBe(200);
    expect(bodyOf(response)).toEqual({
      itemId: 'a b',
      query: { page: '2' },
      header: 'value',
    });
  });

  it.each([
    ['an unknown path', 'GET', '/api/v1/unknown'],
    ['a known path with another method', 'DELETE', '/api/v1/items/x'],
    ['a path outside the API base path', 'GET', '/items/x'],
    ['the API base path itself', 'GET', '/api/v1'],
    ['a malformed percent-encoded segment', 'GET', '/api/v1/items/%E0%A4%A'],
  ])(
    'answers %s with 404 without authenticating',
    async (_name, method, path) => {
      const response = await handler(request(method, path));

      expect(response.status).toBe(404);
      expect(bodyOf(response).error).toMatchObject({
        code: 'NOT_FOUND',
        message: 'No such endpoint.',
      });
      expect(authenticated).toEqual([]);
      expect(logger.entries.at(-1)?.fields).toMatchObject({
        route: 'unmatched',
        operation: 'unmatched',
        status: 404,
        outcome: 'rejected',
      });
    },
  );
});

describe('authentication', () => {
  it('passes the normalized request to the resolver and gives handlers the actor', async () => {
    const apiRequest = request('GET', '/api/v1/private', { headers: asAisha });
    const response = await handler(apiRequest);

    expect(response.status).toBe(200);
    expect(bodyOf(response)).toEqual({ userId: 'u-aisha' });
    expect(authenticated).toEqual([apiRequest]);
  });

  it('rejects routes that require a user before reading the body', async () => {
    const apiRequest = request('POST', '/api/v1/items', json({ name: 'x' }));
    const response = await handler(apiRequest);

    expect(response.status).toBe(401);
    expect(bodyOf(response).error.code).toBe('UNAUTHENTICATED');
    expect(apiRequest.bodyReads).toEqual([]);
  });

  it('turns a failing resolver into a generic 500', async () => {
    const failing = createApiHandler(app, {
      routes: testRoutes(),
      authenticate: () => Promise.reject(new Error('directory unavailable')),
    });

    const response = await failing(request('GET', '/api/v1/items/x'));

    expect(response.status).toBe(500);
    expect(response.body).not.toContain('directory unavailable');
  });
});

describe('request bodies', () => {
  it('does not read the body of routes without one', async () => {
    const apiRequest = request('GET', '/api/v1/items/x', { body: 'ignored' });
    await handler(apiRequest);

    expect(apiRequest.bodyReads).toEqual([]);
  });

  it('parses JSON bodies within the 64 KiB limit', async () => {
    const apiRequest = request('POST', '/api/v1/items', {
      ...json({ name: 'Taxi' }, key('k-json')),
    });
    const response = await handler(apiRequest);

    expect(apiRequest.bodyReads).toEqual([maxJsonBytes]);
    expect(maxJsonBytes).toBe(64 * 1024);
    expect(response.status).toBe(201);
    expect(bodyOf(response).received).toEqual({ name: 'Taxi' });
  });

  it('reads raw bodies with the receipt size limit', async () => {
    const apiRequest = request('POST', '/api/v1/files', {
      headers: key('k-raw'),
      body: new Uint8Array(5),
    });
    const response = await handler(apiRequest);

    expect(apiRequest.bodyReads).toEqual([maxReceiptSizeBytes]);
    expect(bodyOf(response)).toEqual({ size: 5 });
  });

  it.each([
    ['/api/v1/items', 'The request body is too large.', maxJsonBytes],
    [
      '/api/v1/files',
      'Receipts must be 10 MB or smaller.',
      maxReceiptSizeBytes,
    ],
  ])(
    'answers an oversized body for %s with 413',
    async (path, message, limit) => {
      const response = await handler(
        request('POST', path, {
          headers: { ...key('k-large'), 'content-type': 'application/json' },
          body: new Uint8Array(limit + 1),
        }),
      );

      expect(response.status).toBe(413);
      expect(bodyOf(response).error).toMatchObject({
        code: 'PAYLOAD_TOO_LARGE',
        message,
      });
    },
  );

  it.each([
    [
      'a non-JSON content type',
      { 'content-type': 'text/plain' },
      'Send the request body as application/json.',
    ],
    [
      'malformed JSON',
      { 'content-type': 'application/json' },
      'The request body is not valid JSON.',
    ],
  ])('rejects %s', async (_name, headers, message) => {
    const response = await handler(
      request('POST', '/api/v1/items', {
        headers: { ...key('k-bad'), ...headers },
        body: '{not json',
      }),
    );

    expect(response.status).toBe(400);
    expect(bodyOf(response).error).toMatchObject({
      code: 'VALIDATION_FAILED',
      message,
    });
  });
});

describe('idempotency', () => {
  it('requires a valid Idempotency-Key on idempotent routes', async () => {
    const response = await handler(
      request('POST', '/api/v1/items', json({ name: 'x' }, asAisha)),
    );

    expect(response.status).toBe(400);
    expect(bodyOf(response).error.details[0].field).toBe('Idempotency-Key');
    expect(created).toBe(0);
  });

  it('replays a completed request without running it again', async () => {
    const send = () =>
      handler(
        request('POST', '/api/v1/items', json({ n: 1 }, key('k-replay'))),
      );
    const first = await send();
    const second = await send();

    expect(created).toBe(1);
    expect(second.status).toBe(201);
    expect(bodyOf(second)).toEqual(bodyOf(first));
    expect(first.headers).not.toHaveProperty('Idempotent-Replayed');
    expect(second.headers['Idempotent-Replayed']).toBe('true');
    expect(logger.entries.at(-1)?.fields).toMatchObject({ replayed: true });
  });

  it('refuses the same key for a different request', async () => {
    await handler(
      request('POST', '/api/v1/items', json({ n: 1 }, key('k-reuse'))),
    );
    const response = await handler(
      request('POST', '/api/v1/items', json({ n: 2 }, key('k-reuse'))),
    );

    expect(response.status).toBe(409);
    expect(bodyOf(response).error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('stores and replays rejected requests', async () => {
    const send = () =>
      handler(request('POST', '/api/v1/rejections', json({}, key('k-reject'))));
    const first = await send();
    const second = await send();

    expect(created).toBe(1);
    expect(first.status).toBe(400);
    expect(second.headers['Idempotent-Replayed']).toBe('true');
    expect(bodyOf(second).error.message).toBe('Rejected.');
  });
});

describe('responses', () => {
  it('adds the standard headers and JSON content type', async () => {
    const response = await handler(request('GET', '/api/v1/items/x'));

    expect(response.headers).toMatchObject({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Type': 'application/json; charset=utf-8',
    });
    expect(response.headers['X-Request-Id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers['X-Correlation-Id']).toBe(
      response.headers['X-Request-Id'],
    );
  });

  it('echoes a valid correlation ID and replaces an invalid one', async () => {
    const valid = await handler(
      request('GET', '/api/v1/items/x', {
        headers: { 'x-correlation-id': 'trace-1.a:b' },
      }),
    );
    const invalid = await handler(
      request('GET', '/api/v1/items/x', {
        headers: { 'x-correlation-id': 'not valid!' },
      }),
    );

    expect(valid.headers['X-Correlation-Id']).toBe('trace-1.a:b');
    expect(invalid.headers['X-Correlation-Id']).toBe(
      invalid.headers['X-Request-Id'],
    );
  });

  it('returns file replies as bytes with their own content type and length', async () => {
    const response = await handler(request('GET', '/api/v1/files/f-1'));

    expect(response.body).toEqual(new Uint8Array([1, 2, 3]));
    expect(response.headers['Content-Type']).toBe('application/pdf');
    expect(response.headers['Content-Length']).toBe('3');
  });

  it('hides unexpected errors behind a generic 500 and logs the stack', async () => {
    const response = await handler(request('GET', '/api/v1/broken'));
    const requestId = response.headers['X-Request-Id'];

    expect(response.status).toBe(500);
    expect(bodyOf(response)).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong. Please try again.',
        requestId,
      },
    });
    const entry = logger.entries.at(-1);
    expect(entry?.level).toBe('error');
    expect(entry?.fields).toMatchObject({ requestId, outcome: 'error' });
    expect(String(entry?.fields?.error)).toContain('internal detail');
  });
});

describe('request logging', () => {
  it('logs one structured entry per request', async () => {
    const response = await handler(
      request('GET', '/api/v1/private', {
        headers: { ...asAisha, 'x-correlation-id': 'trace-2' },
      }),
    );

    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]).toEqual({
      level: 'info',
      event: 'http.request',
      fields: {
        requestId: response.headers['X-Request-Id'],
        correlationId: 'trace-2',
        method: 'GET',
        route: '/private',
        operation: 'private.get',
        actorId: 'u-aisha',
        claimId: undefined,
        status: 200,
        outcome: 'ok',
        replayed: false,
        durationMs: expect.any(Number),
      },
    });
  });
});

describe('local API handler', () => {
  it('signs in and resolves the actor through the development session cookie', async () => {
    const local = createLocalApiHandler(app, new SessionCookies('test-secret'));

    const signIn = await local(
      request('PUT', '/api/v1/session', json({ userId: 'u-ben' })),
    );
    const cookie = signIn.headers['Set-Cookie']?.split(';')[0] ?? '';
    const session = await local(
      request('GET', '/api/v1/session', { headers: { cookie } }),
    );
    const anonymous = await local(request('GET', '/api/v1/me/claims'));

    expect(signIn.status).toBe(200);
    expect(cookie).toMatch(/^claimflow_session=u-ben\./);
    expect(bodyOf(session).user.userId).toBe('u-ben');
    expect(anonymous.status).toBe(401);
  });

  it('ignores a tampered session cookie', async () => {
    const local = createLocalApiHandler(app, new SessionCookies('test-secret'));
    const forged = new SessionCookies('other-secret')
      .issue('u-dan')
      .split(';')[0]!;

    const response = await local(
      request('GET', '/api/v1/session', { headers: { cookie: forged } }),
    );

    expect(bodyOf(response).user).toBeNull();
  });
});
