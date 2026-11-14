import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../src/api/claimflow';
import { claim, page, renderApp, sessionFor } from './fixtures';

vi.mock('../src/api/claimflow');

const mocked = vi.mocked(api);

beforeEach(() => {
  mocked.getSession.mockResolvedValue(sessionFor('u-dan'));
});

// Category management has its own file: categories.test.tsx.
describe('administrator claim list', () => {
  it('filters claims by status', async () => {
    mocked.listAllClaims.mockResolvedValue(
      page([claim({ status: 'APPROVED' })]),
    );
    const { user } = renderApp('/admin/claims');
    const table = await screen.findByRole('table', { name: 'All claims' });
    const row = within(table).getByRole('row', { name: /City Taxi/ });
    expect(within(row).getByText('Aisha Rahman')).toBeInTheDocument();
    expect(within(row).getByText('Travel')).toBeInTheDocument();
    expect(within(row).getByText('10 Oct 2026')).toBeInTheDocument();
    expect(within(row).getByText('Approved')).toBeInTheDocument();

    mocked.listAllClaims.mockResolvedValue(page([]));
    await user.selectOptions(screen.getByLabelText('Status'), 'PAID');
    expect(mocked.listAllClaims).toHaveBeenLastCalledWith(
      'PAID',
      undefined,
      expect.any(AbortSignal),
    );
    expect(await screen.findByText('No paid claims.')).toBeInTheDocument();
    expect(screen.getByLabelText('Status')).toHaveValue('PAID');
  });
});
