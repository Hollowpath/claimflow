import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../src/api/claimflow';
import { App } from '../src/app';
import { setAuth } from '../src/auth';
import { CognitoAuth } from '../src/auth/cognito';
import { setRuntimeConfig } from '../src/config';
import { page, sessionFor } from './fixtures';

vi.mock('../src/api/claimflow');

const mocked = vi.mocked(api);
const hostedUiUrl = 'https://claimflow-1.auth.ap-southeast-1.amazoncognito.com';

function Where() {
  const { pathname, search } = useLocation();
  return <output aria-label="location">{`${pathname}${search}`}</output>;
}

function setup() {
  const tokenFetch = vi.fn<typeof fetch>();
  const navigate = vi.fn<(url: string) => void>();
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
      navigate,
      origin: 'https://d111.cloudfront.net',
    }),
  );
  return { tokenFetch, navigate };
}

function renderAt(path: string) {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
      <Where />
    </MemoryRouter>,
  );
  return user;
}

const storeTokens = () =>
  sessionStorage.setItem(
    'claimflow.auth.tokens',
    JSON.stringify({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: Date.now() + 3_600_000,
    }),
  );

beforeEach(() => {
  mocked.listMyClaims.mockResolvedValue(page([]));
});

describe('Cognito sign-in screen', () => {
  it('asks for sign-in without calling the API or showing the sample users', async () => {
    const { navigate } = setup();
    const user = renderAt('/');

    expect(
      await screen.findByRole('heading', { name: 'Sign in to ClaimFlow' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(screen.queryByText(/Choose a local user/)).not.toBeInTheDocument();
    expect(mocked.getSession).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate.mock.calls[0]![0]).toContain(
      `${hostedUiUrl}/oauth2/authorize?`,
    );
    expect(sessionStorage.getItem('claimflow.auth.pending')).not.toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it('loads the session straight away when tokens are already stored', async () => {
    setup();
    storeTokens();
    mocked.getSession.mockResolvedValue({
      ...sessionFor('u-aisha'),
      users: [],
    });
    renderAt('/claims');

    expect(
      await screen.findByRole('heading', { name: 'My claims' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Aisha Rahman')).toBeInTheDocument();
    expect(screen.queryByLabelText('Signed in as')).not.toBeInTheDocument();
  });
});

describe('/auth/callback', () => {
  async function begin(ctx: ReturnType<typeof setup>) {
    // Start sign-in through the real flow to get a valid state and verifier.
    const auth = new CognitoAuth({
      config: { hostedUiUrl, clientId: 'client123' },
      storage: sessionStorage,
      fetch: ctx.tokenFetch,
      now: () => Date.now(),
      navigate: ctx.navigate,
      origin: 'https://d111.cloudfront.net',
    });
    await auth.beginSignIn();
    return (
      JSON.parse(sessionStorage.getItem('claimflow.auth.pending')!) as {
        state: string;
      }
    ).state;
  }

  it('exchanges the code, removes the parameters, then loads the session', async () => {
    const ctx = setup();
    const state = await begin(ctx);
    ctx.tokenFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: 'access-1', expires_in: 3600 }),
      ),
    );
    mocked.getSession.mockResolvedValue(sessionFor('u-aisha'));

    renderAt(`/auth/callback?code=abc&state=${state}`);

    expect(
      await screen.findByRole('heading', { name: 'My claims' }),
    ).toBeInTheDocument();
    expect(ctx.tokenFetch).toHaveBeenCalledTimes(1);
    expect(mocked.getSession).toHaveBeenCalled();
    // The router applies navigation as a lower-priority update, so it can
    // land after the session UI; wait for it instead of assuming the order.
    await waitFor(() =>
      expect(screen.getByLabelText('location')).toHaveTextContent(/^\/claims$/),
    );
    expect(screen.getByLabelText('location').textContent).not.toContain('code');
    expect(localStorage.length).toBe(0);
  });

  it('shows the error, removes the parameters, and does not call the API', async () => {
    const ctx = setup();
    const state = await begin(ctx);

    renderAt(
      `/auth/callback?error=access_denied&error_description=Cancelled%20by%20user&state=${state}`,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Cancelled by user',
    );
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(mocked.getSession).not.toHaveBeenCalled();
    expect(ctx.tokenFetch).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByLabelText('location')).toHaveTextContent(/^\/$/),
    );
  });

  it('rejects a callback whose state does not match', async () => {
    const ctx = setup();
    await begin(ctx);

    renderAt('/auth/callback?code=abc&state=forged');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /could not be verified/,
    );
    expect(ctx.tokenFetch).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('claimflow.auth.tokens')).toBeNull();
  });
});

describe('signing out', () => {
  it('clears local tokens and goes to the Cognito logout endpoint', async () => {
    const { navigate } = setup();
    storeTokens();
    mocked.getSession.mockResolvedValue(sessionFor('u-aisha'));
    const user = renderAt('/claims');
    await screen.findByRole('heading', { name: 'My claims' });

    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(sessionStorage.getItem('claimflow.auth.tokens')).toBeNull();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate.mock.calls[0]![0]).toContain(`${hostedUiUrl}/logout?`);
    expect(
      await screen.findByRole('heading', { name: 'Sign in to ClaimFlow' }),
    ).toBeInTheDocument();
  });
});
