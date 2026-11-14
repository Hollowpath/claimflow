import type { ClaimHistoryEntryDto } from '@claimflow/contracts';
import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../src/api/claimflow';
import { apiError, claim, page, renderApp, sessionFor } from './fixtures';

vi.mock('../src/api/claimflow');

const mocked = vi.mocked(api);

const aisha = { userId: 'u-aisha', displayName: 'Aisha Rahman' };
const ben = { userId: 'u-ben', displayName: 'Ben Tan' };

function entry(
  overrides: Partial<ClaimHistoryEntryDto> &
    Pick<ClaimHistoryEntryDto, 'version'>,
): ClaimHistoryEntryDto {
  return {
    action: 'CREATE',
    toStatus: 'DRAFT',
    actor: aisha,
    occurredAt: '2026-10-14T09:00:00.000Z',
    ...overrides,
  };
}

const noActions = { canEdit: false, canDelete: false, actions: [] as never[] };

beforeEach(() => {
  mocked.listCategories.mockResolvedValue([]);
  mocked.getHistory.mockResolvedValue(page([]));
  mocked.receiptUrl.mockReturnValue('/api/v1/claims/c-1/receipt');
  mocked.getSession.mockResolvedValue(sessionFor('u-aisha'));
});

function headingTexts() {
  return screen
    .getAllByRole('heading', { level: 2 })
    .map((heading) => heading.textContent);
}

describe('claim detail header', () => {
  it('shows the merchant as the page title with status and who has the next move', async () => {
    mocked.getClaim.mockResolvedValue(
      claim({
        status: 'SUBMITTED',
        assignedManager: ben,
        permissions: noActions,
      }),
    );
    renderApp('/claims/c-1');
    const title = await screen.findByRole('heading', {
      level: 1,
      name: 'City Taxi',
    });
    expect(title).toBeInTheDocument();
    expect(screen.getByText('Submitted')).toBeInTheDocument();
    expect(
      screen.getByText('Your claim · Waiting for Ben Tan to start the review'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/version/i)).toBeNull();
  });

  it('names the employee when someone else is looking at the claim', async () => {
    mocked.getSession.mockResolvedValue(sessionFor('u-ben'));
    mocked.getClaim.mockResolvedValue(
      claim({
        status: 'UNDER_REVIEW',
        assignedManager: ben,
        permissions: noActions,
      }),
    );
    renderApp('/claims/c-1');
    expect(
      await screen.findByText(
        'Claim by Aisha Rahman · Being reviewed by Ben Tan',
      ),
    ).toBeInTheDocument();
  });

  it('titles a claim without a merchant', async () => {
    mocked.getClaim.mockResolvedValue(
      claim({ merchant: undefined as never, permissions: noActions }),
    );
    renderApp('/claims/c-1');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Untitled claim' }),
    ).toBeInTheDocument();
  });

  it('offers Edit draft in the header only when the server allows editing', async () => {
    mocked.getClaim.mockResolvedValue(claim());
    renderApp('/claims/c-1');
    expect(
      await screen.findByRole('link', { name: 'Edit draft' }),
    ).toHaveAttribute('href', '/claims/c-1/edit');
  });

  it('offers no edit link for a claim that cannot be edited', async () => {
    mocked.getClaim.mockResolvedValue(
      claim({ status: 'SUBMITTED', permissions: noActions }),
    );
    renderApp('/claims/c-1');
    await screen.findByRole('heading', { level: 1, name: 'City Taxi' });
    expect(screen.queryByRole('link', { name: 'Edit draft' })).toBeNull();
  });
});

describe('claim detail layout and reading order', () => {
  it('orders sections details, receipt, next step, delete, then history', async () => {
    mocked.getClaim.mockResolvedValue(claim());
    renderApp('/claims/c-1');
    await screen.findByRole('region', { name: 'History' });
    expect(headingTexts()).toEqual([
      'Details',
      'Receipt',
      'Next step',
      'Delete draft',
      'History',
    ]);
  });

  it('has no next-step column content when nothing can be done', async () => {
    mocked.getClaim.mockResolvedValue(
      claim({ status: 'PAID', permissions: noActions }),
    );
    renderApp('/claims/c-1');
    await screen.findByRole('region', { name: 'History' });
    expect(headingTexts()).toEqual(['Details', 'Receipt', 'History']);
  });

  it('labels each section as a region', async () => {
    mocked.getClaim.mockResolvedValue(claim());
    renderApp('/claims/c-1');
    for (const name of ['Details', 'Receipt', 'History']) {
      expect(await screen.findByRole('region', { name })).toBeInTheDocument();
    }
  });
});

describe('claim details', () => {
  it('lists every fact as a term and its value', async () => {
    mocked.getClaim.mockResolvedValue(
      claim({
        status: 'APPROVED',
        assignedManager: ben,
        submittedAt: '2026-10-14T10:00:00.000Z',
        reviewedAt: '2026-10-15T11:30:00.000Z',
        permissions: noActions,
      }),
    );
    renderApp('/claims/c-1');
    const details = await screen.findByRole('region', { name: 'Details' });
    const terms = within(details)
      .getAllByRole('term')
      .map((term) => term.textContent);
    expect(terms).toEqual([
      'Amount',
      'Category',
      'Expense date',
      'Merchant',
      'Business purpose',
      'Employee',
      'Reviewer',
      'Submitted',
      'Decided',
    ]);
    const values = within(details)
      .getAllByRole('definition')
      .map((value) => value.textContent?.replace(/\s+/g, ' '));
    expect(values.slice(0, 7)).toEqual([
      'RM 125.50',
      'Travel',
      '10 Oct 2026',
      'City Taxi',
      'Client visit',
      'Aisha Rahman',
      'Ben Tan',
    ]);
  });

  it('shows a dash for missing facts and explains an unassigned reviewer', async () => {
    mocked.getClaim.mockResolvedValue(
      claim({
        amount: undefined as never,
        categoryName: undefined as never,
        expenseDate: undefined as never,
        businessPurpose: undefined as never,
        permissions: noActions,
      }),
    );
    renderApp('/claims/c-1');
    const details = await screen.findByRole('region', { name: 'Details' });
    const values = within(details)
      .getAllByRole('definition')
      .map((value) => value.textContent);
    expect(values).toEqual([
      '—',
      '—',
      '—',
      'City Taxi',
      '—',
      'Aisha Rahman',
      'Assigned on submission',
    ]);
  });
});

describe('claim history', () => {
  it('shows each accepted change as a row in a table, oldest first', async () => {
    mocked.getClaim.mockResolvedValue(
      claim({ status: 'APPROVED', permissions: noActions }),
    );
    mocked.getHistory.mockResolvedValue(
      page([
        entry({ version: 1 }),
        entry({
          version: 2,
          action: 'SUBMIT',
          fromStatus: 'DRAFT',
          toStatus: 'SUBMITTED',
          occurredAt: '2026-10-14T10:00:00.000Z',
        }),
        entry({
          version: 3,
          action: 'APPROVE',
          fromStatus: 'UNDER_REVIEW',
          toStatus: 'APPROVED',
          actor: ben,
          comment: 'Within the Travel limit.',
          occurredAt: '2026-10-15T11:30:00.000Z',
        }),
      ]),
    );
    renderApp('/claims/c-1');
    const table = await screen.findByRole('table', { name: 'Claim history' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['When', 'Who', 'Action', 'Status change', 'Comment']);

    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('Created draft')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Submitted')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Draft → Submitted')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Ben Tan')).toBeInTheDocument();
    expect(
      within(rows[2]!).getByText('Under review → Approved'),
    ).toBeInTheDocument();
    expect(
      within(rows[2]!).getByText('Within the Travel limit.'),
    ).toBeInTheDocument();
  });

  it('collects every page of history', async () => {
    mocked.getClaim.mockResolvedValue(claim({ permissions: noActions }));
    mocked.getHistory
      .mockResolvedValueOnce(page([entry({ version: 1 })], 'h-2'))
      .mockResolvedValueOnce(
        page([entry({ version: 2, action: 'UPDATE', toStatus: 'DRAFT' })]),
      );
    renderApp('/claims/c-1');
    expect(await screen.findByText('Edited draft')).toBeInTheDocument();
    expect(screen.getByText('Created draft')).toBeInTheDocument();
    expect(mocked.getHistory).toHaveBeenLastCalledWith(
      'c-1',
      'h-2',
      expect.any(AbortSignal),
    );
  });

  it('says so when nothing has been recorded', async () => {
    mocked.getClaim.mockResolvedValue(claim({ permissions: noActions }));
    renderApp('/claims/c-1');
    expect(
      await screen.findByText('No history has been recorded yet.'),
    ).toBeInTheDocument();
  });

  it('shows a loading state, then recovers from a failed load', async () => {
    mocked.getClaim.mockResolvedValue(claim({ permissions: noActions }));
    mocked.getHistory
      .mockRejectedValueOnce(
        apiError(500, 'INTERNAL_ERROR', 'History is unavailable.'),
      )
      .mockResolvedValueOnce(page([entry({ version: 1 })]));
    const { user } = renderApp('/claims/c-1');
    const section = await screen.findByRole('region', { name: 'History' });
    expect(await within(section).findByRole('alert')).toHaveTextContent(
      'History is unavailable.',
    );
    await user.click(
      within(section).getByRole('button', { name: 'Try again' }),
    );
    expect(
      await within(section).findByText('Created draft'),
    ).toBeInTheDocument();
  });

  it('reloads the history after an action changes the claim', async () => {
    mocked.getClaim.mockResolvedValue(claim());
    mocked.performAction.mockResolvedValue(
      claim({ status: 'SUBMITTED', version: 2, permissions: noActions }),
    );
    const { user } = renderApp('/claims/c-1');
    await user.click(
      await screen.findByRole('button', { name: 'Submit for approval' }),
    );
    await screen.findByText('Submitted');
    await vi.waitFor(() => expect(mocked.getHistory).toHaveBeenCalledTimes(2));
  });
});

describe('rejection reason', () => {
  const rejected = claim({
    status: 'REJECTED',
    version: 4,
    permissions: noActions,
  });

  it('shows who rejected the claim and why, as a polite status', async () => {
    mocked.getClaim.mockResolvedValue(rejected);
    mocked.getHistory.mockResolvedValue(
      page([
        entry({ version: 1 }),
        entry({
          version: 3,
          action: 'REJECT',
          fromStatus: 'UNDER_REVIEW',
          toStatus: 'REJECTED',
          actor: ben,
          comment: 'Receipt does not match the amount.',
        }),
      ]),
    );
    renderApp('/claims/c-1');
    const notice = (await screen.findByText(/Rejected by Ben Tan/)).closest(
      '[role="status"]',
    );
    expect(notice).toHaveTextContent(
      'Rejected by Ben Tan: Receipt does not match the amount.',
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('uses the latest rejection', async () => {
    mocked.getClaim.mockResolvedValue(rejected);
    mocked.getHistory.mockResolvedValue(
      page([
        entry({
          version: 2,
          action: 'REJECT',
          toStatus: 'REJECTED',
          actor: ben,
          comment: 'First reason.',
        }),
        entry({ version: 3, action: 'REOPEN', toStatus: 'DRAFT' }),
        entry({
          version: 4,
          action: 'REJECT',
          toStatus: 'REJECTED',
          actor: ben,
          comment: 'Second reason.',
        }),
      ]),
    );
    renderApp('/claims/c-1');
    const notice = (await screen.findByText(/Rejected by Ben Tan/)).closest(
      '[role="status"]',
    );
    expect(notice).toHaveTextContent('Rejected by Ben Tan: Second reason.');
    expect(notice).not.toHaveTextContent('First reason.');
  });

  it('is not shown once the claim is no longer rejected', async () => {
    mocked.getClaim.mockResolvedValue(claim({ permissions: noActions }));
    mocked.getHistory.mockResolvedValue(
      page([
        entry({
          version: 2,
          action: 'REJECT',
          toStatus: 'REJECTED',
          actor: ben,
          comment: 'Old reason.',
        }),
        entry({ version: 3, action: 'REOPEN', toStatus: 'DRAFT' }),
      ]),
    );
    renderApp('/claims/c-1');
    await screen.findByRole('table', { name: 'Claim history' });
    expect(screen.queryByRole('status')).toBeNull();
  });
});
