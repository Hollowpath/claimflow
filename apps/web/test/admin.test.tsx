import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../src/api/claimflow';
import {
  apiError,
  claim,
  page,
  renderApp,
  sessionFor,
  training,
  travel,
} from './fixtures';

vi.mock('../src/api/claimflow');

const mocked = vi.mocked(api);

beforeEach(() => {
  mocked.getSession.mockResolvedValue(sessionFor('u-dan'));
  mocked.listCategories.mockResolvedValue([training, travel]);
});

describe('administrator claim list', () => {
  it('filters claims by status', async () => {
    mocked.listAllClaims.mockResolvedValue(
      page([claim({ status: 'APPROVED' })]),
    );
    const { user } = renderApp('/admin/claims');
    expect(
      await screen.findByText('Aisha Rahman · Travel · 10 Oct 2026'),
    ).toBeInTheDocument();

    mocked.listAllClaims.mockResolvedValue(page([]));
    await user.click(screen.getByRole('button', { name: 'Paid' }));
    expect(mocked.listAllClaims).toHaveBeenLastCalledWith(
      'PAID',
      undefined,
      expect.any(AbortSignal),
    );
    expect(await screen.findByText('No paid claims.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Paid' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

describe('category management', () => {
  it('lists categories with limits and status', async () => {
    renderApp('/admin/categories');
    const list = await screen.findByRole('list', { name: 'Categories' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getByText('Inactive')).toBeInTheDocument();
    expect(
      within(list).getAllByText(/Limit RM 2,000.00 · Receipt above RM 200.00/),
    ).toHaveLength(2);
  });

  it('creates a category with amounts in minor units', async () => {
    mocked.createCategory.mockResolvedValue({ ...travel, categoryId: 'p' });
    const { user } = renderApp('/admin/categories');
    await user.click(
      await screen.findByRole('button', { name: 'Add category' }),
    );
    const form = screen.getByRole('form', { name: 'New category' });
    await user.type(within(form).getByLabelText('Name'), 'Parking');
    await user.type(within(form).getByLabelText('Maximum claim amount'), '50');
    await user.type(
      within(form).getByLabelText('Receipt required above'),
      '10.5',
    );
    await user.click(
      within(form).getByRole('button', { name: 'Save category' }),
    );

    expect(mocked.createCategory).toHaveBeenCalledWith({
      name: 'Parking',
      currency: 'MYR',
      maxAmountMinor: 5_000,
      receiptRequiredAboveMinor: 1_050,
      active: true,
    });
    expect(
      screen.queryByRole('form', { name: 'New category' }),
    ).not.toBeInTheDocument();
  });

  it('activates and deactivates categories with the expected version', async () => {
    mocked.updateCategory.mockResolvedValue({ ...training, active: true });
    const { user } = renderApp('/admin/categories');
    await user.click(
      await screen.findByRole('button', { name: 'Activate Training' }),
    );
    expect(mocked.updateCategory).toHaveBeenCalledWith('training', {
      expectedVersion: 1,
      active: true,
    });
  });

  it('edits limits and shows server validation', async () => {
    mocked.updateCategory.mockRejectedValue(
      apiError(
        400,
        'VALIDATION_FAILED',
        'The category settings are not valid.',
        [
          {
            field: 'currency',
            code: 'INVALID_CURRENCY',
            message: 'Currency must be a three-letter uppercase code.',
          },
        ],
      ),
    );
    const { user } = renderApp('/admin/categories');
    await user.click(
      await screen.findByRole('button', { name: 'Edit Travel' }),
    );
    const form = screen.getByRole('form', { name: 'Edit Travel' });
    const max = within(form).getByLabelText('Maximum claim amount');
    expect(max).toHaveValue('2000.00');
    await user.clear(max);
    await user.type(max, '2500');
    await user.click(
      within(form).getByRole('button', { name: 'Save category' }),
    );

    expect(mocked.updateCategory).toHaveBeenCalledWith(
      'travel',
      expect.objectContaining({ expectedVersion: 1, maxAmountMinor: 250_000 }),
    );
    expect(
      await within(form).findByText(
        'Currency must be a three-letter uppercase code.',
      ),
    ).toBeInTheDocument();
  });

  it('rejects malformed limits locally', async () => {
    const { user } = renderApp('/admin/categories');
    await user.click(
      await screen.findByRole('button', { name: 'Add category' }),
    );
    const form = screen.getByRole('form', { name: 'New category' });
    await user.type(within(form).getByLabelText('Maximum claim amount'), 'abc');
    await user.click(
      within(form).getByRole('button', { name: 'Save category' }),
    );
    expect(
      within(form).getByText('Enter a maximum amount, like 500.00.'),
    ).toBeInTheDocument();
    expect(mocked.createCategory).not.toHaveBeenCalled();
  });
});

describe('deleting categories', () => {
  it('deletes a category after confirmation', async () => {
    mocked.deleteCategory.mockResolvedValue(undefined);
    const { user } = renderApp('/admin/categories');
    await user.click(
      await screen.findByRole('button', { name: 'Delete Training' }),
    );
    expect(mocked.deleteCategory).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole('button', { name: 'Confirm delete Training' }),
    );
    expect(mocked.deleteCategory).toHaveBeenCalledWith('training', 1);
  });

  it('explains when a category is still in use', async () => {
    mocked.deleteCategory.mockRejectedValue(
      apiError(
        409,
        'CATEGORY_IN_USE',
        'This category is used by existing claims. Deactivate it instead.',
      ),
    );
    const { user } = renderApp('/admin/categories');
    await user.click(
      await screen.findByRole('button', { name: 'Delete Travel' }),
    );
    await user.click(
      screen.getByRole('button', { name: 'Confirm delete Travel' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Deactivate it instead.',
    );
  });
});
