import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../src/api/claimflow';
import {
  apiError,
  never,
  renderApp,
  sessionFor,
  training,
  travel,
} from './fixtures';

vi.mock('../src/api/claimflow');

const mocked = vi.mocked(api);

/** A promise the test settles when it chooses, to hold a request in flight. */
function controlled<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  mocked.getSession.mockResolvedValue(sessionFor('u-dan'));
  mocked.listCategories.mockResolvedValue([training, travel]);
});

const dialog = (name: string | RegExp) => screen.findByRole('dialog', { name });

describe('category table', () => {
  it('lists every category with its limits and status in a labelled table', async () => {
    renderApp('/admin/categories');
    const table = await screen.findByRole('table', { name: 'Categories' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual([
      'Name',
      'Currency',
      'Maximum claim amount',
      'Receipt required above',
      'Status',
      'Actions',
    ]);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    const inactive = within(table).getByRole('row', { name: /Training/ });
    expect(within(inactive).getByText('Inactive')).toBeInTheDocument();
    expect(within(table).getAllByText(/RM.2,000\.00/)).toHaveLength(2);
    expect(within(table).getAllByText(/RM.200\.00/)).toHaveLength(2);
    expect(
      within(table).getByRole('rowheader', { name: 'Travel' }),
    ).toBeInTheDocument();
  });

  it('explains the rule and offers Add category in the page header', async () => {
    renderApp('/admin/categories');
    await screen.findByRole('table', { name: 'Categories' });
    expect(
      screen.getByRole('heading', { level: 1, name: 'Categories' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /apply when a claim is submitted, including claims drafted/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add category' })).toBeEnabled();
  });

  it('announces loading while the categories load', async () => {
    mocked.listCategories.mockReturnValue(never());
    renderApp('/admin/categories');
    expect(await screen.findByText('Loading categories…')).toBeInTheDocument();
    // The page stays usable while it waits.
    expect(screen.getByRole('button', { name: 'Add category' })).toBeEnabled();
  });

  it('keeps the error and empty states with a retry', async () => {
    mocked.listCategories
      .mockRejectedValueOnce(
        apiError(500, 'INTERNAL_ERROR', 'Categories are unavailable.'),
      )
      .mockResolvedValueOnce([]);
    const { user } = renderApp('/admin/categories');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Categories are unavailable.',
    );
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No categories yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add category' })).toBeEnabled();
  });

  it('is for administrators only and fetches nothing otherwise', async () => {
    mocked.getSession.mockResolvedValue(sessionFor('u-aisha'));
    renderApp('/admin/categories');
    expect(
      await screen.findByText(/This page is for the Administrator role/),
    ).toBeInTheDocument();
    expect(mocked.listCategories).not.toHaveBeenCalled();
  });
});

describe('status controls', () => {
  it('activates a category with its version and says so', async () => {
    mocked.updateCategory.mockResolvedValue({ ...training, active: true });
    const { user } = renderApp('/admin/categories');
    await user.click(
      await screen.findByRole('button', { name: 'Activate Training' }),
    );
    expect(mocked.updateCategory).toHaveBeenCalledWith('training', {
      expectedVersion: 1,
      active: true,
    });
    expect(await screen.findByText('Training activated.')).toBeInTheDocument();
    expect(mocked.listCategories).toHaveBeenCalledTimes(2);
  });

  it('deactivates an active category', async () => {
    mocked.updateCategory.mockResolvedValue({ ...travel, active: false });
    const { user } = renderApp('/admin/categories');
    await user.click(
      await screen.findByRole('button', { name: 'Deactivate Travel' }),
    );
    expect(mocked.updateCategory).toHaveBeenCalledWith('travel', {
      expectedVersion: 1,
      active: false,
    });
    expect(await screen.findByText('Travel deactivated.')).toBeInTheDocument();
  });

  it('disables the controls while changing and shows a failure with recovery', async () => {
    const pending = controlled<typeof training>();
    mocked.updateCategory.mockReturnValueOnce(pending.promise);
    const { user } = renderApp('/admin/categories');
    await user.click(
      await screen.findByRole('button', { name: 'Activate Training' }),
    );
    expect(
      screen.getByRole('button', { name: 'Deactivate Travel' }),
    ).toBeDisabled();
    pending.reject(apiError(409, 'VERSION_CONFLICT', 'Changed by someone.'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Someone else changed this first.',
    );
    expect(
      screen.getByRole('button', { name: 'Deactivate Travel' }),
    ).toBeEnabled();
    await user.click(
      screen.getByRole('button', { name: 'Load the latest version' }),
    );
    await waitFor(() => expect(mocked.listCategories).toHaveBeenCalledTimes(2));
  });
});

describe('adding a category', () => {
  it('opens a named dialog focused on Name and creates with amounts in minor units', async () => {
    mocked.createCategory.mockResolvedValue({
      ...travel,
      categoryId: 'p',
      name: 'Parking',
    });
    const { user } = renderApp('/admin/categories');
    await user.click(
      await screen.findByRole('button', { name: 'Add category' }),
    );
    const form = await dialog('New category');
    expect(within(form).getByLabelText('Name')).toHaveFocus();
    expect(within(form).getByLabelText('Currency')).toHaveValue('MYR');
    expect(within(form).getByLabelText(/Active/)).toBeChecked();
    expect(
      within(form).queryByRole('button', { name: 'Delete category' }),
    ).not.toBeInTheDocument();

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
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    expect(await screen.findByText('Parking added.')).toBeInTheDocument();
    expect(mocked.listCategories).toHaveBeenCalledTimes(2);
  });

  it('upper-cases the currency and sends the active choice', async () => {
    mocked.createCategory.mockResolvedValue({ ...travel, categoryId: 'p' });
    const { user } = renderApp('/admin/categories');
    await user.click(
      await screen.findByRole('button', { name: 'Add category' }),
    );
    const form = await dialog('New category');
    await user.type(within(form).getByLabelText('Name'), 'Fuel');
    await user.clear(within(form).getByLabelText('Currency'));
    await user.type(within(form).getByLabelText('Currency'), 'usd');
    await user.type(within(form).getByLabelText('Maximum claim amount'), '100');
    await user.type(within(form).getByLabelText('Receipt required above'), '0');
    await user.click(within(form).getByLabelText(/Active/));
    await user.click(
      within(form).getByRole('button', { name: 'Save category' }),
    );
    expect(mocked.createCategory).toHaveBeenCalledWith({
      name: 'Fuel',
      currency: 'USD',
      maxAmountMinor: 10_000,
      receiptRequiredAboveMinor: 0,
      active: false,
    });
  });

  it('rejects malformed amounts locally, beside their fields, with focus on the first', async () => {
    const { user } = renderApp('/admin/categories');
    await user.click(
      await screen.findByRole('button', { name: 'Add category' }),
    );
    const form = await dialog('New category');
    await user.type(within(form).getByLabelText('Maximum claim amount'), 'abc');
    await user.type(within(form).getByLabelText('Receipt required above'), 'x');
    await user.click(
      within(form).getByRole('button', { name: 'Save category' }),
    );

    const max = within(form).getByLabelText('Maximum claim amount');
    expect(max).toHaveAttribute('aria-invalid', 'true');
    expect(max).toHaveAccessibleDescription(
      'Enter a maximum amount, like 500.00.',
    );
    expect(max).toHaveFocus();
    expect(
      within(form).getByLabelText('Receipt required above'),
    ).toHaveAccessibleDescription(/Enter an amount, or 0 to always require/);
    expect(mocked.createCategory).not.toHaveBeenCalled();
    // The values typed so far are kept.
    expect(max).toHaveValue('abc');
  });

  it('shows server validation next to the field and keeps the dialog open', async () => {
    mocked.createCategory.mockRejectedValue(
      apiError(
        400,
        'VALIDATION_FAILED',
        'The category settings are not valid.',
        [
          {
            field: 'name',
            code: 'DUPLICATE',
            message: 'A category with this name already exists.',
          },
        ],
      ),
    );
    const { user } = renderApp('/admin/categories');
    await user.click(
      await screen.findByRole('button', { name: 'Add category' }),
    );
    const form = await dialog('New category');
    await user.type(within(form).getByLabelText('Name'), 'Travel');
    await user.type(within(form).getByLabelText('Maximum claim amount'), '50');
    await user.type(within(form).getByLabelText('Receipt required above'), '5');
    await user.click(
      within(form).getByRole('button', { name: 'Save category' }),
    );

    expect(
      await within(form).findByText(
        'A category with this name already exists.',
      ),
    ).toBeInTheDocument();
    expect(within(form).getByLabelText('Name')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(within(form).getByLabelText('Name')).toHaveFocus();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(
      within(form).getByRole('button', { name: 'Save category' }),
    ).toBeEnabled();
  });

  it('is cancelled by Cancel and by Escape, returning focus to Add category', async () => {
    const { user } = renderApp('/admin/categories');
    const add = await screen.findByRole('button', { name: 'Add category' });

    await user.click(add);
    await dialog('New category');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(add).toHaveFocus());

    await user.click(add);
    await dialog('New category');
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    expect(mocked.createCategory).not.toHaveBeenCalled();
  });

  it('shows progress while saving and blocks a second save', async () => {
    const pending = controlled<typeof travel>();
    mocked.createCategory.mockReturnValue(pending.promise);
    const { user } = renderApp('/admin/categories');
    await user.click(
      await screen.findByRole('button', { name: 'Add category' }),
    );
    const form = await dialog('New category');
    await user.type(within(form).getByLabelText('Name'), 'Fuel');
    await user.type(within(form).getByLabelText('Maximum claim amount'), '5');
    await user.type(within(form).getByLabelText('Receipt required above'), '1');
    await user.click(
      within(form).getByRole('button', { name: 'Save category' }),
    );
    expect(
      within(form).getByRole('button', { name: 'Saving…' }),
    ).toBeDisabled();
    expect(within(form).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    pending.resolve({ ...travel, categoryId: 'p', name: 'Fuel' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    expect(mocked.createCategory).toHaveBeenCalledTimes(1);
  });
});

describe('editing a category', () => {
  it('opens named dialog with the current values and saves with the version', async () => {
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
    const form = await dialog('Edit Travel');
    expect(within(form).getByLabelText('Name')).toHaveValue('Travel');
    const max = within(form).getByLabelText('Maximum claim amount');
    expect(max).toHaveValue('2000.00');
    expect(within(form).getByLabelText('Receipt required above')).toHaveValue(
      '200.00',
    );
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
    expect(within(form).getByLabelText('Currency')).toHaveFocus();
  });

  it('saves, closes, says so, and reloads the list', async () => {
    mocked.updateCategory.mockResolvedValue({ ...travel, name: 'Trips' });
    const { user } = renderApp('/admin/categories');
    await user.click(
      await screen.findByRole('button', { name: 'Edit Travel' }),
    );
    const form = await dialog('Edit Travel');
    const name = within(form).getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Trips');
    await user.click(
      within(form).getByRole('button', { name: 'Save category' }),
    );
    expect(await screen.findByText('Trips saved.')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    expect(mocked.updateCategory).toHaveBeenCalledWith(
      'travel',
      expect.objectContaining({ expectedVersion: 1, name: 'Trips' }),
    );
    expect(mocked.listCategories).toHaveBeenCalledTimes(2);
  });

  it('offers the latest version after a conflict', async () => {
    mocked.updateCategory.mockRejectedValue(
      apiError(409, 'VERSION_CONFLICT', 'Changed by someone.'),
    );
    const { user } = renderApp('/admin/categories');
    await user.click(
      await screen.findByRole('button', { name: 'Edit Travel' }),
    );
    const form = await dialog('Edit Travel');
    await user.click(
      within(form).getByRole('button', { name: 'Save category' }),
    );
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'Someone else changed this first.',
    );
    await user.click(
      within(form).getByRole('button', { name: 'Load the latest version' }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(mocked.listCategories).toHaveBeenCalledTimes(2));
  });

  it('returns focus to the row’s Edit button when closed', async () => {
    const { user } = renderApp('/admin/categories');
    const edit = await screen.findByRole('button', { name: 'Edit Travel' });
    await user.click(edit);
    await dialog('Edit Travel');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(edit).toHaveFocus());
  });
});

describe('deleting a category', () => {
  async function openDelete(
    user: ReturnType<typeof renderApp>['user'],
    name: string,
  ) {
    await user.click(
      await screen.findByRole('button', { name: `Edit ${name}` }),
    );
    const form = await dialog(`Edit ${name}`);
    await user.click(
      within(form).getByRole('button', { name: 'Delete category' }),
    );
    return screen.findByRole('alertdialog', { name: `Delete ${name}?` });
  }

  it('is offered inside the edit dialog and confirmed in an alert dialog that names the category', async () => {
    mocked.deleteCategory.mockResolvedValue(undefined);
    const { user } = renderApp('/admin/categories');
    const confirm = await openDelete(user, 'Training');

    expect(screen.queryByRole('dialog', { name: 'Edit Training' })).toBeNull();
    expect(confirm).toHaveAccessibleDescription(/Training.*cannot be undone/);
    expect(
      within(confirm).getByRole('button', { name: 'Cancel' }),
    ).toHaveFocus();
    expect(mocked.deleteCategory).not.toHaveBeenCalled();

    await user.click(
      within(confirm).getByRole('button', { name: 'Delete category' }),
    );
    expect(mocked.deleteCategory).toHaveBeenCalledWith('training', 1);
    expect(await screen.findByText('Training deleted.')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument(),
    );
    expect(mocked.listCategories).toHaveBeenCalledTimes(2);
  });

  it('Cancel and Escape keep the category and return focus to its Edit button', async () => {
    const { user } = renderApp('/admin/categories');
    const confirm = await openDelete(user, 'Training');
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Edit Training' }),
      ).toHaveFocus(),
    );

    await openDelete(user, 'Training');
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument(),
    );
    expect(mocked.deleteCategory).not.toHaveBeenCalled();
    expect(
      screen.getByRole('rowheader', { name: 'Training' }),
    ).toBeInTheDocument();
  });

  it('shows progress and cannot be dismissed while deleting', async () => {
    const pending = controlled<undefined>();
    mocked.deleteCategory.mockReturnValue(pending.promise);
    const { user } = renderApp('/admin/categories');
    const confirm = await openDelete(user, 'Training');
    await user.click(
      within(confirm).getByRole('button', { name: 'Delete category' }),
    );
    expect(
      within(confirm).getByRole('button', { name: 'Deleting…' }),
    ).toBeDisabled();
    expect(
      within(confirm).getByRole('button', { name: 'Cancel' }),
    ).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    pending.resolve(undefined);
    await waitFor(() =>
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument(),
    );
  });

  it('explains when an active category is in use and offers to deactivate it instead', async () => {
    mocked.deleteCategory.mockRejectedValue(
      apiError(
        409,
        'CATEGORY_IN_USE',
        'This category is used by existing claims. Deactivate it instead.',
      ),
    );
    mocked.updateCategory.mockResolvedValue({ ...travel, active: false });
    const { user } = renderApp('/admin/categories');
    const confirm = await openDelete(user, 'Travel');
    await user.click(
      within(confirm).getByRole('button', { name: 'Delete category' }),
    );

    expect(await within(confirm).findByRole('alert')).toHaveTextContent(
      'Deactivate it instead.',
    );
    // The error itself has no "Try again": nothing about it is transient.
    expect(
      within(confirm).queryByRole('button', { name: 'Try again' }),
    ).not.toBeInTheDocument();

    await user.click(
      within(confirm).getByRole('button', { name: 'Deactivate instead' }),
    );
    expect(mocked.updateCategory).toHaveBeenCalledWith('travel', {
      expectedVersion: 1,
      active: false,
    });
    expect(await screen.findByText('Travel deactivated.')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument(),
    );
    expect(mocked.listCategories).toHaveBeenCalledTimes(2);
  });

  it('does not offer to deactivate a category that is already inactive', async () => {
    mocked.deleteCategory.mockRejectedValue(
      apiError(
        409,
        'CATEGORY_IN_USE',
        'This category is used by existing claims. Deactivate it instead.',
      ),
    );
    const { user } = renderApp('/admin/categories');
    const confirm = await openDelete(user, 'Training');
    await user.click(
      within(confirm).getByRole('button', { name: 'Delete category' }),
    );
    expect(await within(confirm).findByRole('alert')).toBeInTheDocument();
    expect(
      within(confirm).queryByRole('button', { name: 'Deactivate instead' }),
    ).not.toBeInTheDocument();
  });

  it('keeps the dialog and shows the error when deactivating instead fails', async () => {
    mocked.deleteCategory.mockRejectedValue(
      apiError(
        409,
        'CATEGORY_IN_USE',
        'This category is used by existing claims.',
      ),
    );
    mocked.updateCategory.mockRejectedValue(
      apiError(500, 'INTERNAL_ERROR', 'Could not deactivate the category.'),
    );
    const { user } = renderApp('/admin/categories');
    const confirm = await openDelete(user, 'Travel');
    await user.click(
      within(confirm).getByRole('button', { name: 'Delete category' }),
    );
    await user.click(
      await within(confirm).findByRole('button', {
        name: 'Deactivate instead',
      }),
    );
    expect(await within(confirm).findByRole('alert')).toHaveTextContent(
      'Could not deactivate the category.',
    );
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('offers the latest version after a conflict and reloads the list', async () => {
    mocked.deleteCategory.mockRejectedValue(
      apiError(409, 'VERSION_CONFLICT', 'Changed by someone.'),
    );
    const { user } = renderApp('/admin/categories');
    const confirm = await openDelete(user, 'Training');
    await user.click(
      within(confirm).getByRole('button', { name: 'Delete category' }),
    );
    expect(await within(confirm).findByRole('alert')).toHaveTextContent(
      'Someone else changed this first.',
    );
    await user.click(
      within(confirm).getByRole('button', { name: 'Load the latest version' }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(mocked.listCategories).toHaveBeenCalledTimes(2));
  });
});
