import { request as httpRequest } from 'node:http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Application } from '../src/composition.js';
import { ApiClient, startServer } from './http-support.js';
import { temporaryDirectory, testApplication } from './support.js';

/**
 * CSRF assessment of the local development sign-in (a signed `SameSite=Strict` cookie). The Cognito path is separate:
 * it authenticates with a Bearer token that API Gateway validates and no cookie is involved.
 *
 * What these tests prove, and what they cannot. They send hand-built HTTP requests to the real server, shaped like
 * what a browser sends from another origin: the victim's cookie, an `Origin` header, a browser-permitted content type,
 * and no custom header. They prove what the SERVER does with such requests and that it never sends CORS permission.
 * They cannot prove what a browser enforces (SameSite, preflight, CORS blocking): an HTTP client ignores all three.
 * Those are exercised separately in a real browser (see docs/engineering-readiness.md). Cookies are never printed.
 */
let dir: Awaited<ReturnType<typeof temporaryDirectory>>;
let app: Application;
let server: Awaited<ReturnType<typeof startServer>>;
let victim: ApiClient;

const otherLocalhostPort = 'http://localhost:5174';

beforeEach(async () => {
  dir = await temporaryDirectory();
  app = await testApplication(dir.path);
  server = await startServer(app);
  victim = await ApiClient.signedIn(server.baseUrl, 'u-aisha');
});

afterEach(async () => {
  await server.close();
  await dir.remove();
});

const claim = {
  categoryId: 'travel',
  amount: { amountMinor: 25_000, currency: 'MYR' },
  expenseDate: '2026-10-10',
  merchant: 'Regional Airline',
  businessPurpose: 'Client workshop at the regional office',
};

interface Raw {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly text: string;
}

/** A request as another web page would cause the victim's browser to send it: the victim's cookie, an Origin, no custom header unless given. */
function crossSite(
  method: string,
  path: string,
  options: {
    readonly contentType?: string;
    readonly body?: string;
    readonly headers?: Record<string, string>;
    readonly withCookie?: boolean;
    readonly origin?: string;
  } = {},
): Promise<Raw> {
  const url = new URL(`${server.baseUrl}${path}`);
  const headers: Record<string, string> = {
    Origin: options.origin ?? otherLocalhostPort,
    Referer: `${options.origin ?? otherLocalhostPort}/attack.html`,
    'Sec-Fetch-Site': 'same-site',
    ...options.headers,
  };
  if (options.withCookie !== false && victim.cookie !== undefined) {
    headers.Cookie = victim.cookie;
  }
  if (options.contentType !== undefined) {
    headers['Content-Type'] = options.contentType;
  }
  if (options.body !== undefined) {
    headers['Content-Length'] = String(Buffer.byteLength(options.body));
  }
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

const redact = (setCookie: string) => setCookie.replace(/=[^;]*/, '=<value>');

async function myClaims(): Promise<number> {
  const response = await victim.get<{ items: unknown[] }>('/me/claims');
  expect(response.status).toBe(200);
  return response.body.items.length;
}

const formClaim =
  'categoryId=travel&merchant=Regional+Airline&expenseDate=2026-10-10&businessPurpose=forged';

describe('what the cookie is and is not', () => {
  it('is HttpOnly, SameSite=Strict, path-wide, and cleared on sign-out', async () => {
    const anon = await crossSite('PUT', '/session', {
      withCookie: false,
      contentType: 'application/json',
      body: JSON.stringify({ userId: 'u-ravi' }),
    });
    expect(anon.status).toBe(200);
    const issued = redact(String(anon.headers['set-cookie']));
    expect(issued).toContain('claimflow_session=<value>');
    expect(issued).toContain('HttpOnly');
    expect(issued).toContain('SameSite=Strict');
    expect(issued).toContain('Path=/');
    const cleared = await crossSite('DELETE', '/session');
    expect(redact(String(cleared.headers['set-cookie']))).toContain(
      'Max-Age=0',
    );
  });
});

describe('cross-site requests carrying the victim cookie', () => {
  it.each([
    ['application/x-www-form-urlencoded', formClaim],
    [
      'multipart/form-data; boundary=----x',
      `------x\r\nContent-Disposition: form-data; name="categoryId"\r\n\r\ntravel\r\n------x--\r\n`,
    ],
    ['text/plain', JSON.stringify(claim)],
  ])(
    'cannot create a claim with a %s body (no custom header)',
    async (contentType, body) => {
      const before = await myClaims();
      const response = await crossSite('POST', '/claims', {
        contentType,
        body,
      });
      expect(response.status).toBe(400);
      expect(await myClaims()).toBe(before);
    },
  );

  it('cannot create a claim with an empty form submission either', async () => {
    const before = await myClaims();
    const response = await crossSite('POST', '/claims', {
      contentType: 'application/x-www-form-urlencoded',
      body: '',
    });
    expect(response.status).toBe(400);
    expect(await myClaims()).toBe(before);
  });

  it('are also refused by the JSON content-type check even if a custom header were somehow present', async () => {
    // Two independent barriers: this one stands on its own (the Idempotency-Key header is the other).
    const before = await myClaims();
    for (const contentType of [
      'text/plain',
      'application/x-www-form-urlencoded',
    ]) {
      const response = await crossSite('POST', '/claims', {
        contentType,
        body: JSON.stringify(claim),
        headers: { 'Idempotency-Key': 'forged-0001-forged-0001' },
      });
      expect(response.status).toBe(400);
    }
    expect(await myClaims()).toBe(before);
  });

  it('cannot move an existing claim between states', async () => {
    const created = await victim.request<{ claimId: string; version: number }>(
      'POST',
      '/claims',
      { body: claim },
    );
    expect(created.status).toBe(201);
    const path = `/claims/${created.body.claimId}`;
    for (const action of ['submit', 'start-review', 'approve', 'mark-paid']) {
      const response = await crossSite('POST', `${path}/${action}`, {
        contentType: 'application/x-www-form-urlencoded',
        body: `expectedVersion=${created.body.version}`,
      });
      expect(response.status).toBe(400);
    }
    const after = await victim.get<{ status: string; version: number }>(path);
    expect(after.body).toMatchObject({
      status: 'DRAFT',
      version: created.body.version,
    });
  });

  it('cannot upload a receipt: the raw-body route is still gated by the custom header', async () => {
    const response = await crossSite('POST', '/receipts', {
      contentType: 'multipart/form-data; boundary=----x',
      body: '------x\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\n\r\n%PDF-1.4\r\n------x--\r\n',
    });
    expect(response.status).toBe(400);
  });

  it('cannot sign the victim in as someone else or sign them out except through a non-simple request', async () => {
    // A form cannot send PUT or DELETE, and the JSON content type a PUT needs is not browser-permitted without
    // a preflight. The server side of that: a text/plain body does not sign anyone in.
    const login = await crossSite('PUT', '/session', {
      contentType: 'text/plain',
      body: JSON.stringify({ userId: 'u-ben' }),
      withCookie: false,
    });
    expect(login.status).toBe(400);
    expect(login.headers['set-cookie']).toBeUndefined();
    const identity = await victim.get<{ user?: { userId: string } }>(
      '/session',
    );
    expect(identity.status).toBe(200);
  });
});

describe('CORS: the server never grants cross-origin access', () => {
  it('answers a preflight for a JSON mutation with no CORS permission', async () => {
    for (const [method, path] of [
      ['POST', '/claims'],
      ['PATCH', '/claims/x'],
      ['DELETE', '/claims/x'],
      ['PUT', '/session'],
      ['DELETE', '/session'],
    ] as const) {
      const response = await crossSite('OPTIONS', path, {
        withCookie: false,
        headers: {
          'Access-Control-Request-Method': method,
          'Access-Control-Request-Headers': 'content-type,idempotency-key',
        },
      });
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(
        Object.keys(response.headers).filter((name) =>
          name.startsWith('access-control-'),
        ),
      ).toEqual([]);
    }
  });

  it('sends no Access-Control-* header on any response, credentialed or not, from any origin', async () => {
    const calls = [
      await crossSite('GET', '/me/claims'),
      await crossSite('GET', '/session'),
      await crossSite('GET', '/health', {
        withCookie: false,
        origin: 'https://example.invalid',
      }),
      await crossSite('POST', '/claims', {
        contentType: 'text/plain',
        body: 'x',
      }),
      await crossSite('GET', '/me/claims', { withCookie: false }),
    ];
    for (const response of calls) {
      expect(
        Object.keys(response.headers).filter((name) =>
          name.startsWith('access-control-'),
        ),
      ).toEqual([]);
    }
    expect(calls[0]!.status).toBe(200); // the server did process the cookie: only the browser's CORS rules would hide it
    expect(calls[4]!.status).toBe(401);
  });
});

describe('controls: the legitimate same-origin flow still works', () => {
  it('signs in, mutates with JSON plus a custom header, and signs out', async () => {
    const before = await myClaims();
    const created = await victim.request('POST', '/claims', { body: claim });
    expect(created.status).toBe(201);
    expect(await myClaims()).toBe(before + 1);

    const signedOut = await victim.request('DELETE', '/session');
    expect(signedOut.status).toBe(200);
    expect((await victim.get('/me/claims')).status).toBe(401);

    const again = await ApiClient.signedIn(server.baseUrl, 'u-aisha');
    expect((await again.get('/me/claims')).status).toBe(200);
  });
});
