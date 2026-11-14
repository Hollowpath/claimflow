import type { ClaimDto } from '@claimflow/contracts';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../src/api/claimflow';
import { App } from '../src/app';
import {
  apiError,
  claim,
  page,
  sessionFor,
  training,
  travel,
} from './fixtures';

vi.mock('../src/api/claimflow');

const mocked = vi.mocked(api);

const reason = 'Save or cancel your changes before submitting.';

const flightReceipt: NonNullable<ClaimDto['receipt']> = {
  receiptId: 'r-1',
  fileName: 'flight.pdf',
  contentType: 'application/pdf',
  sizeBytes: 13,
  checksumSha256: 'a'.repeat(64),
  attachedAt: '2026-10-14T09:00:00.000Z',
};

function Where() {
  const { pathname, search } = useLocation();
  return <output aria-label="location">{`${pathname}${search}`}</output>;
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

const location = () => screen.getByLabelText('location');

beforeEach(() => {
  mocked.getSession.mockResolvedValue(sessionFor('u-aisha'));
  mocked.listCategories.mockResolvedValue([travel, training]);
  mocked.getHistory.mockResolvedValue(page([]));
  mocked.receiptUrl.mockReturnValue('/api/v1/claims/c-1/receipt');
  mocked.getClaim.mockResolvedValue(claim());
});

describe('creating a draft', () => {
  it('returns to the new draft’s claim page, ready for a receipt and submission', async () => {
    const created = claim({ claimId: 'c-9', merchant: 'Regional Airline' });
    mocked.createClaim.mockResolvedValue(created);
    mocked.getClaim.mockResolvedValue(created);
    const user = renderAt('/claims/new');

    await user.type(
      await screen.findByLabelText('Merchant'),
      'Regional Airline',
    );
    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Regional Airline',
      }),
    ).toBeInTheDocument();
    expect(location()).toHaveTextContent('/claims/c-9');
    expect(screen.getByLabelText('Upload receipt')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Submit for approval' }),
    ).toBeInTheDocument();
  });

  it('keeps what was typed after a server error and focuses the first problem', async () => {
    mocked.createClaim.mockRejectedValue(
      apiError(400, 'VALIDATION_FAILED', 'The claim details are not valid.', [
        {
          field: 'expenseDate',
          code: 'FUTURE_DATE',
          message: 'Expense date cannot be in the future.',
        },
      ]),
    );
    const user = renderAt('/claims/new');
    await user.type(await screen.findByLabelText('Merchant'), 'Taxi');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    expect(
      await screen.findByText('Expense date cannot be in the future.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Merchant')).toHaveValue('Taxi');
    expect(screen.getByLabelText('Expense date')).toHaveFocus();
    expect(location()).toHaveTextContent('/claims/new');
  });

  it('keeps the amount and focuses it when it is not a valid amount', async () => {
    const user = renderAt('/claims/new');
    await user.type(await screen.findByLabelText('Amount (MYR)'), '12.345');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(screen.getByLabelText('Amount (MYR)')).toHaveFocus();
    expect(screen.getByLabelText('Amount (MYR)')).toHaveValue('12.345');
    expect(mocked.createClaim).not.toHaveBeenCalled();
  });

  it('shows the category limit and receipt threshold once a category is chosen', async () => {
    const user = renderAt('/claims/new');
    const category = await screen.findByLabelText('Category');
    expect(category).not.toHaveAccessibleDescription(/Limit/);
    await user.selectOptions(category, 'travel');
    // Money is formatted with a non-breaking space, which `.` matches.
    expect(category).toHaveAccessibleDescription(
      /^Limit RM.2,000\.00\. Receipt needed above RM.200\.00\.$/,
    );
  });

  it('cancels back to the claim list without saving', async () => {
    mocked.listMyClaims.mockResolvedValue(page([]));
    const user = renderAt('/claims/new');
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(location()).toHaveTextContent('/claims');
    expect(mocked.createClaim).not.toHaveBeenCalled();
  });
});

describe('inline editing', () => {
  it('opens the form in the claim page without loading the claim again', async () => {
    const user = renderAt('/claims/c-1');
    await user.click(await screen.findByRole('link', { name: 'Edit draft' }));

    expect(await screen.findByLabelText('Merchant')).toHaveValue('City Taxi');
    expect(location()).toHaveTextContent('/claims/c-1/edit');
    expect(
      screen.queryByRole('link', { name: 'Edit draft' }),
    ).not.toBeInTheDocument();
    // The rest of the claim workspace stays on screen.
    expect(screen.getByRole('region', { name: 'Receipt' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'History' })).toBeInTheDocument();
    expect(mocked.getClaim).toHaveBeenCalledTimes(1);
  });

  it('opens straight into editing from /claims/:id/edit', async () => {
    renderAt('/claims/c-1/edit');
    expect(
      await screen.findByRole('button', { name: 'Save changes' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Amount (MYR)')).toHaveValue('125.50');
    expect(location()).toHaveTextContent('/claims/c-1/edit');
    expect(mocked.getClaim).toHaveBeenCalledTimes(1);
  });

  it('keeps the section order while editing', async () => {
    renderAt('/claims/c-1/edit');
    await screen.findByRole('button', { name: 'Save changes' });
    expect(
      screen
        .getAllByRole('heading', { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(['Details', 'Receipt', 'Next step', 'Delete draft', 'History']);
  });

  it('saves with the claim version and returns to the read view without a reload', async () => {
    mocked.updateClaim.mockResolvedValue(
      claim({ merchant: 'New name', version: 2 }),
    );
    const user = renderAt('/claims/c-1/edit');
    const merchant = await screen.findByLabelText('Merchant');
    await user.clear(merchant);
    await user.type(merchant, 'New name');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'New name' }),
    ).toBeInTheDocument();
    expect(mocked.updateClaim).toHaveBeenCalledWith('c-1', {
      expectedVersion: 1,
      categoryId: 'travel',
      amount: { amountMinor: 12_550, currency: 'MYR' },
      expenseDate: '2026-10-10',
      merchant: 'New name',
      businessPurpose: 'Client visit',
    });
    await waitFor(() =>
      expect(location()).toHaveTextContent(/^\/claims\/c-1$/),
    );
    expect(screen.queryByLabelText('Merchant')).not.toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Edit draft' }),
    ).toBeInTheDocument();
    expect(mocked.getClaim).toHaveBeenCalledTimes(1);
  });

  it('discards edits on Cancel and calls no API', async () => {
    const user = renderAt('/claims/c-1/edit');
    await user.type(await screen.findByLabelText('Merchant'), ' extra');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'City Taxi' }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(location()).toHaveTextContent(/^\/claims\/c-1$/),
    );
    expect(mocked.updateClaim).not.toHaveBeenCalled();
  });

  it('loads the categories for the form and offers an inactive one already chosen', async () => {
    mocked.getClaim.mockResolvedValue(
      claim({ categoryId: 'training', categoryName: 'Training' }),
    );
    renderAt('/claims/c-1/edit');
    expect(
      await screen.findByRole('option', { name: 'Training (inactive)' }),
    ).toBeInTheDocument();
    expect(mocked.listCategories).toHaveBeenCalledTimes(1);
  });

  it('recovers from a failed category load inside the details section', async () => {
    mocked.listCategories
      .mockRejectedValueOnce(
        apiError(500, 'INTERNAL_ERROR', 'Categories are unavailable.'),
      )
      .mockResolvedValueOnce([travel]);
    const user = renderAt('/claims/c-1/edit');
    const details = await screen.findByRole('region', { name: 'Details' });
    expect(await within(details).findByRole('alert')).toHaveTextContent(
      'Categories are unavailable.',
    );
    await user.click(
      within(details).getByRole('button', { name: 'Try again' }),
    );
    expect(await screen.findByLabelText('Merchant')).toBeInTheDocument();
  });

  it('only lets an employee open the edit link', async () => {
    mocked.getSession.mockResolvedValue(sessionFor('u-chloe'));
    renderAt('/claims/c-1/edit');
    expect(
      await screen.findByText('This page is for the Employee role.'),
    ).toBeInTheDocument();
    expect(mocked.getClaim).not.toHaveBeenCalled();
  });

  it('shows a claim that can no longer be edited, with the reason and a way back', async () => {
    mocked.getClaim.mockResolvedValue(
      claim({
        status: 'SUBMITTED',
        permissions: { canEdit: false, canDelete: false, actions: [] },
      }),
    );
    const user = renderAt('/claims/c-1/edit');
    expect(
      await screen.findByText(/can no longer be edited/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Merchant')).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 1, name: 'City Taxi' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Back to the claim' }));
    await waitFor(() =>
      expect(location()).toHaveTextContent(/^\/claims\/c-1$/),
    );
    expect(
      screen.queryByText(/can no longer be edited/),
    ).not.toBeInTheDocument();
  });
});

describe('unsaved changes and submission', () => {
  it('does not block submission while the form is open but unchanged', async () => {
    renderAt('/claims/c-1/edit');
    await screen.findByRole('button', { name: 'Save changes' });
    expect(
      screen.getByRole('button', { name: 'Submit for approval' }),
    ).toBeEnabled();
    expect(screen.queryByText(reason)).not.toBeInTheDocument();
  });

  it('blocks submission while edits are unsaved and says why', async () => {
    const user = renderAt('/claims/c-1/edit');
    await user.type(await screen.findByLabelText('Merchant'), ' extra');

    const submit = screen.getByRole('button', { name: 'Submit for approval' });
    expect(submit).toBeDisabled();
    expect(screen.getByText(reason)).toBeInTheDocument();
    expect(submit).toHaveAccessibleDescription(reason);
    expect(mocked.performAction).not.toHaveBeenCalled();
  });

  it('allows submission again when the change is undone', async () => {
    const user = renderAt('/claims/c-1/edit');
    const merchant = await screen.findByLabelText('Merchant');
    await user.type(merchant, 'x');
    expect(
      screen.getByRole('button', { name: 'Submit for approval' }),
    ).toBeDisabled();
    await user.clear(merchant);
    await user.type(merchant, 'City Taxi');
    expect(
      screen.getByRole('button', { name: 'Submit for approval' }),
    ).toBeEnabled();
    expect(screen.queryByText(reason)).not.toBeInTheDocument();
  });

  it('allows submission again after cancelling', async () => {
    const user = renderAt('/claims/c-1/edit');
    await user.type(await screen.findByLabelText('Merchant'), 'x');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(
      await screen.findByRole('button', { name: 'Submit for approval' }),
    ).toBeEnabled();
    expect(screen.queryByText(reason)).not.toBeInTheDocument();
  });

  it('submits the saved version after saving', async () => {
    mocked.updateClaim.mockResolvedValue(
      claim({ merchant: 'Saved name', version: 2 }),
    );
    mocked.performAction.mockResolvedValue(
      claim({
        version: 3,
        status: 'SUBMITTED',
        permissions: { canEdit: false, canDelete: false, actions: [] },
      }),
    );
    const user = renderAt('/claims/c-1/edit');
    await user.type(await screen.findByLabelText('Merchant'), 'x');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByRole('heading', { level: 1, name: 'Saved name' });

    // The router applies the move back to the read view a moment after the
    // save, and the form is gone once it has.
    await waitFor(() =>
      expect(location()).toHaveTextContent(/^\/claims\/c-1$/),
    );
    const submit = screen.getByRole('button', { name: 'Submit for approval' });
    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(mocked.performAction).toHaveBeenCalledWith(
      'c-1',
      'SUBMIT',
      2,
      undefined,
    );
  });
});

describe('conflict recovery', () => {
  it('keeps the edits after a version conflict and offers the latest version', async () => {
    mocked.updateClaim.mockRejectedValue(
      apiError(409, 'VERSION_CONFLICT', 'Changed by someone else.'),
    );
    const user = renderAt('/claims/c-1/edit');
    await user.type(await screen.findByLabelText('Merchant'), ' mine');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Someone else changed this first.',
    );
    expect(screen.getByLabelText('Merchant')).toHaveValue('City Taxi mine');
    // Still unsaved, so still not submittable.
    expect(
      screen.getByRole('button', { name: 'Submit for approval' }),
    ).toBeDisabled();

    mocked.getClaim.mockResolvedValue(claim({ merchant: 'Newer', version: 2 }));
    await user.click(
      screen.getByRole('button', {
        name: 'Discard my edits and load the latest version',
      }),
    );
    expect(await screen.findByLabelText('Merchant')).toHaveValue('Newer');
    expect(location()).toHaveTextContent('/claims/c-1/edit');
    expect(
      screen.getByRole('button', { name: 'Submit for approval' }),
    ).toBeEnabled();
    expect(mocked.getClaim).toHaveBeenCalledTimes(2);
  });

  it('saves with the new version after a receipt changed the claim while editing', async () => {
    mocked.attachReceiptFile.mockResolvedValue(
      claim({ version: 2, receipt: flightReceipt }),
    );
    mocked.updateClaim.mockResolvedValue(claim({ version: 3 }));
    const user = renderAt('/claims/c-1/edit');
    await user.type(await screen.findByLabelText('Merchant'), ' typed');

    await user.upload(
      screen.getByLabelText('Upload receipt'),
      new File(['%PDF'], 'flight.pdf', { type: 'application/pdf' }),
    );
    expect(await screen.findByText('Receipt attached.')).toBeInTheDocument();
    // The unsaved text survives the claim changing underneath it.
    expect(screen.getByLabelText('Merchant')).toHaveValue('City Taxi typed');

    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(mocked.updateClaim).toHaveBeenCalledWith(
      'c-1',
      expect.objectContaining({
        expectedVersion: 2,
        merchant: 'City Taxi typed',
      }),
    );
  });
});

describe('receipts on the claim page', () => {
  const withReceipt = () => claim({ version: 2, receipt: flightReceipt });

  it('attaches a receipt and says so', async () => {
    mocked.attachReceiptFile.mockResolvedValue(withReceipt());
    const user = renderAt('/claims/c-1');
    const file = new File(['%PDF'], 'flight.pdf', { type: 'application/pdf' });
    await user.upload(await screen.findByLabelText('Upload receipt'), file);

    expect(mocked.attachReceiptFile).toHaveBeenCalledWith('c-1', 1, file);
    expect(
      await screen.findByRole('link', { name: 'flight.pdf' }),
    ).toHaveAttribute('href', '/api/v1/claims/c-1/receipt');
    expect(screen.getByText('Receipt attached.')).toBeInTheDocument();
    expect(screen.getByLabelText('Replace receipt')).toBeInTheDocument();
  });

  it('replaces a receipt with the claim version and says so', async () => {
    mocked.getClaim.mockResolvedValue(withReceipt());
    mocked.attachReceiptFile.mockResolvedValue(
      claim({ version: 3, receipt: { ...flightReceipt, fileName: 'new.pdf' } }),
    );
    const user = renderAt('/claims/c-1');
    const file = new File(['%PDF'], 'new.pdf', { type: 'application/pdf' });
    await user.upload(await screen.findByLabelText('Replace receipt'), file);
    expect(mocked.attachReceiptFile).toHaveBeenCalledWith('c-1', 2, file);
    expect(await screen.findByText('Receipt replaced.')).toBeInTheDocument();
  });

  it.each([
    [
      'an unsupported type',
      () => new File(['<html>'], 'page.html', { type: 'text/html' }),
      'Choose a PDF, JPEG, or PNG file.',
    ],
    [
      'an empty file',
      () => new File([], 'empty.pdf', { type: 'application/pdf' }),
      'Receipts must be between 1 byte and 10 MB.',
    ],
    [
      'a file over 10 MB',
      () => {
        const big = new File(['x'], 'big.pdf', { type: 'application/pdf' });
        Object.defineProperty(big, 'size', { value: 10 * 1024 * 1024 + 1 });
        return big;
      },
      'Receipts must be between 1 byte and 10 MB.',
    ],
  ])('rejects %s before uploading', async (_name, makeFile, message) => {
    renderAt('/claims/c-1');
    fireEvent.change(await screen.findByLabelText('Upload receipt'), {
      target: { files: [makeFile()] },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(mocked.attachReceiptFile).not.toHaveBeenCalled();
  });

  it('shows an upload failure with a retry that reloads the claim', async () => {
    mocked.attachReceiptFile.mockRejectedValue(
      apiError(500, 'INTERNAL_ERROR', 'The receipt could not be uploaded.'),
    );
    const user = renderAt('/claims/c-1');
    await user.upload(
      await screen.findByLabelText('Upload receipt'),
      new File(['%PDF'], 'flight.pdf', { type: 'application/pdf' }),
    );
    const receipt = screen.getByRole('region', { name: 'Receipt' });
    expect(await within(receipt).findByRole('alert')).toHaveTextContent(
      'The receipt could not be uploaded.',
    );
    await user.click(
      within(receipt).getByRole('button', { name: 'Try again' }),
    );
    await waitFor(() => expect(mocked.getClaim).toHaveBeenCalledTimes(2));
  });

  describe('removing', () => {
    beforeEach(() => {
      mocked.getClaim.mockResolvedValue(withReceipt());
    });

    it('asks in a dialog that names the file, and Cancel keeps the receipt', async () => {
      const user = renderAt('/claims/c-1');
      const remove = await screen.findByRole('button', { name: 'Remove' });
      await user.click(remove);

      const dialog = await screen.findByRole('alertdialog', {
        name: 'Remove this receipt?',
      });
      expect(dialog).toHaveAccessibleDescription(/flight\.pdf/);
      expect(
        within(dialog).getByRole('button', { name: 'Cancel' }),
      ).toHaveFocus();

      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() =>
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument(),
      );
      await waitFor(() => expect(remove).toHaveFocus());
      expect(mocked.removeReceipt).not.toHaveBeenCalled();
      expect(
        screen.getByRole('link', { name: 'flight.pdf' }),
      ).toBeInTheDocument();
    });

    it('is cancelled by Escape', async () => {
      const user = renderAt('/claims/c-1');
      await user.click(await screen.findByRole('button', { name: 'Remove' }));
      await screen.findByRole('alertdialog');
      await user.keyboard('{Escape}');
      await waitFor(() =>
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument(),
      );
      expect(mocked.removeReceipt).not.toHaveBeenCalled();
    });

    it('removes the receipt after confirmation and says so', async () => {
      mocked.removeReceipt.mockResolvedValue(claim({ version: 3 }));
      const user = renderAt('/claims/c-1');
      await user.click(await screen.findByRole('button', { name: 'Remove' }));
      const dialog = await screen.findByRole('alertdialog');
      await user.click(
        within(dialog).getByRole('button', { name: 'Remove receipt' }),
      );

      expect(mocked.removeReceipt).toHaveBeenCalledWith('c-1', 2);
      expect(
        await screen.findByText('No receipt attached.'),
      ).toBeInTheDocument();
      expect(screen.getByText('Receipt removed.')).toBeInTheDocument();
      await waitFor(() =>
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument(),
      );
    });

    it('keeps the dialog open with the error and a way to load the latest version', async () => {
      mocked.removeReceipt.mockRejectedValue(
        apiError(409, 'VERSION_CONFLICT', 'Changed by someone else.'),
      );
      const user = renderAt('/claims/c-1');
      await user.click(await screen.findByRole('button', { name: 'Remove' }));
      const dialog = await screen.findByRole('alertdialog');
      await user.click(
        within(dialog).getByRole('button', { name: 'Remove receipt' }),
      );

      expect(await within(dialog).findByRole('alert')).toHaveTextContent(
        'Someone else changed this first.',
      );
      expect(screen.getByRole('alertdialog')).toBeInTheDocument();

      await user.click(
        within(dialog).getByRole('button', { name: 'Load the latest version' }),
      );
      await waitFor(() => expect(mocked.getClaim).toHaveBeenCalledTimes(2));
    });
  });
});
