import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../src/api/claimflow';
import { page, renderApp, sessionFor } from './fixtures';

vi.mock('../src/api/claimflow');

const mocked = vi.mocked(api);

function systemPrefers(scheme: 'light' | 'dark') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: query.includes('dark') && scheme === 'dark',
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

/**
 * The scheme Material UI has activated on the document. The theme's CSS
 * variables are scoped to this attribute, so it is what changes the palette.
 */
const activeScheme = () =>
  document.documentElement.getAttribute('data-mui-color-scheme');

beforeEach(() => {
  systemPrefers('light');
  mocked.getSession.mockResolvedValue(sessionFor('u-aisha'));
  mocked.listMyClaims.mockResolvedValue(page([]));
});

describe('colour mode button', () => {
  it('offers dark mode on a light system, and stores the explicit choice', async () => {
    systemPrefers('light');
    const { user } = renderApp('/claims');
    await user.click(
      await screen.findByRole('button', { name: 'Use dark mode' }),
    );

    expect(
      await screen.findByRole('button', { name: 'Use light mode' }),
    ).toBeInTheDocument();
    expect(localStorage.getItem('mui-mode')).toBe('dark');
    // The dark scheme is really active, not just recorded.
    await waitFor(() => expect(activeScheme()).toBe('dark'));
  });

  it('offers light mode on a dark system before any choice is made', async () => {
    systemPrefers('dark');
    const { user } = renderApp('/claims');
    const button = await screen.findByRole('button', {
      name: 'Use light mode',
    });
    expect(localStorage.getItem('mui-mode')).toBeNull();
    // "System" is the default, and it resolves to the dark system preference.
    await waitFor(() => expect(activeScheme()).toBe('dark'));

    await user.click(button);
    expect(
      await screen.findByRole('button', { name: 'Use dark mode' }),
    ).toBeInTheDocument();
    expect(localStorage.getItem('mui-mode')).toBe('light');
    // An explicit choice overrides the dark system preference.
    await waitFor(() => expect(activeScheme()).toBe('light'));
  });

  it('restores a stored choice over the system preference', async () => {
    systemPrefers('light');
    localStorage.setItem('mui-mode', 'dark');
    renderApp('/claims');
    expect(
      await screen.findByRole('button', { name: 'Use light mode' }),
    ).toBeInTheDocument();
    await waitFor(() => expect(activeScheme()).toBe('dark'));
  });

  it('is available when nobody is signed in', async () => {
    systemPrefers('light');
    mocked.getSession.mockResolvedValue(sessionFor(null));
    renderApp('/');
    expect(
      await screen.findByRole('button', { name: 'Use dark mode' }),
    ).toBeInTheDocument();
  });
});
