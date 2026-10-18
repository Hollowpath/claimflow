import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Application } from '../src/composition.js';
import type { ApiRequest, ApiResponse } from '../src/http/api-handler.js';
import {
  cognitoSubjectAuthentication,
  createAwsApiHandler,
} from '../src/http/aws-api.js';
import { createLocalApiHandler } from '../src/http/local-api.js';
import { createAwsRoutes, createLocalRoutes } from '../src/http/routes.js';
import { SessionCookies } from '../src/http/session-cookie.js';
import { actors, temporaryDirectory, testApplication } from './support.js';

function request(
  method: string,
  path: string,
  init: {
    readonly headers?: Record<string, string>;
    readonly verifiedSubject?: string;
    readonly body?: unknown;
  } = {},
): ApiRequest {
  const body =
    init.body === undefined
      ? new Uint8Array()
      : new TextEncoder().encode(JSON.stringify(init.body));
  return {
    method,
    path: `/api/v1${path}`,
    query: {},
    headers: {
      ...(init.body === undefined
        ? {}
        : { 'content-type': 'application/json' }),
      ...init.headers,
    },
    ...(init.verifiedSubject === undefined
      ? {}
      : { verifiedSubject: init.verifiedSubject }),
    readBody: () => Promise.resolve(body),
  };
}

const bodyOf = (response: ApiResponse): any =>
  JSON.parse(response.body as string);

const operations = (routes: readonly { method: string; path: string }[]) =>
  routes.map((route) => `${route.method} ${route.path}`).sort();

let dir: Awaited<ReturnType<typeof temporaryDirectory>>;
let app: Application;
const cookies = new SessionCookies('test-secret');

beforeEach(async () => {
  dir = await temporaryDirectory();
  app = await testApplication(dir.path);
});

afterEach(async () => {
  await dir.remove();
});

describe('route sets', () => {
  it('omit the development session mutations in the AWS runtime only', () => {
    const local = operations(createLocalRoutes(app, cookies));
    const aws = operations(createAwsRoutes(app));

    expect(local).toEqual(
      expect.arrayContaining(['PUT /session', 'DELETE /session']),
    );
    expect(aws).not.toContain('PUT /session');
    expect(aws).not.toContain('DELETE /session');
    expect(aws).toContain('GET /session');
    expect(aws).toEqual(
      local.filter((op) => op !== 'PUT /session' && op !== 'DELETE /session'),
    );
  });

  it.each(['PUT', 'DELETE'])(
    'answer %s /session with 404 in the AWS runtime',
    async (method) => {
      const response = await createAwsApiHandler(app)(
        request(method, '/session', {
          verifiedSubject: 'u-aisha',
          ...(method === 'PUT' ? { body: { userId: 'u-dan' } } : {}),
        }),
      );

      expect(response.status).toBe(404);
      expect(response.headers).not.toHaveProperty('Set-Cookie');
    },
  );
});

describe('Cognito subject authentication', () => {
  const authenticate = () => cognitoSubjectAuthentication(app.sessions);

  it('loads the actor for a verified subject from the user directory', async () => {
    const actor = await authenticate()(
      request('GET', '/session', { verifiedSubject: 'u-ben' }),
    );

    expect(actor).toEqual(actors.ben);
  });

  it('leaves requests without a verified subject unauthenticated', async () => {
    const signedInCookie = cookies.issue('u-dan').split(';')[0]!;

    const actor = await authenticate()(
      request('GET', '/session', { headers: { cookie: signedInCookie } }),
    );

    expect(actor).toBeUndefined();
  });

  it('leaves unknown subjects unauthenticated', async () => {
    const actor = await authenticate()(
      request('GET', '/session', {
        verifiedSubject: '7c1e9a52-0d4b-4c39-9a1f-3b6f2f0f8a11',
      }),
    );

    expect(actor).toBeUndefined();
  });

  it('authorizes from directory roles, not from role or group headers', async () => {
    const handler = createAwsApiHandler(app);
    const untrusted = {
      'x-amzn-oidc-data': 'cognito:groups=ADMIN',
      'cognito-groups': 'ADMIN',
      'x-user-roles': 'ADMIN',
    };

    const employee = await handler(
      request('GET', '/claims', {
        verifiedSubject: 'u-aisha',
        headers: untrusted,
      }),
    );
    const admin = await handler(
      request('GET', '/claims', { verifiedSubject: 'u-dan' }),
    );
    const unknown = await handler(
      request('GET', '/claims', {
        verifiedSubject: 'not-a-profile',
        headers: untrusted,
      }),
    );

    expect(employee.status).toBe(403);
    expect(admin.status).toBe(200);
    expect(unknown.status).toBe(401);
  });

  it('is not used by the local runtime, which ignores verified subjects', async () => {
    const response = await createLocalApiHandler(
      app,
      cookies,
    )(request('GET', '/session', { verifiedSubject: 'u-dan' }));

    expect(bodyOf(response).user).toBeNull();
  });
});

describe('GET /session', () => {
  it('describes only the signed-in user in the AWS runtime', async () => {
    const response = await createAwsApiHandler(app)(
      request('GET', '/session', { verifiedSubject: 'u-ben' }),
    );

    expect(response.status).toBe(200);
    expect(bodyOf(response)).toEqual({
      user: {
        userId: 'u-ben',
        displayName: 'Ben Tan',
        title: expect.any(String),
        roles: ['EMPLOYEE', 'MANAGER'],
        manager: { userId: 'u-chloe', displayName: 'Chloe Lim' },
      },
      users: [],
    });
    expect(response.body).not.toContain('u-aisha');
  });

  it('lists no users when nobody is signed in in the AWS runtime', async () => {
    const response = await createAwsApiHandler(app)(request('GET', '/session'));

    expect(bodyOf(response)).toEqual({ user: null, users: [] });
  });

  it('describes the same user as the local runtime, apart from the user list', async () => {
    const local = await createLocalApiHandler(
      app,
      cookies,
    )(
      request('GET', '/session', {
        headers: { cookie: cookies.issue('u-ben').split(';')[0]! },
      }),
    );
    const aws = await createAwsApiHandler(app)(
      request('GET', '/session', { verifiedSubject: 'u-ben' }),
    );

    expect(bodyOf(aws).user).toEqual(bodyOf(local).user);
    expect(bodyOf(local).users.length).toBeGreaterThan(1);
  });
});

describe('local development sessions', () => {
  it('still select, describe, and clear a sample user with a cookie', async () => {
    const handler = createLocalApiHandler(app, cookies);

    const selected = await handler(
      request('PUT', '/session', { body: { userId: 'u-aisha' } }),
    );
    const cookie = selected.headers['Set-Cookie']!.split(';')[0]!;
    const described = await handler(
      request('GET', '/session', { headers: { cookie } }),
    );
    const cleared = await handler(
      request('DELETE', '/session', { headers: { cookie } }),
    );

    expect(selected.status).toBe(200);
    expect(bodyOf(selected).user.userId).toBe('u-aisha');
    expect(bodyOf(described).user.userId).toBe('u-aisha');
    expect(bodyOf(described).users).toHaveLength(5);
    expect(cleared.status).toBe(200);
    expect(cleared.headers['Set-Cookie']).toContain('Max-Age=0');
    expect(bodyOf(cleared).user).toBeNull();
    expect(bodyOf(cleared).users).toHaveLength(5);
  });
});
