import { describe, expect, it, vi } from 'vitest';

import { AuthError, CognitoAuth } from '../src/auth/cognito';
import { codeChallenge } from '../src/auth/pkce';
import {
  ConfigError,
  loadRuntimeConfig,
  localConfig,
  parseRuntimeConfig,
} from '../src/config';

const hostedUiUrl = 'https://claimflow-1.auth.ap-southeast-1.amazoncognito.com';
const origin = 'https://d111.cloudfront.net';

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

const tokenResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

function setup() {
  const storage = memoryStorage();
  const clock = { now: 1_000_000 };
  const fetchMock = vi.fn<typeof fetch>();
  const navigate = vi.fn<(url: string) => void>();
  const auth = new CognitoAuth({
    config: { hostedUiUrl, clientId: 'client123' },
    storage,
    fetch: fetchMock,
    now: () => clock.now,
    navigate,
    origin,
  });
  return { auth, storage, clock, fetchMock, navigate };
}

function formOf(call: unknown[]): URLSearchParams {
  return new URLSearchParams(
    String((call[1] as RequestInit).body as URLSearchParams),
  );
}

/** Starts sign-in and returns the state and verifier it stored. */
async function begin(ctx: ReturnType<typeof setup>) {
  await ctx.auth.beginSignIn();
  const url = new URL(ctx.navigate.mock.calls[0]![0]);
  const pending = JSON.parse(ctx.storage.items.get('claimflow.auth.pending')!);
  return { url, ...(pending as { state: string; verifier: string }) };
}

const signedIn = (ctx: ReturnType<typeof setup>, expiresIn = 3600) => {
  ctx.storage.items.set(
    'claimflow.auth.tokens',
    JSON.stringify({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: ctx.clock.now + expiresIn * 1000,
    }),
  );
};

describe('PKCE', () => {
  it('derives the S256 challenge from the RFC 7636 example', async () => {
    expect(
      await codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    ).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

describe('beginSignIn', () => {
  it('opens the hosted UI with state and an S256 challenge', async () => {
    const ctx = setup();
    const { url, state, verifier } = await begin(ctx);

    expect(`${url.origin}${url.pathname}`).toBe(
      `${hostedUiUrl}/oauth2/authorize`,
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'client123',
      redirect_uri: `${origin}/auth/callback`,
      scope: 'openid email',
      state,
      code_challenge: await codeChallenge(verifier),
      code_challenge_method: 'S256',
    });
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(url.toString()).not.toContain(verifier);
  });

  it('uses a different state and verifier every time', async () => {
    const first = await begin(setup());
    const second = await begin(setup());
    expect(first.state).not.toBe(second.state);
    expect(first.verifier).not.toBe(second.verifier);
  });

  it('keeps the verifier out of localStorage', async () => {
    const before = { ...localStorage };
    const ctx = setup();
    await begin(ctx);
    expect(localStorage.length).toBe(Object.keys(before).length);
  });
});

describe('completeSignIn', () => {
  it('validates state, exchanges the code, and stores only session tokens', async () => {
    const ctx = setup();
    const { state, verifier } = await begin(ctx);
    ctx.fetchMock.mockResolvedValue(
      tokenResponse({
        access_token: 'access-1',
        id_token: 'id-token-never-stored',
        refresh_token: 'refresh-1',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    );

    await ctx.auth.completeSignIn(`?code=abc&state=${state}`);

    expect(ctx.fetchMock).toHaveBeenCalledTimes(1);
    const call = ctx.fetchMock.mock.calls[0]!;
    expect(call[0]).toBe(`${hostedUiUrl}/oauth2/token`);
    expect((call[1] as RequestInit).method).toBe('POST');
    expect(Object.fromEntries(formOf(call))).toEqual({
      grant_type: 'authorization_code',
      client_id: 'client123',
      code: 'abc',
      redirect_uri: `${origin}/auth/callback`,
      code_verifier: verifier,
    });
    expect(ctx.storage.items.has('claimflow.auth.pending')).toBe(false);
    const stored = ctx.storage.items.get('claimflow.auth.tokens')!;
    expect(JSON.parse(stored)).toEqual({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: ctx.clock.now + 3_600_000,
    });
    expect(stored).not.toContain('id-token-never-stored');
    expect(ctx.auth.isSignedIn()).toBe(true);
  });

  it('rejects a mismatched state without exchanging the code', async () => {
    const ctx = setup();
    await begin(ctx);
    await expect(
      ctx.auth.completeSignIn('?code=abc&state=forged'),
    ).rejects.toThrow('could not be verified');
    expect(ctx.fetchMock).not.toHaveBeenCalled();
    expect(ctx.auth.isSignedIn()).toBe(false);
  });

  it('rejects a callback that was never started or has no state', async () => {
    const ctx = setup();
    await expect(ctx.auth.completeSignIn('?code=abc&state=x')).rejects.toThrow(
      'could not be verified',
    );
    await begin(ctx);
    await expect(ctx.auth.completeSignIn('?code=abc')).rejects.toThrow(
      'could not be verified',
    );
    expect(ctx.fetchMock).not.toHaveBeenCalled();
  });

  it('cannot replay a state that was already used', async () => {
    const ctx = setup();
    const { state } = await begin(ctx);
    ctx.fetchMock.mockResolvedValue(
      tokenResponse({ access_token: 'a', expires_in: 60 }),
    );
    await ctx.auth.completeSignIn(`?code=abc&state=${state}`);
    await expect(
      ctx.auth.completeSignIn(`?code=other&state=${state}`),
    ).rejects.toBeInstanceOf(AuthError);
    expect(ctx.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shares one exchange between repeated calls for the same redirect', async () => {
    const ctx = setup();
    const { state } = await begin(ctx);
    ctx.fetchMock.mockResolvedValue(
      tokenResponse({ access_token: 'a', expires_in: 60 }),
    );
    const search = `?code=abc&state=${state}`;
    await Promise.all([
      ctx.auth.completeSignIn(search),
      ctx.auth.completeSignIn(search),
    ]);
    expect(ctx.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports a hosted UI error after checking state', async () => {
    const ctx = setup();
    const { state } = await begin(ctx);
    await expect(
      ctx.auth.completeSignIn(
        `?error=access_denied&error_description=User%20cancelled&state=${state}`,
      ),
    ).rejects.toThrow('User cancelled');
    expect(ctx.fetchMock).not.toHaveBeenCalled();
    expect(ctx.storage.items.has('claimflow.auth.pending')).toBe(false);
  });

  it('reports a missing code', async () => {
    const ctx = setup();
    const { state } = await begin(ctx);
    await expect(ctx.auth.completeSignIn(`?state=${state}`)).rejects.toThrow(
      'did not return a code',
    );
  });

  it.each([
    [
      'a rejected exchange',
      () => tokenResponse({ error: 'invalid_grant' }, 400),
    ],
    [
      'a response without an access token',
      () => tokenResponse({ expires_in: 1 }),
    ],
    [
      'a response without a lifetime',
      () => tokenResponse({ access_token: 'a' }),
    ],
  ])('fails on %s and stores nothing', async (_name, response) => {
    const ctx = setup();
    const { state } = await begin(ctx);
    ctx.fetchMock.mockResolvedValue(response());
    await expect(
      ctx.auth.completeSignIn(`?code=abc&state=${state}`),
    ).rejects.toThrow('Sign-in failed');
    expect(ctx.storage.items.has('claimflow.auth.tokens')).toBe(false);
  });

  it('reports an unreachable sign-in service', async () => {
    const ctx = setup();
    const { state } = await begin(ctx);
    ctx.fetchMock.mockRejectedValue(new TypeError('offline'));
    await expect(
      ctx.auth.completeSignIn(`?code=abc&state=${state}`),
    ).rejects.toThrow('Cannot reach the sign-in service');
  });
});

describe('access tokens', () => {
  it('returns null when signed out and the stored token while fresh', async () => {
    const ctx = setup();
    expect(await ctx.auth.getAccessToken()).toBeNull();
    signedIn(ctx);
    expect(await ctx.auth.getAccessToken()).toBe('access-1');
    expect(ctx.fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes shortly before expiry, once for concurrent callers', async () => {
    const ctx = setup();
    signedIn(ctx, 30);
    ctx.fetchMock.mockResolvedValue(
      tokenResponse({ access_token: 'access-2', expires_in: 3600 }),
    );

    const tokens = await Promise.all([
      ctx.auth.getAccessToken(),
      ctx.auth.getAccessToken(),
    ]);

    expect(tokens).toEqual(['access-2', 'access-2']);
    expect(ctx.fetchMock).toHaveBeenCalledTimes(1);
    expect(Object.fromEntries(formOf(ctx.fetchMock.mock.calls[0]!))).toEqual({
      grant_type: 'refresh_token',
      client_id: 'client123',
      refresh_token: 'refresh-1',
    });
    // Cognito does not return the refresh token again, so it is kept.
    expect(JSON.parse(ctx.storage.items.get('claimflow.auth.tokens')!)).toEqual(
      {
        accessToken: 'access-2',
        refreshToken: 'refresh-1',
        expiresAt: ctx.clock.now + 3_600_000,
      },
    );
  });

  it('requires sign-in when the refresh is rejected', async () => {
    const ctx = setup();
    signedIn(ctx, 30);
    ctx.fetchMock.mockResolvedValue(
      tokenResponse({ error: 'invalid_grant' }, 400),
    );
    expect(await ctx.auth.getAccessToken()).toBeNull();
    expect(ctx.auth.isSignedIn()).toBe(false);
  });

  it('requires sign-in when an expired token has no refresh token', async () => {
    const ctx = setup();
    ctx.storage.items.set(
      'claimflow.auth.tokens',
      JSON.stringify({
        accessToken: 'a',
        refreshToken: null,
        expiresAt: ctx.clock.now - 1,
      }),
    );
    expect(await ctx.auth.getAccessToken()).toBeNull();
    expect(ctx.fetchMock).not.toHaveBeenCalled();
    expect(ctx.auth.isSignedIn()).toBe(false);
  });

  it('keeps the tokens when the refresh cannot reach Cognito', async () => {
    const ctx = setup();
    signedIn(ctx, 30);
    ctx.fetchMock.mockRejectedValue(new TypeError('offline'));
    await expect(ctx.auth.getAccessToken()).rejects.toBeInstanceOf(AuthError);
    expect(ctx.auth.isSignedIn()).toBe(true);
  });

  it('discards unreadable stored tokens', () => {
    const ctx = setup();
    ctx.storage.items.set('claimflow.auth.tokens', '{not json');
    expect(ctx.auth.isSignedIn()).toBe(false);
    expect(ctx.storage.items.has('claimflow.auth.tokens')).toBe(false);
  });

  it('refreshes after a 401 only when the rejected token is still current', async () => {
    const ctx = setup();
    signedIn(ctx);
    ctx.fetchMock.mockResolvedValue(
      tokenResponse({ access_token: 'access-2', expires_in: 3600 }),
    );
    expect(await ctx.auth.refreshAfterUnauthorized('access-1')).toBe(
      'access-2',
    );
    // A request that was rejected with the old token reuses the new one.
    expect(await ctx.auth.refreshAfterUnauthorized('access-1')).toBe(
      'access-2',
    );
    expect(ctx.fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('signOut', () => {
  it('clears local authentication and uses the Cognito logout endpoint', () => {
    const ctx = setup();
    signedIn(ctx);
    ctx.storage.items.set('claimflow.auth.pending', '{}');

    ctx.auth.signOut();

    expect(ctx.storage.items.size).toBe(0);
    const url = new URL(ctx.navigate.mock.calls[0]![0]);
    expect(`${url.origin}${url.pathname}`).toBe(`${hostedUiUrl}/logout`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'client123',
      logout_uri: `${origin}/`,
    });
  });
});

describe('runtime configuration', () => {
  const valid = {
    apiBaseUrl: 'https://abc.execute-api.ap-southeast-1.amazonaws.com/api/v1/',
    cognito: { hostedUiUrl: `${hostedUiUrl}/`, clientId: 'client123' },
  };

  it('accepts a valid config and normalizes trailing slashes', () => {
    expect(parseRuntimeConfig(valid)).toEqual({
      apiBaseUrl: 'https://abc.execute-api.ap-southeast-1.amazonaws.com/api/v1',
      cognito: { hostedUiUrl, clientId: 'client123' },
    });
  });

  it.each([
    ['a missing cognito section', { apiBaseUrl: valid.apiBaseUrl }],
    ['a plain http API', { ...valid, apiBaseUrl: 'http://example.com/api/v1' }],
    ['a relative API URL', { ...valid, apiBaseUrl: '/api/v1' }],
    [
      'an http hosted UI',
      {
        ...valid,
        cognito: { ...valid.cognito, hostedUiUrl: 'http://localhost' },
      },
    ],
    [
      'a hosted UI with a path',
      {
        ...valid,
        cognito: { ...valid.cognito, hostedUiUrl: `${hostedUiUrl}/x` },
      },
    ],
    [
      'a bad client ID',
      { ...valid, cognito: { ...valid.cognito, clientId: 'a b' } },
    ],
    ['a non-object', 'nope'],
  ])('rejects %s', (_name, config) => {
    expect(() => parseRuntimeConfig(config)).toThrow(ConfigError);
  });

  it('allows a plain http API on localhost only', () => {
    expect(
      parseRuntimeConfig({
        ...valid,
        apiBaseUrl: 'http://localhost:3001/api/v1',
      }).apiBaseUrl,
    ).toBe('http://localhost:3001/api/v1');
  });

  const json = (body: string, type = 'application/json', status = 200) =>
    Promise.resolve(
      new Response(body, { status, headers: { 'Content-Type': type } }),
    );

  it('loads config.json when the deployment provides one', async () => {
    const config = await loadRuntimeConfig(() => json(JSON.stringify(valid)));
    expect(config.cognito?.clientId).toBe('client123');
  });

  const unusable: [string, () => Promise<Response>][] = [
    ['a missing file', () => json('', 'text/plain', 404)],
    ['a server error', () => json('{}', 'application/json', 500)],
    ['the HTML fallback', () => json('<!doctype html>', 'text/html')],
    ['an unreachable file', () => Promise.reject(new TypeError('offline'))],
  ];

  it.each(['localhost', '127.0.0.1'])(
    'falls back to development sign-in on %s without a usable file',
    async (host) => {
      for (const [, response] of unusable) {
        expect(await loadRuntimeConfig(response, host)).toBe(localConfig);
      }
    },
  );

  it.each([
    'd111.cloudfront.net',
    'claimflow.example.com',
    'localhost.evil.example',
    '127.0.0.2',
    '[::1]',
    '',
  ])(
    'shows a configuration error on %s without a usable file',
    async (host) => {
      for (const [, response] of unusable) {
        await expect(loadRuntimeConfig(response, host)).rejects.toBeInstanceOf(
          ConfigError,
        );
      }
    },
  );

  it('still loads a valid file on any host', async () => {
    const config = await loadRuntimeConfig(
      () => json(JSON.stringify(valid)),
      'd111.cloudfront.net',
    );
    expect(config.cognito?.clientId).toBe('client123');
  });

  it.each(['localhost', 'd111.cloudfront.net'])(
    'fails instead of falling back when the file is invalid on %s',
    async (host) => {
      await expect(
        loadRuntimeConfig(() => json('{"apiBaseUrl": "x"}'), host),
      ).rejects.toBeInstanceOf(ConfigError);
      await expect(
        loadRuntimeConfig(() => json('{oops'), host),
      ).rejects.toThrow('not valid JSON');
    },
  );
});
