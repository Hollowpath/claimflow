import { fireEvent, screen, within } from '@testing-library/react';
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

function signInAs(userId: string) {
  mocked.getSession.mockResolvedValue(sessionFor(userId));
}

beforeEach(() => {
  mocked.listCategories.mockResolvedValue([travel, training]);
  mocked.getHistory.mockResolvedValue(page([]));
  mocked.receiptUrl.mockReturnValue('/api/v1/claims/c-1/receipt');
});

describe('claim lists', () => {
  it('shows an empty state with a call to action', async () => {
    signInAs('u-aisha');
    mocked.listMyClaims.mockResolvedValue(page([]));
    renderApp('/claims');
    expect(
      await screen.findByText('You have no claims yet.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Create your first claim' }),
    ).toBeInTheDocument();
  });

  it('lists claims with formatted amounts and loads more pages', async () => {
    signInAs('u-aisha');
    mocked.listMyClaims
      .mockResolvedValueOnce(page([claim()], 'cursor-1'))
      .mockResolvedValueOnce(
        page([claim({ claimId: 'c-2', merchant: 'Hotel', status: 'PAID' })]),
      );
    const { user } = renderApp('/claims');

    const list = await screen.findByRole('list', { name: 'Claims' });
    expect(within(list).getByText('City Taxi')).toBeInTheDocument();
    expect(within(list).getByText('RM 125.50')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await within(list).findByText('Hotel')).toBeInTheDocument();
    expect(mocked.listMyClaims).toHaveBeenLastCalledWith('cursor-1', undefined);
    expect(
      screen.queryByRole('button', { name: 'Show more' }),
    ).not.toBeInTheDocument();
  });

  it('shows a safe error with a retry', async () => {
    signInAs('u-aisha');
    mocked.listMyClaims
      .mockRejectedValueOnce(
        apiError(500, 'INTERNAL_ERROR', 'Something went wrong.'),
      )
      .mockResolvedValueOnce(page([]));
    const { user } = renderApp('/claims');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong.');
    expect(alert).toHaveTextContent('Reference: req-123');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByText('You have no claims yet.'),
    ).toBeInTheDocument();
  });
});

describe('creating and editing drafts', () => {
  it('creates a draft with the amount in minor units', async () => {
    signInAs('u-aisha');
    mocked.createClaim.mockResolvedValue(claim());
    mocked.getClaim.mockResolvedValue(claim());
    const { user } = renderApp('/claims/new');

    const category = await screen.findByLabelText('Category');
    expect(
      within(category).getByRole('option', { name: 'Travel' }),
    ).toBeInTheDocument();
    expect(
      within(category).queryByRole('option', { name: /Training/ }),
    ).not.toBeInTheDocument();

    await user.selectOptions(category, 'travel');
    await user.type(screen.getByLabelText('Amount (MYR)'), '1,250.5');
    await user.type(screen.getByLabelText('Merchant'), ' Regional Airline ');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    expect(mocked.createClaim).toHaveBeenCalledWith({
      categoryId: 'travel',
      amount: { amountMinor: 125_050, currency: 'MYR' },
      merchant: 'Regional Airline',
    });
    expect(
      await screen.findByRole('heading', { name: 'City Taxi' }),
    ).toBeInTheDocument();
  });

  it('rejects a malformed amount without calling the API', async () => {
    signInAs('u-aisha');
    const { user } = renderApp('/claims/new');
    await user.type(await screen.findByLabelText('Amount (MYR)'), '12.345');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(screen.getByLabelText('Amount (MYR)')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(screen.getByText(/Enter an amount greater than zero/)).toBeVisible();
    expect(mocked.createClaim).not.toHaveBeenCalled();
  });

  it('shows server validation next to the fields', async () => {
    signInAs('u-aisha');
    mocked.createClaim.mockRejectedValue(
      apiError(400, 'VALIDATION_FAILED', 'The claim details are not valid.', [
        {
          field: 'expenseDate',
          code: 'FUTURE_DATE',
          message: 'Expense date cannot be in the future.',
        },
      ]),
    );
    const { user } = renderApp('/claims/new');
    await user.click(await screen.findByRole('button', { name: 'Save draft' }));
    expect(
      await screen.findByText('Expense date cannot be in the future.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Expense date')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  it('saves edits with the expected version and clears emptied fields', async () => {
    signInAs('u-aisha');
    mocked.getClaim.mockResolvedValue(claim({ version: 4 }));
    mocked.updateClaim.mockResolvedValue(claim({ version: 5 }));
    const { user } = renderApp('/claims/c-1/edit');

    const purpose = await screen.findByLabelText('Business purpose');
    expect(screen.getByLabelText('Amount (MYR)')).toHaveValue('125.50');
    await user.clear(purpose);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(mocked.updateClaim).toHaveBeenCalledWith('c-1', {
      expectedVersion: 4,
      categoryId: 'travel',
      amount: { amountMinor: 12_550, currency: 'MYR' },
      expenseDate: '2026-10-10',
      merchant: 'City Taxi',
      businessPurpose: null,
    });
  });

  it('explains a version conflict instead of overwriting', async () => {
    signInAs('u-aisha');
    mocked.getClaim.mockResolvedValue(claim());
    mocked.updateClaim.mockRejectedValue(
      apiError(409, 'VERSION_CONFLICT', 'Changed by someone else.'),
    );
    const { user } = renderApp('/claims/c-1/edit');
    await user.click(
      await screen.findByRole('button', { name: 'Save changes' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Someone else changed this first.',
    );

    mocked.getClaim.mockResolvedValue(claim({ merchant: 'Newer', version: 2 }));
    await user.click(
      screen.getByRole('button', { name: /load the latest version/i }),
    );
    expect(await screen.findByLabelText('Merchant')).toHaveValue('Newer');
  });

  it('keeps an inactive category selectable on an existing draft', async () => {
    signInAs('u-aisha');
    mocked.getClaim.mockResolvedValue(
      claim({ categoryId: 'training', categoryName: 'Training' }),
    );
    renderApp('/claims/c-1/edit');
    expect(
      await screen.findByRole('option', { name: 'Training (inactive)' }),
    ).toBeInTheDocument();
  });

  it('refuses to edit a claim that is no longer a draft', async () => {
    signInAs('u-aisha');
    mocked.getClaim.mockResolvedValue(
      claim({
        status: 'SUBMITTED',
        permissions: { canEdit: false, canDelete: false, actions: [] },
      }),
    );
    renderApp('/claims/c-1/edit');
    expect(
      await screen.findByText(/can no longer be edited/),
    ).toBeInTheDocument();
  });
});

describe('claim details', () => {
  it('shows details, history, and only the permitted actions', async () => {
    signInAs('u-aisha');
    mocked.getClaim.mockResolvedValue(claim());
    mocked.getHistory.mockResolvedValue(
      page([
        {
          version: 1,
          action: 'CREATE',
          toStatus: 'DRAFT',
          actor: { userId: 'u-aisha', displayName: 'Aisha Rahman' },
          occurredAt: '2026-10-14T09:00:00.000Z',
        },
      ]),
    );
    renderApp('/claims/c-1');

    expect(await screen.findByText('Created draft')).toBeInTheDocument();
    expect(screen.getByText('RM 125.50')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Edit draft' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Submit for approval' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Approve' }),
    ).not.toBeInTheDocument();
  });

  it('submits and reports policy problems from the server', async () => {
    signInAs('u-aisha');
    mocked.getClaim.mockResolvedValue(claim());
    mocked.performAction.mockRejectedValueOnce(
      apiError(400, 'VALIDATION_FAILED', 'The claim cannot be submitted yet.', [
        {
          field: 'receipt',
          code: 'RECEIPT_REQUIRED',
          message: 'A receipt is required for this amount.',
        },
      ]),
    );
    const { user } = renderApp('/claims/c-1');
    await user.click(
      await screen.findByRole('button', { name: 'Submit for approval' }),
    );
    expect(mocked.performAction).toHaveBeenCalledWith(
      'c-1',
      'SUBMIT',
      1,
      undefined,
    );
    expect(
      await screen.findByText('A receipt is required for this amount.'),
    ).toBeInTheDocument();
  });

  it('requires a manager comment before approving or rejecting', async () => {
    signInAs('u-ben');
    mocked.getClaim.mockResolvedValue(
      claim({
        status: 'UNDER_REVIEW',
        version: 3,
        permissions: {
          canEdit: false,
          canDelete: false,
          actions: ['APPROVE', 'REJECT'],
        },
      }),
    );
    mocked.performAction.mockResolvedValue(
      claim({
        status: 'REJECTED',
        version: 4,
        permissions: { canEdit: false, canDelete: false, actions: [] },
      }),
    );
    const { user } = renderApp('/claims/c-1');

    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    expect(
      screen.getByText('Add a comment explaining your decision.'),
    ).toBeInTheDocument();
    expect(mocked.performAction).not.toHaveBeenCalled();

    await user.type(
      screen.getByLabelText('Decision comment (required)'),
      'Wrong date',
    );
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    expect(mocked.performAction).toHaveBeenCalledWith(
      'c-1',
      'REJECT',
      3,
      'Wrong date',
    );
    expect(await screen.findByText('Rejected')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Approve' }),
    ).not.toBeInTheDocument();
  });

  it('shows not found for an inaccessible claim', async () => {
    signInAs('u-ravi');
    mocked.getClaim.mockRejectedValue(
      apiError(404, 'NOT_FOUND', 'Claim not found.'),
    );
    renderApp('/claims/c-1');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Claim not found.',
    );
  });
});

describe('receipts', () => {
  const pdf = () =>
    new File(['%PDF-1.7 test'], 'flight.pdf', { type: 'application/pdf' });

  it('uploads a receipt for a draft', async () => {
    signInAs('u-aisha');
    mocked.getClaim.mockResolvedValue(claim());
    mocked.attachReceiptFile.mockResolvedValue(
      claim({
        version: 2,
        receipt: {
          receiptId: 'r-1',
          fileName: 'flight.pdf',
          contentType: 'application/pdf',
          sizeBytes: 13,
          checksumSha256: 'a'.repeat(64),
          attachedAt: '2026-10-14T09:00:00.000Z',
        },
      }),
    );
    const { user } = renderApp('/claims/c-1');
    const file = pdf();
    await user.upload(await screen.findByLabelText('Upload receipt'), file);

    expect(mocked.attachReceiptFile).toHaveBeenCalledWith('c-1', 1, file);
    expect(
      await screen.findByRole('link', { name: 'flight.pdf' }),
    ).toHaveAttribute('href', '/api/v1/claims/c-1/receipt');
  });

  it('rejects unsupported files before uploading', async () => {
    signInAs('u-aisha');
    mocked.getClaim.mockResolvedValue(claim());
    renderApp('/claims/c-1');
    // Bypass the input's accept filter, as a user could with "All files".
    fireEvent.change(await screen.findByLabelText('Upload receipt'), {
      target: {
        files: [new File(['<html>'], 'page.html', { type: 'text/html' })],
      },
    });
    expect(
      screen.getByText('Choose a PDF, JPEG, or PNG file.'),
    ).toBeInTheDocument();
    expect(mocked.attachReceiptFile).not.toHaveBeenCalled();
  });

  it('removes a receipt after confirmation', async () => {
    signInAs('u-aisha');
    const withReceipt = claim({
      version: 2,
      receipt: {
        receiptId: 'r-1',
        fileName: 'flight.pdf',
        contentType: 'application/pdf',
        sizeBytes: 13,
        checksumSha256: 'a'.repeat(64),
        attachedAt: '2026-10-14T09:00:00.000Z',
      },
    });
    mocked.getClaim.mockResolvedValue(withReceipt);
    mocked.removeReceipt.mockResolvedValue(claim({ version: 3 }));
    const { user } = renderApp('/claims/c-1');

    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    expect(mocked.removeReceipt).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Confirm remove' }));
    expect(mocked.removeReceipt).toHaveBeenCalledWith('c-1', 2);
    expect(await screen.findByText('No receipt attached.')).toBeInTheDocument();
  });

  it('lets reviewers view but not change a receipt', async () => {
    signInAs('u-ben');
    mocked.getClaim.mockResolvedValue(
      claim({
        status: 'SUBMITTED',
        permissions: {
          canEdit: false,
          canDelete: false,
          actions: ['START_REVIEW'],
        },
        receipt: {
          receiptId: 'r-1',
          fileName: 'flight.pdf',
          contentType: 'application/pdf',
          sizeBytes: 13,
          checksumSha256: 'a'.repeat(64),
          attachedAt: '2026-10-14T09:00:00.000Z',
        },
      }),
    );
    renderApp('/claims/c-1');
    expect(
      await screen.findByRole('link', { name: 'flight.pdf' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Replace receipt|Remove/ }),
    ).not.toBeInTheDocument();
  });
});

describe('deleting drafts', () => {
  it('deletes a never-submitted draft after confirmation', async () => {
    signInAs('u-aisha');
    mocked.getClaim.mockResolvedValue(claim({ version: 3 }));
    mocked.deleteClaim.mockResolvedValue(undefined);
    mocked.listMyClaims.mockResolvedValue(page([]));
    const { user } = renderApp('/claims/c-1');

    await user.click(
      await screen.findByRole('button', { name: 'Delete draft' }),
    );
    expect(mocked.deleteClaim).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Confirm delete' }));

    expect(mocked.deleteClaim).toHaveBeenCalledWith('c-1', 3);
    expect(
      await screen.findByRole('heading', { name: 'My claims' }),
    ).toBeInTheDocument();
  });

  it('offers no delete for a claim that was submitted before', async () => {
    signInAs('u-aisha');
    mocked.getClaim.mockResolvedValue(
      claim({
        submittedAt: '2026-10-14T09:00:00.000Z',
        permissions: { canEdit: true, canDelete: false, actions: ['SUBMIT'] },
      }),
    );
    renderApp('/claims/c-1');
    expect(
      await screen.findByRole('button', { name: 'Submit for approval' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Delete draft' }),
    ).not.toBeInTheDocument();
  });
});
