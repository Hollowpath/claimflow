import type { SessionDto } from '@claimflow/contracts';
import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../src/api/claimflow';
import {
  apiError,
  deferred,
  never,
  page,
  renderApp,
  sessionFor,
  users,
} from './fixtures';

vi.mock('../src/api/claimflow');

const mocked = vi.mocked(api);

beforeEach(() => {
  mocked.listMyClaims.mockResolvedValue(page([]));
  mocked.listReviewQueue.mockResolvedValue(page([]));
  mocked.listAllClaims.mockResolvedValue(page([]));
  mocked.listCategories.mockResolvedValue([]);
});

describe('application shell', () => {
  it('has a skip link as the first stop, a banner, navigation, and a main landmark', async () => {
    mocked.getSession.mockResolvedValue(sessionFor('u-aisha'));
    const { user } = renderApp('/claims');
    await screen.findByRole('heading', { name: 'My claims' });

    await user.tab();
    const skip = screen.getByRole('link', { name: 'Skip to main content' });
    expect(skip).toHaveFocus();
    expect(skip).toHaveAttribute('href', '#main');

    expect(screen.getByRole('banner')).toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main');
    expect(
      within(screen.getByRole('navigation', { name: 'Main' })).getAllByRole(
        'link',
      ),
    ).toHaveLength(1);
  });

  it('shows the product name as a link to the start page', async () => {
    mocked.getSession.mockResolvedValue(sessionFor('u-aisha'));
    renderApp('/claims');
    await screen.findByRole('heading', { name: 'My claims' });
    expect(screen.getByRole('link', { name: 'ClaimFlow' })).toHaveAttribute(
      'href',
      '/',
    );
  });

  it('marks only the current page in the navigation', async () => {
    mocked.getSession.mockResolvedValue(sessionFor('u-ben'));
    renderApp('/review');
    await screen.findByRole('navigation', { name: 'Main' });
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(
      within(nav).getByRole('link', { name: 'Review queue' }),
    ).toHaveAttribute('aria-current', 'page');
    expect(
      within(nav).getByRole('link', { name: 'My claims' }),
    ).not.toHaveAttribute('aria-current');
  });

  it('moves focus to the main content after navigating, not on first load', async () => {
    mocked.getSession.mockResolvedValue(sessionFor('u-ben'));
    const { user } = renderApp('/claims');
    await screen.findByRole('heading', { name: 'My claims' });
    expect(screen.getByRole('main')).not.toHaveFocus();

    await user.click(
      within(screen.getByRole('navigation', { name: 'Main' })).getByRole(
        'link',
        { name: 'Review queue' },
      ),
    );
    await screen.findByRole('heading', { name: 'Review queue' });
    expect(screen.getByRole('main')).toHaveFocus();
  });

  it('shows the development notice as a note only with sample users', async () => {
    mocked.getSession.mockResolvedValue(sessionFor('u-dan'));
    renderApp('/');
    expect(await screen.findByRole('note')).toHaveTextContent(
      'Development sign-in',
    );
  });

  it('offers a labelled user selector that lists everyone with their roles', async () => {
    mocked.getSession.mockResolvedValue(sessionFor('u-ben'));
    renderApp('/review');
    const select = await screen.findByLabelText('Signed in as');
    expect(select).toHaveValue('u-ben');
    expect(
      within(select).getByRole('option', {
        name: 'Ben Tan — Employee, Manager',
      }),
    ).toBeInTheDocument();
    expect(
      within(select).getByRole('option', { name: 'Nobody (signed out)' }),
    ).toBeInTheDocument();
  });

  it('disables the selector while switching and shows a failed switch', async () => {
    mocked.getSession.mockResolvedValue(sessionFor('u-aisha'));
    const pending = deferred<SessionDto>();
    mocked.selectUser.mockReturnValueOnce(pending.promise);
    const { user } = renderApp('/claims');
    await screen.findByRole('heading', { name: 'My claims' });

    const select = screen.getByLabelText('Signed in as');
    void user.selectOptions(select, 'u-ravi');
    await vi.waitFor(() => expect(select).toBeDisabled());
    pending.release(sessionFor('u-ravi'));
    await vi.waitFor(() => expect(select).toBeEnabled());

    mocked.selectUser.mockRejectedValueOnce(
      apiError(500, 'INTERNAL_ERROR', 'Could not switch user.'),
    );
    await user.selectOptions(screen.getByLabelText('Signed in as'), 'u-aisha');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not switch user.',
    );
  });
});

describe('start, loading, and empty states', () => {
  it('announces the session loading state', () => {
    mocked.getSession.mockReturnValue(never());
    renderApp('/');
    expect(screen.getByRole('status')).toHaveTextContent('Starting ClaimFlow…');
  });

  it('retries a failed session load', async () => {
    mocked.getSession
      .mockRejectedValueOnce(
        apiError(0, 'NETWORK_ERROR', 'Cannot reach the ClaimFlow API.'),
      )
      .mockResolvedValueOnce(sessionFor('u-aisha'));
    const { user } = renderApp('/claims');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Cannot reach the ClaimFlow API.',
    );
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('heading', { name: 'My claims' }),
    ).toBeInTheDocument();
  });

  it('explains an unknown page and links to the start page', async () => {
    mocked.getSession.mockResolvedValue(sessionFor('u-aisha'));
    const { user } = renderApp('/nowhere');
    expect(await screen.findByText('Page not found.')).toBeInTheDocument();
    await user.click(
      screen.getByRole('link', { name: 'Go to your start page' }),
    );
    expect(
      await screen.findByRole('heading', { name: 'My claims' }),
    ).toBeInTheDocument();
  });

  it('explains an account with no roles', async () => {
    mocked.getSession.mockResolvedValue({
      user: {
        userId: 'u-none',
        displayName: 'No Roles',
        title: 'Visitor',
        roles: [],
      },
      users,
    });
    renderApp('/');
    expect(
      await screen.findByText('Your account has no roles.'),
    ).toBeInTheDocument();
  });

  it('links a blocked page back to the start page', async () => {
    mocked.getSession.mockResolvedValue(sessionFor('u-aisha'));
    renderApp('/review');
    await screen.findByText(/This page is for the Manager role/);
    expect(
      screen.getByRole('link', { name: 'Go to your start page' }),
    ).toHaveAttribute('href', '/');
  });
});

describe('sample-user chooser', () => {
  it('lists every sample user as a button with name, title, and roles', async () => {
    mocked.getSession.mockResolvedValue(sessionFor(null));
    renderApp('/');
    const list = await screen.findByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(users.length);
    const ben = within(list).getByRole('button', { name: /Ben Tan/ });
    expect(ben).toHaveAccessibleName(/Sales manager/);
    expect(ben).toHaveAccessibleName(/Employee, Manager/);
  });

  it('disables the choices while a user is being selected', async () => {
    mocked.getSession.mockResolvedValue(sessionFor(null));
    const pending = deferred<SessionDto>();
    mocked.selectUser.mockReturnValueOnce(pending.promise);
    const { user } = renderApp('/');
    const aisha = await screen.findByRole('button', { name: /Aisha Rahman/ });
    void user.click(aisha);
    await vi.waitFor(() =>
      expect(screen.getByRole('button', { name: /Ravi Kumar/ })).toBeDisabled(),
    );
    pending.release(sessionFor('u-aisha'));
  });
});
