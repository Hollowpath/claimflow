import type { ClaimDto, Page } from '@claimflow/contracts';
import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../src/api/claimflow';
import {
  apiError,
  claim,
  deferred,
  page,
  renderApp,
  sessionFor,
} from './fixtures';

vi.mock('../src/api/claimflow');

const mocked = vi.mocked(api);

beforeEach(() => {
  mocked.listMyClaims.mockResolvedValue(page([]));
  mocked.listReviewQueue.mockResolvedValue(page([]));
  mocked.listAllClaims.mockResolvedValue(page([]));
});

function navLinks() {
  return within(screen.getByRole('navigation', { name: 'Main' }))
    .getAllByRole('link')
    .map((link) => link.textContent);
}

describe('sign-in and navigation', () => {
  it('shows the simulated sign-in notice and the user chooser', async () => {
    mocked.getSession.mockResolvedValue(sessionFor(null));
    mocked.selectUser.mockResolvedValue(sessionFor('u-aisha'));
    const { user } = renderApp();

    expect(await screen.findByRole('note')).toHaveTextContent(
      /development sign-in.*not for real data/i,
    );
    await user.click(
      await screen.findByRole('button', { name: /Aisha Rahman/ }),
    );
    expect(mocked.selectUser).toHaveBeenCalledWith('u-aisha');
    expect(
      await screen.findByRole('heading', { name: 'My claims' }),
    ).toBeInTheDocument();
  });

  it.each([
    ['u-aisha', ['My claims', 'New claim']],
    ['u-ben', ['My claims', 'New claim', 'Review queue']],
    ['u-chloe', ['Review queue']],
    ['u-dan', ['All claims', 'Categories']],
  ])('shows navigation for the roles of %s', async (userId, expected) => {
    mocked.getSession.mockResolvedValue(sessionFor(userId));
    renderApp();
    await screen.findByRole('navigation', { name: 'Main' });
    expect(navLinks()).toEqual(expected);
  });

  it('sends each role to its own start page', async () => {
    mocked.getSession.mockResolvedValue(sessionFor('u-dan'));
    renderApp('/');
    expect(
      await screen.findByRole('heading', { name: 'All claims' }),
    ).toBeInTheDocument();
  });

  it('blocks pages for roles the user lacks', async () => {
    mocked.getSession.mockResolvedValue(sessionFor('u-aisha'));
    renderApp('/admin/categories');
    expect(
      await screen.findByText(/This page is for the Administrator role/),
    ).toBeInTheDocument();
    expect(mocked.listCategories).not.toHaveBeenCalled();
  });

  it('returns to the chooser after signing out', async () => {
    mocked.getSession.mockResolvedValue(sessionFor('u-aisha'));
    const { user } = renderApp('/claims');
    await screen.findByRole('heading', { name: 'My claims' });
    mocked.signOut.mockResolvedValue(sessionFor(null));
    await user.selectOptions(screen.getByLabelText('Signed in as'), '');
    expect(
      await screen.findByRole('heading', { name: 'Choose a local user' }),
    ).toBeInTheDocument();
  });

  it('shows a safe error when the API is unreachable', async () => {
    mocked.getSession.mockRejectedValue(
      apiError(0, 'NETWORK_ERROR', 'Cannot reach the ClaimFlow API.'),
    );
    renderApp();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Cannot reach the ClaimFlow API.',
    );
  });
});

describe('switching users', () => {
  let serverUser: string;

  beforeEach(() => {
    serverUser = 'u-aisha';
    mocked.getSession.mockImplementation(() =>
      Promise.resolve(sessionFor(serverUser)),
    );
    mocked.selectUser.mockImplementation((userId: string) => {
      serverUser = userId;
      return Promise.resolve(sessionFor(userId));
    });
  });

  it("clears the previous user's claims", async () => {
    mocked.listMyClaims.mockImplementation(() =>
      Promise.resolve(
        serverUser === 'u-aisha'
          ? page([claim({ merchant: 'Aisha private claim' })])
          : page([]),
      ),
    );
    const { user } = renderApp('/claims');
    expect(await screen.findByText('Aisha private claim')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Signed in as'), 'u-ravi');

    expect(
      await screen.findByText('You have no claims yet.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Aisha private claim')).not.toBeInTheDocument();
  });

  it('drops a slow response that arrives after switching', async () => {
    const slow = deferred<Page<ClaimDto>>();
    mocked.listMyClaims.mockImplementation(() =>
      serverUser === 'u-aisha' ? slow.promise : Promise.resolve(page([])),
    );
    const { user } = renderApp('/claims');
    expect(await screen.findByText('Loading claims…')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Signed in as'), 'u-ravi');
    expect(
      await screen.findByText('You have no claims yet.'),
    ).toBeInTheDocument();

    slow.release(page([claim({ merchant: 'Aisha late response' })]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText('Aisha late response')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Signed in as')).toHaveValue('u-ravi');
  });
});
