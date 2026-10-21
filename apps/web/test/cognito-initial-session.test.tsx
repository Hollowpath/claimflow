import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { App } from '../src/app';
import { setAuth } from '../src/auth';
import { CognitoAuth } from '../src/auth/cognito';
import { setRuntimeConfig } from '../src/config';

const hostedUiUrl = 'https://claimflow-1.auth.ap-southeast-1.amazoncognito.com';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

/** Real API client and sign-in; only the network is faked. */
function setup(tokenResponse: Response | Error) {
  const tokenFetch = vi.fn<typeof fetch>();
  if (tokenResponse instanceof Error) {
    tokenFetch.mockRejectedValue(tokenResponse);
  } else {
    tokenFetch.mockResolvedValue(tokenResponse);
  }
  setRuntimeConfig({
    apiBaseUrl: 'https://abc.execute-api.ap-southeast-1.amazonaws.com/api/v1',
    cognito: { hostedUiUrl, clientId: 'client123' },
  });
  setAuth(
    new CognitoAuth({
      config: { hostedUiUrl, clientId: 'client123' },
      storage: sessionStorage,
      fetch: tokenFetch,
      now: () => Date.now(),
      navigate: vi.fn(),
      origin: 'https://d111.cloudfront.net',
    }),
  );
  sessionStorage.setItem(
    'claimflow.auth.tokens',
    JSON.stringify({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: Date.now() + 3_600_000,
    }),
  );
  return tokenFetch;
}

const renderApp = () =>
  render(
    <MemoryRouter>
      <App />
    </MemoryRouter>,
  );

describe('initial GET /session with Cognito sign-in', () => {
  it('shows the sign-in screen when the API rejects the token and the refresh fails', async () => {
    const tokenFetch = setup(json({ error: 'invalid_grant' }, 400));
    const fetchMock = vi
      .fn()
      .mockResolvedValue(json({ message: 'Unauthorized' }, 401));
    vi.stubGlobal('fetch', fetchMock);

    renderApp();

    expect(
      await screen.findByRole('heading', { name: 'Sign in to ClaimFlow' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/sign-in has ended/i);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByText(/Cannot reach/)).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tokenFetch).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('claimflow.auth.tokens')).toBeNull();
  });

  it('shows the sign-in screen when the repeated request is rejected again', async () => {
    setup(json({ access_token: 'access-2', expires_in: 3600 }));
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(json({ message: 'Unauthorized' }, 401)),
        ),
    );

    renderApp();

    expect(
      await screen.findByRole('heading', { name: 'Sign in to ClaimFlow' }),
    ).toBeInTheDocument();
    expect(sessionStorage.getItem('claimflow.auth.tokens')).toBeNull();
  });

  it('keeps the error screen and tokens for a genuine server error', async () => {
    setup(json({}));
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          json(
            { error: { code: 'INTERNAL_ERROR', message: 'Something broke.' } },
            500,
          ),
        ),
    );

    renderApp();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something broke.',
    );
    expect(
      screen.queryByRole('heading', { name: 'Sign in to ClaimFlow' }),
    ).not.toBeInTheDocument();
    expect(sessionStorage.getItem('claimflow.auth.tokens')).not.toBeNull();
  });

  it('keeps the error screen and tokens when the network is down', async () => {
    setup(json({}));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));

    renderApp();

    expect(
      await screen.findByRole('alert', {}, { timeout: 3000 }),
    ).toHaveTextContent(/Cannot reach the ClaimFlow API/);
    expect(
      screen.queryByRole('heading', { name: 'Sign in to ClaimFlow' }),
    ).not.toBeInTheDocument();
    expect(sessionStorage.getItem('claimflow.auth.tokens')).not.toBeNull();
  });
});
