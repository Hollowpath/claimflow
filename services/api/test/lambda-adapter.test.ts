import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Application } from '../src/composition.js';
import {
  maxJsonBytes,
  type ApiRequest,
  type ApiResponse,
} from '../src/http/api-handler.js';
import { createAwsApiHandler } from '../src/http/aws-api.js';
import {
  createHttpApiAdapter,
  toHttpApiResult,
  type HttpApiEvent,
  type HttpApiResult,
} from '../src/http/lambda-adapter.js';
import { pdfBytes, temporaryDirectory, testApplication } from './support.js';

interface EventInit {
  readonly method?: string;
  readonly rawPath: string;
  readonly rawQueryString?: string;
  readonly headers?: Record<string, string>;
  readonly cookies?: string[];
  readonly body?: string;
  readonly isBase64Encoded?: boolean;
  /** JWT claims from the authorizer; omitted for routes without one. */
  readonly claims?: unknown;
  /** Replaces the whole authorizer object, for malformed events. */
  readonly authorizer?: unknown;
}

/** A payload format 2.0 event as API Gateway sends it to Lambda. */
function httpApiEvent(init: EventInit): HttpApiEvent {
  const method = init.method ?? 'GET';
  const authorizer =
    'authorizer' in init
      ? init.authorizer
      : init.claims === undefined
        ? undefined
        : {
            principalId: '',
            integrationLatency: 0,
            jwt: { claims: init.claims, scopes: ['openid', 'email'] },
          };
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: init.rawPath,
    rawQueryString: init.rawQueryString ?? '',
    headers: init.headers ?? {},
    ...(init.cookies === undefined ? {} : { cookies: init.cookies }),
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-id',
      domainName: 'api-id.execute-api.ap-southeast-1.amazonaws.com',
      domainPrefix: 'api-id',
      http: {
        method,
        path: init.rawPath,
        protocol: 'HTTP/1.1',
        sourceIp: '192.0.2.1',
        userAgent: 'test',
      },
      requestId: 'aws-request-id',
      routeKey: '$default',
      stage: '$default',
      time: '18/Oct/2026:09:00:00 +0000',
      timeEpoch: 1_792_314_000_000,
      ...(authorizer === undefined ? {} : { authorizer }),
    },
    ...(init.body === undefined ? {} : { body: init.body }),
    isBase64Encoded: init.isBase64Encoded ?? false,
  };
}

const sub = '7c1e9a52-0d4b-4c39-9a1f-3b6f2f0f8a11';

describe('request mapping', () => {
  let received: ApiRequest[];
  let adapter: (event: HttpApiEvent) => Promise<HttpApiResult>;

  beforeEach(() => {
    received = [];
    adapter = createHttpApiAdapter((request) => {
      received.push(request);
      return Promise.resolve({ status: 204, headers: {} });
    });
  });

  async function mapped(init: EventInit): Promise<ApiRequest> {
    await adapter(httpApiEvent(init));
    expect(received).toHaveLength(1);
    return received[0]!;
  }

  it('maps the method, raw path, query parameters, and headers', async () => {
    const request = await mapped({
      method: 'PATCH',
      rawPath: '/api/v1/claims/c-1%20x',
      rawQueryString: 'limit=5&cursor=a%2Bb&tag=one&tag=two',
      headers: {
        'Content-Type': 'application/json',
        'x-correlation-id': 'trace-1',
      },
    });

    expect(request.method).toBe('PATCH');
    expect(request.path).toBe('/api/v1/claims/c-1%20x');
    expect(request.query).toEqual({ limit: '5', cursor: 'a+b', tag: 'two' });
    expect(request.headers).toEqual({
      'content-type': 'application/json',
      'x-correlation-id': 'trace-1',
    });
  });

  it('restores the cookie header from the separate cookies list', async () => {
    const request = await mapped({
      rawPath: '/api/v1/session',
      cookies: ['a=1', 'claimflow_session=u-ben.sig'],
    });

    expect(request.headers.cookie).toBe('a=1; claimflow_session=u-ben.sig');
  });

  it('preserves UTF-8 bodies', async () => {
    const text = JSON.stringify({ merchant: 'Kedai Kopi Café — RM 12' });
    const request = await mapped({
      method: 'POST',
      rawPath: '/api/v1/claims',
      body: text,
    });

    expect(await request.readBody(1024)).toEqual(
      new TextEncoder().encode(text),
    );
  });

  it('decodes base64 bodies to the original bytes', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x80]);
    const request = await mapped({
      method: 'POST',
      rawPath: '/api/v1/receipts',
      body: Buffer.from(bytes).toString('base64'),
      isBase64Encoded: true,
    });

    expect(await request.readBody(1024)).toEqual(bytes);
  });

  it('reports a body over the limit and an empty body when there is none', async () => {
    const large = await mapped({
      method: 'POST',
      rawPath: '/api/v1/claims',
      body: 'x'.repeat(11),
    });
    expect(await large.readBody(10)).toBeUndefined();

    received = [];
    const empty = await mapped({ rawPath: '/api/v1/health' });
    expect(await empty.readBody(10)).toEqual(new Uint8Array());
  });

  it('takes only the validated sub claim from the JWT authorizer', async () => {
    const request = await mapped({
      rawPath: '/api/v1/me/claims',
      claims: {
        sub,
        email: 'aisha@example.com',
        'cognito:groups': ['ADMIN'],
        'custom:role': 'ADMIN',
        scope: 'openid email',
      },
    });

    expect(request.verifiedSubject).toBe(sub);
    expect(JSON.stringify(request)).not.toContain('ADMIN');
    expect(JSON.stringify(request)).not.toContain('aisha@example.com');
  });

  it('leaves the subject unset for routes without an authorizer', async () => {
    const request = await mapped({ rawPath: '/api/v1/health' });

    expect(request).not.toHaveProperty('verifiedSubject');
  });

  it.each([
    ['an authorizer without JWT data', { authorizer: { lambda: { sub } } }],
    ['null claims', { claims: null }],
    ['claims that are not an object', { claims: 'sub' }],
    ['claims without sub', { claims: { email: 'a@example.com' } }],
    ['an empty sub', { claims: { sub: '' } }],
    ['a numeric sub', { claims: { sub: 42 } }],
    ['an array sub', { claims: { sub: [sub] } }],
    ['a null authorizer', { authorizer: null }],
  ])('leaves the subject unset for %s', async (_name, init) => {
    const request = await mapped({ rawPath: '/api/v1/me/claims', ...init });

    expect(request.verifiedSubject).toBeUndefined();
  });
});

describe('response mapping', () => {
  const headers = { 'X-Request-Id': 'r-1', 'Cache-Control': 'no-store' };

  it('returns string bodies as text with the status and headers', () => {
    const response: ApiResponse = { status: 201, headers, body: '{"a":1}' };

    expect(toHttpApiResult(response)).toEqual({
      statusCode: 201,
      headers,
      body: '{"a":1}',
      isBase64Encoded: false,
    });
  });

  it('returns binary bodies base64-encoded', () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const result = toHttpApiResult({
      status: 200,
      headers: { ...headers, 'Content-Length': '6' },
      body: bytes,
    });

    expect(result.isBase64Encoded).toBe(true);
    expect(result.headers).toEqual({ ...headers, 'Content-Length': '6' });
    expect(new Uint8Array(Buffer.from(result.body!, 'base64'))).toEqual(bytes);
  });

  it('returns no body when the response has none', () => {
    expect(toHttpApiResult({ status: 204, headers })).toEqual({
      statusCode: 204,
      headers,
    });
  });
});

describe('with the AWS API handler', () => {
  let dir: Awaited<ReturnType<typeof temporaryDirectory>>;
  let app: Application;
  let adapter: (event: HttpApiEvent) => Promise<HttpApiResult>;

  beforeEach(async () => {
    dir = await temporaryDirectory();
    // The local seed directory stands in for Cognito profiles: its sample
    // user IDs play the role of Cognito subjects.
    app = await testApplication(dir.path);
    adapter = createHttpApiAdapter(createAwsApiHandler(app));
  });

  afterEach(async () => {
    await dir.remove();
  });

  const asAisha = { claims: { sub: 'u-aisha' } };
  const json = (result: HttpApiResult): any => {
    expect(result.isBase64Encoded).toBe(false);
    return JSON.parse(result.body!);
  };

  it('answers unauthenticated events with the shared 401 error', async () => {
    const result = await adapter(
      httpApiEvent({ rawPath: '/api/v1/me/claims' }),
    );

    expect(result.statusCode).toBe(401);
    expect(json(result).error).toMatchObject({
      code: 'UNAUTHENTICATED',
      requestId: result.headers?.['X-Request-Id'],
    });
  });

  it('answers authenticated events for the verified user', async () => {
    const result = await adapter(
      httpApiEvent({ rawPath: '/api/v1/session', ...asAisha }),
    );

    expect(result.statusCode).toBe(200);
    expect(json(result).user.userId).toBe('u-aisha');
  });

  it('creates a claim from a JSON body', async () => {
    const result = await adapter(
      httpApiEvent({
        method: 'POST',
        rawPath: '/api/v1/claims',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'lambda-key-1',
        },
        body: JSON.stringify({ merchant: 'Kedai Kopi Café' }),
        ...asAisha,
      }),
    );

    expect(result.statusCode).toBe(201);
    expect(json(result)).toMatchObject({
      employee: { userId: 'u-aisha' },
      merchant: 'Kedai Kopi Café',
      status: 'DRAFT',
    });
  });

  it('uploads a base64 receipt and returns it as a binary response', async () => {
    const post = (rawPath: string, body: unknown, key: string) =>
      adapter(
        httpApiEvent({
          method: rawPath.endsWith('/receipt') ? 'PUT' : 'POST',
          rawPath,
          headers: {
            'content-type': 'application/json',
            'idempotency-key': key,
          },
          body: JSON.stringify(body),
          ...asAisha,
        }),
      );
    const claim = json(await post('/api/v1/claims', {}, 'lambda-key-2'));

    const upload = await adapter(
      httpApiEvent({
        method: 'POST',
        rawPath: '/api/v1/receipts',
        headers: {
          'content-type': 'application/pdf',
          'x-file-name': encodeURIComponent('Client flight.pdf'),
          'idempotency-key': 'lambda-key-3',
        },
        body: Buffer.from(pdfBytes).toString('base64'),
        isBase64Encoded: true,
        ...asAisha,
      }),
    );
    expect(upload.statusCode).toBe(201);
    const receipt = json(upload);
    expect(receipt.sizeBytes).toBe(pdfBytes.byteLength);

    const attach = await post(
      `/api/v1/claims/${claim.claimId}/receipt`,
      {
        expectedVersion: claim.version,
        receiptId: receipt.receiptId,
        contentType: receipt.contentType,
        sizeBytes: receipt.sizeBytes,
        checksumSha256: receipt.checksumSha256,
      },
      'lambda-key-4',
    );
    expect(attach.statusCode).toBe(200);

    const read = await adapter(
      httpApiEvent({
        rawPath: `/api/v1/claims/${claim.claimId}/receipt`,
        ...asAisha,
      }),
    );
    expect(read.statusCode).toBe(200);
    expect(read.isBase64Encoded).toBe(true);
    expect(read.headers?.['Content-Type']).toBe('application/pdf');
    expect(new Uint8Array(Buffer.from(read.body!, 'base64'))).toEqual(pdfBytes);
  });

  it('returns validation and size errors from the shared handler', async () => {
    const send = (body: string) =>
      adapter(
        httpApiEvent({
          method: 'POST',
          rawPath: '/api/v1/claims',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': 'lambda-key-5',
          },
          body,
          ...asAisha,
        }),
      );

    const malformed = await send('{not json');
    expect(malformed.statusCode).toBe(400);
    expect(json(malformed).error.message).toBe(
      'The request body is not valid JSON.',
    );

    const oversized = await send(' '.repeat(maxJsonBytes + 1));
    expect(oversized.statusCode).toBe(413);
    expect(json(oversized).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('hides unexpected failures behind the shared generic 500', async () => {
    app.claims.listMine = () => Promise.reject(new Error('table unavailable'));

    const result = await adapter(
      httpApiEvent({ rawPath: '/api/v1/me/claims', ...asAisha }),
    );

    expect(result.statusCode).toBe(500);
    expect(json(result).error.code).toBe('INTERNAL_ERROR');
    expect(result.body).not.toContain('table unavailable');
  });

  it('does not grant roles from token claims', async () => {
    const result = await adapter(
      httpApiEvent({
        rawPath: '/api/v1/claims',
        claims: { sub: 'u-aisha', 'cognito:groups': ['ADMIN'], role: 'ADMIN' },
      }),
    );

    expect(result.statusCode).toBe(403);
  });
});
