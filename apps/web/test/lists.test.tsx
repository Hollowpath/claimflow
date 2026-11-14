import type { ClaimDto, ClaimStatus, Page } from '@claimflow/contracts';
import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../src/api/claimflow';
import { formatAge, nextStepText } from '../src/lib/format';
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

const receipt: NonNullable<ClaimDto['receipt']> = {
  receiptId: 'r-1',
  fileName: 'taxi.pdf',
  contentType: 'application/pdf',
  sizeBytes: 2048,
  checksumSha256: 'a'.repeat(64),
  attachedAt: '2026-10-14T09:30:00.000Z',
};

const ben = { userId: 'u-ben', displayName: 'Ben Tan' };

beforeEach(() => {
  mocked.listCategories.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('next step and age text', () => {
  it.each<[ClaimStatus, string]>([
    ['DRAFT', 'Complete the details and submit'],
    ['SUBMITTED', 'Waiting for Ben Tan to start the review'],
    ['UNDER_REVIEW', 'Being reviewed by Ben Tan'],
    ['APPROVED', 'Waiting for payment'],
    ['REJECTED', 'Reopen to edit and resubmit'],
    ['PAID', 'Nothing further'],
  ])('says what happens next for %s', (status, expected) => {
    expect(nextStepText({ status, assignedManager: ben })).toBe(expected);
  });

  it('does not invent a manager when none is assigned', () => {
    expect(nextStepText({ status: 'SUBMITTED' })).toBe(
      'Waiting for the manager to start the review',
    );
  });

  it('counts whole days', () => {
    const now = Date.parse('2026-10-20T12:00:00.000Z');
    expect(formatAge('2026-10-20T01:00:00.000Z', now)).toBe('Today');
    expect(formatAge('2026-10-19T09:00:00.000Z', now)).toBe('1 day ago');
    expect(formatAge('2026-10-15T09:00:00.000Z', now)).toBe('5 days ago');
    expect(formatAge('2026-10-21T09:00:00.000Z', now)).toBe('Today');
  });
});

describe('My claims', () => {
  it('puts New claim in the page header, not the navigation', async () => {
    mocked.getSession.mockResolvedValue(sessionFor('u-aisha'));
    mocked.listMyClaims.mockResolvedValue(page([]));
    renderApp('/claims');
    await screen.findByRole('heading', { level: 1, name: 'My claims' });
    const links = screen.getAllByRole('link', { name: 'New claim' });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/claims/new');
    expect(
      within(screen.getByRole('navigation', { name: 'Main' })).queryByRole(
        'link',
        { name: 'New claim' },
      ),
    ).toBeNull();
  });

  it('shows what each claim needs next, in a labelled, scrollable table', async () => {
    mocked.getSession.mockResolvedValue(sessionFor('u-aisha'));
    mocked.listMyClaims.mockResolvedValue(
      page([
        claim({
          status: 'SUBMITTED',
          assignedManager: ben,
          submittedAt: '2026-10-14T09:00:00.000Z',
        }),
        claim({
          claimId: 'c-2',
          merchant: undefined as never,
          amount: undefined as never,
          categoryName: undefined as never,
          expenseDate: undefined as never,
        }),
      ]),
    );
    renderApp('/claims');
    const region = await screen.findByRole('region', {
      name: 'My claims (scrollable)',
    });
    expect(region).toHaveAttribute('tabindex', '0');
    const table = within(region).getByRole('table', { name: 'My claims' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual([
      'Merchant',
      'Category',
      'Expense date',
      'Amount',
      'Status',
      'Next step',
    ]);

    const row = within(table).getByRole('row', { name: /City Taxi/ });
    expect(
      within(row).getByRole('rowheader', { name: 'City Taxi' }),
    ).toBeInTheDocument();
    expect(
      within(row).getByRole('link', { name: 'City Taxi' }),
    ).toHaveAttribute('href', '/claims/c-1');
    expect(within(row).getByText('Travel')).toBeInTheDocument();
    expect(within(row).getByText('10 Oct 2026')).toBeInTheDocument();
    expect(within(row).getByText('RM 125.50')).toBeInTheDocument();
    expect(within(row).getByText('Submitted')).toBeInTheDocument();
    expect(
      within(row).getByText('Waiting for Ben Tan to start the review'),
    ).toBeInTheDocument();

    const untitled = within(table).getByRole('row', { name: /Untitled claim/ });
    expect(within(untitled).getAllByText('—')).toHaveLength(3);
  });

  it('keeps the cursor-based Show more and reports a failed page without losing the list', async () => {
    mocked.getSession.mockResolvedValue(sessionFor('u-aisha'));
    mocked.listMyClaims
      .mockResolvedValueOnce(page([claim()], 'cursor-1'))
      .mockRejectedValueOnce(
        apiError(500, 'INTERNAL_ERROR', 'Something went wrong.'),
      )
      .mockResolvedValueOnce(
        page([claim({ claimId: 'c-2', merchant: 'Hotel' })]),
      );
    const { user } = renderApp('/claims');
    await screen.findByRole('table', { name: 'My claims' });

    await user.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong.',
    );
    expect(screen.getByText('City Taxi')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('Hotel')).toBeInTheDocument();
    expect(mocked.listMyClaims).toHaveBeenLastCalledWith('cursor-1', undefined);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('Review queue', () => {
  it('shows who sent each claim, how long ago, and whether a receipt is attached', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z'));
    mocked.getSession.mockResolvedValue(sessionFor('u-chloe'));
    mocked.listReviewQueue.mockResolvedValue(
      page([
        claim({
          claimId: 'c-1',
          status: 'SUBMITTED',
          submittedAt: '2026-10-15T09:00:00.000Z',
          receipt,
        }),
        claim({
          claimId: 'c-2',
          merchant: 'Hotel',
          status: 'UNDER_REVIEW',
          submittedAt: '2026-10-20T08:00:00.000Z',
        }),
      ]),
    );
    renderApp('/review');

    expect(
      await screen.findByText(
        'Claims assigned to you that are waiting for or under review, oldest first.',
      ),
    ).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Review queue' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual([
      'Merchant',
      'Employee',
      'Category',
      'Amount',
      'Submitted',
      'Receipt',
      'Status',
    ]);
    const first = within(table).getByRole('row', { name: /City Taxi/ });
    expect(within(first).getByText('Aisha Rahman')).toBeInTheDocument();
    expect(within(first).getByText('Attached')).toBeInTheDocument();
    expect(within(first).getByText('5 days ago')).toBeInTheDocument();
    const second = within(table).getByRole('row', { name: /Hotel/ });
    expect(within(second).getByText('None')).toBeInTheDocument();
    expect(within(second).getByText('Today')).toBeInTheDocument();
    expect(within(second).getByText('Under review')).toBeInTheDocument();
  });

  it('keeps the empty state', async () => {
    mocked.getSession.mockResolvedValue(sessionFor('u-chloe'));
    mocked.listReviewQueue.mockResolvedValue(page([]));
    renderApp('/review');
    expect(
      await screen.findByText('Nothing to review right now.'),
    ).toBeInTheDocument();
  });
});

describe('All claims', () => {
  it('shows the reviewer and every status as a labelled filter', async () => {
    mocked.getSession.mockResolvedValue(sessionFor('u-dan'));
    mocked.listAllClaims.mockResolvedValue(
      page([claim({ status: 'APPROVED', assignedManager: ben })]),
    );
    renderApp('/admin/claims');
    const table = await screen.findByRole('table', { name: 'All claims' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual([
      'Merchant',
      'Employee',
      'Category',
      'Expense date',
      'Amount',
      'Reviewer',
      'Status',
    ]);
    expect(within(table).getByText('Ben Tan')).toBeInTheDocument();

    const filter = screen.getByLabelText('Status');
    expect(filter.tagName).toBe('SELECT');
    expect(
      within(filter)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([
      'All statuses',
      'Draft',
      'Submitted',
      'Under review',
      'Approved',
      'Rejected',
      'Paid',
    ]);
  });

  it('starts from the status in the address and ignores an unknown one', async () => {
    mocked.getSession.mockResolvedValue(sessionFor('u-dan'));
    mocked.listAllClaims.mockResolvedValue(page([]));
    renderApp('/admin/claims?status=APPROVED');
    expect(await screen.findByLabelText('Status')).toHaveValue('APPROVED');
    expect(mocked.listAllClaims).toHaveBeenCalledWith(
      'APPROVED',
      undefined,
      expect.any(AbortSignal),
    );
    expect(await screen.findByText('No approved claims.')).toBeInTheDocument();
  });

  it('treats an unknown status as all claims and returns to all on request', async () => {
    mocked.getSession.mockResolvedValue(sessionFor('u-dan'));
    mocked.listAllClaims.mockResolvedValue(page([]));
    const { user } = renderApp('/admin/claims?status=BOGUS');
    expect(await screen.findByLabelText('Status')).toHaveValue('');
    expect(
      await screen.findByText('There are no claims yet.'),
    ).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Status'), 'REJECTED');
    expect(await screen.findByText('No rejected claims.')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Status'), '');
    expect(mocked.listAllClaims).toHaveBeenLastCalledWith(
      undefined,
      undefined,
      expect.any(AbortSignal),
    );
  });

  it('drops a slow response that arrives after the filter changed', async () => {
    mocked.getSession.mockResolvedValue(sessionFor('u-dan'));
    const slow = deferred<Page<ClaimDto>>();
    mocked.listAllClaims.mockImplementation((status) =>
      status === undefined
        ? slow.promise
        : Promise.resolve(
            page([claim({ merchant: 'Paid trip', status: 'PAID' })]),
          ),
    );
    const { user } = renderApp('/admin/claims');
    expect(await screen.findByText('Loading claims…')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Status'), 'PAID');
    expect(await screen.findByText('Paid trip')).toBeInTheDocument();

    slow.release(page([claim({ claimId: 'c-9', merchant: 'Late response' })]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText('Late response')).toBeNull();
    expect(screen.getByText('Paid trip')).toBeInTheDocument();
  });
});
