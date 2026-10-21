import { afterEach, describe, expect, it, vi } from 'vitest';

import { request, setUnauthenticatedListener } from '../src/api/client';
import { setAuth } from '../src/auth';
import { CognitoAuth } from '../src/auth/cognito';
import { localConfig, setRuntimeConfig } from '../src/config';

const apiBaseUrl =
  'https://abc.execute-api.ap-southeast-1.amazonaws.com/api/v1';
const hostedUiUrl = 'https://claimflow-1.auth.ap-southeast-1.amazoncognito.com';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

function useCognito(initial: { accessToken: string; ttlMs: number } | null) {
  const store = new Map<string, string>();
  const now = 1_000_000;
  if (initial !== null) {
    store.set(
      'claimflow.auth.tokens',
      JSON.stringify({
        accessToken: initial.accessToken,
        refreshToken: 'refresh-1',
        expiresAt: now + initial.ttlMs,
      }),
    );
  }
  const tokenFetch = vi.fn<typeof fetch>();
  const navigate = vi.fn();
  const auth = new CognitoAuth({
    config: { hostedUiUrl, clientId: 'client123' },
    storage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => void store.set(key, value),
      removeItem: (key) => void store.delete(key),
    },
    fetch: tokenFetch,
    now: () => now,
    navigate,
    origin: 'https://d111.cloudfront.net',
  });
  setRuntimeConfig({
    apiBaseUrl,
    cognito: { hostedUiUrl, clientId: 'client123' },
  });
  setAuth(auth);
  return { auth, store, tokenFetch };
}

const sent = (fetchMock: ReturnType<typeof vi.fn>, index: number) => {
  const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit];
  return { url, init, headers: init.headers as Record<string, string> };
};

afterEach(() => {
  setUnauthenticatedListener(() => undefined);
});

describe('API requests with Cognito sign-in', () => {
  it('sends the access token as a Bearer token to the configured API', async () => {
    useCognito({ accessToken: 'access-1', ttlMs: 3_600_000 });
    const fetchMock = vi.fn().mockResolvedValue(json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await request('GET', '/session');

    const call = sent(fetchMock, 0);
    expect(call.url).toBe(`${apiBaseUrl}/session`);
    expect(call.headers.Authorization).toBe('Bearer access-1');
  });

  it('refreshes before expiry instead of sending a stale token', async () => {
    const { tokenFetch } = useCognito({ accessToken: 'old', ttlMs: 10_000 });
    tokenFetch.mockResolvedValue(
      json({ access_token: 'new', expires_in: 3600 }),
    );
    const fetchMock = vi.fn().mockResolvedValue(json({}));
    vi.stubGlobal('fetch', fetchMock);

    await request('GET', '/me/claims');

    expect(sent(fetchMock, 0).headers.Authorization).toBe('Bearer new');
  });

  it('refreshes once after a 401 and repeats the request with the same idempotency key', async () => {
    const { tokenFetch } = useCognito({
      accessToken: 'access-1',
      ttlMs: 3_600_000,
    });
    tokenFetch.mockResolvedValue(
      json({ access_token: 'access-2', expires_in: 3600 }),
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ message: 'Unauthorized' }, 401))
      .mockResolvedValueOnce(json({ claimId: 'c-1' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(request('POST', '/claims', { json: {} })).resolves.toEqual({
      claimId: 'c-1',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sent(fetchMock, 0).headers.Authorization).toBe('Bearer access-1');
    expect(sent(fetchMock, 1).headers.Authorization).toBe('Bearer access-2');
    expect(sent(fetchMock, 1).headers['Idempotency-Key']).toBe(
      sent(fetchMock, 0).headers['Idempotency-Key'],
    );
    expect(tokenFetch).toHaveBeenCalledTimes(1);
  });

  it('requires sign-in when the refresh after a 401 fails', async () => {
    const { auth, tokenFetch } = useCognito({
      accessToken: 'access-1',
      ttlMs: 3_600_000,
    });
    tokenFetch.mockResolvedValue(json({ error: 'invalid_grant' }, 400));
    const fetchMock = vi
      .fn()
      .mockResolvedValue(json({ message: 'Unauthorized' }, 401));
    vi.stubGlobal('fetch', fetchMock);
    const listener = vi.fn();
    setUnauthenticatedListener(listener);

    await expect(request('GET', '/claims')).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHENTICATED',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(auth.isSignedIn()).toBe(false);
  });

  it('does not refresh a second time when the repeated request is also rejected', async () => {
    const { auth, tokenFetch } = useCognito({
      accessToken: 'access-1',
      ttlMs: 3_600_000,
    });
    tokenFetch.mockResolvedValue(
      json({ access_token: 'access-2', expires_in: 3600 }),
    );
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(json({ message: 'Unauthorized' }, 401)),
      );
    vi.stubGlobal('fetch', fetchMock);
    const listener = vi.fn();
    setUnauthenticatedListener(listener);

    await expect(request('GET', '/claims')).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(tokenFetch).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(auth.isSignedIn()).toBe(false);
  });

  it('does not call the API without a sign-in', async () => {
    useCognito(null);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const listener = vi.fn();
    setUnauthenticatedListener(listener);

    await expect(request('GET', '/session')).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalled();
  });

  it('keeps the sign-in when only the sign-in service is unreachable', async () => {
    const { auth, tokenFetch } = useCognito({
      accessToken: 'old',
      ttlMs: 10_000,
    });
    tokenFetch.mockRejectedValue(new TypeError('offline'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(request('GET', '/claims')).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(auth.isSignedIn()).toBe(true);
  });
});

describe('API requests in local development', () => {
  it('keeps the same-origin API, cookies, and no Authorization header', async () => {
    setRuntimeConfig(localConfig);
    const fetchMock = vi.fn().mockResolvedValue(json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await request('GET', '/session');

    const call = sent(fetchMock, 0);
    expect(call.url).toBe('/api/v1/session');
    expect(call.init.credentials).toBe('same-origin');
    expect(call.headers).not.toHaveProperty('Authorization');
  });

  it('still signs out of the UI on the local UNAUTHENTICATED error', async () => {
    setRuntimeConfig(localConfig);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          json(
            { error: { code: 'UNAUTHENTICATED', message: 'Choose a user.' } },
            401,
          ),
        ),
    );
    const listener = vi.fn();
    setUnauthenticatedListener(listener);

    await expect(request('GET', '/claims')).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
