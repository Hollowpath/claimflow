import type {
  ClaimAction,
  ClaimDto,
  ClaimStatus,
  SessionDto,
} from '@claimflow/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../src/api/claimflow';
import { claim, page, renderApp, sessionFor, travel } from './fixtures';

vi.mock('../src/api/claimflow');

const mocked = vi.mocked(api);

/**
 * A small in-memory stand-in for the server: it owns the claim, the signed-in
 * user and the permission rules, so a whole approval cycle can be driven
 * through the real screens, switching between roles as a reviewer would.
 */
function installFakeServer() {
  let signedIn: string | null = 'u-aisha';
  let current = claim({ status: 'DRAFT', version: 1 });
  const history: { action: ClaimAction; comment?: string }[] = [];

  const actionsFor = (userId: string | null): ClaimAction[] => {
    const status = current.status;
    if (userId === 'u-aisha') {
      if (status === 'DRAFT') return ['SUBMIT'];
      if (status === 'REJECTED') return ['REOPEN'];
    }
    if (userId === 'u-ben') {
      if (status === 'SUBMITTED') return ['START_REVIEW'];
      if (status === 'UNDER_REVIEW') return ['APPROVE', 'REJECT'];
    }
    if (userId === 'u-dan' && status === 'APPROVED') return ['MARK_PAID'];
    return [];
  };
  const view = (): ClaimDto => ({
    ...current,
    permissions: {
      canEdit: signedIn === 'u-aisha' && current.status === 'DRAFT',
      canDelete: signedIn === 'u-aisha' && current.status === 'DRAFT',
      actions: actionsFor(signedIn),
    },
  });
  const next: Record<ClaimAction, ClaimStatus> = {
    SUBMIT: 'SUBMITTED',
    START_REVIEW: 'UNDER_REVIEW',
    APPROVE: 'APPROVED',
    REJECT: 'REJECTED',
    REOPEN: 'DRAFT',
    MARK_PAID: 'PAID',
  };

  const ok = <T,>(value: T) => Promise.resolve(value);
  mocked.getSession.mockImplementation(() => ok(sessionFor(signedIn)));
  mocked.selectUser.mockImplementation((userId): Promise<SessionDto> => {
    signedIn = userId;
    return ok(sessionFor(userId));
  });
  mocked.signOut.mockImplementation(() => {
    signedIn = null;
    return ok(sessionFor(null));
  });
  mocked.listCategories.mockResolvedValue([travel]);
  mocked.getHistory.mockImplementation(() => ok(page([])));
  mocked.getClaim.mockImplementation(() => ok(view()));
  mocked.listMyClaims.mockImplementation(() => ok(page([view()])));
  mocked.listReviewQueue.mockImplementation(() =>
    ok(
      page(
        ['SUBMITTED', 'UNDER_REVIEW'].includes(current.status) ? [view()] : [],
      ),
    ),
  );
  mocked.listAllClaims.mockImplementation(() => ok(page([view()])));
  mocked.performAction.mockImplementation(
    (_id, action, expectedVersion, comment) => {
      if (!actionsFor(signedIn).includes(action)) {
        return Promise.reject(new Error(`${signedIn} may not ${action}`));
      }
      expect(expectedVersion).toBe(current.version);
      history.push({ action, ...(comment === undefined ? {} : { comment }) });
      current = {
        ...current,
        status: next[action],
        version: current.version + 1,
      };
      return ok(view());
    },
  );
  return { history };
}

async function switchTo(
  user: ReturnType<typeof renderApp>['user'],
  userId: string,
) {
  await user.selectOptions(
    await screen.findByLabelText('Signed in as'),
    userId,
  );
  await waitFor(() =>
    expect(screen.getByLabelText('Signed in as')).toHaveValue(userId),
  );
}

async function openClaimFromList(user: ReturnType<typeof renderApp>['user']) {
  await user.click(await screen.findByRole('link', { name: 'City Taxi' }));
  await screen.findByRole('heading', { level: 1, name: /City Taxi/ });
}

const status = (label: string) =>
  waitFor(() => expect(screen.getAllByText(label).length).toBeGreaterThan(0));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('approval cycle across roles', () => {
  it('walks one claim from draft to paid, with a rejection and a resubmission', async () => {
    const { history } = installFakeServer();
    const { user } = renderApp('/claims');

    // Employee submits the draft.
    await openClaimFromList(user);
    await user.click(
      await screen.findByRole('button', { name: 'Submit for approval' }),
    );
    expect(
      await screen.findByText('Claim submitted for approval.'),
    ).toBeVisible();
    await status('Submitted');
    expect(
      screen.queryByRole('button', { name: 'Submit for approval' }),
    ).not.toBeInTheDocument();

    // The manager starts the review, then must give a reason to reject.
    await switchTo(user, 'u-ben');
    await user.click(await screen.findByRole('link', { name: 'Review queue' }));
    await openClaimFromList(user);
    await user.click(
      await screen.findByRole('button', { name: 'Start review' }),
    );
    await status('Under review');
    await user.type(
      await screen.findByLabelText('Decision comment (required)'),
      'The receipt does not match.',
    );
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    await status('Rejected');

    // The employee reopens it and sends it again.
    await switchTo(user, 'u-aisha');
    await openClaimFromList(user);
    await user.click(
      await screen.findByRole('button', { name: 'Reopen to edit' }),
    );
    await status('Draft');
    await user.click(
      await screen.findByRole('button', { name: 'Submit for approval' }),
    );
    await status('Submitted');

    // The manager approves; the finance administrator pays.
    await switchTo(user, 'u-ben');
    await user.click(await screen.findByRole('link', { name: 'Review queue' }));
    await openClaimFromList(user);
    await user.click(
      await screen.findByRole('button', { name: 'Start review' }),
    );
    await user.type(
      await screen.findByLabelText('Decision comment (required)'),
      'Looks right.',
    );
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await status('Approved');

    await switchTo(user, 'u-dan');
    await user.click(await screen.findByRole('link', { name: 'All claims' }));
    await openClaimFromList(user);
    expect(
      screen.queryByLabelText('Decision comment (required)'),
    ).not.toBeInTheDocument();
    await user.click(
      await screen.findByRole('button', { name: 'Mark as paid' }),
    );
    await status('Paid');
    expect(await screen.findByText('Claim marked as paid.')).toBeVisible();

    expect(history.map((h) => h.action)).toEqual([
      'SUBMIT',
      'START_REVIEW',
      'REJECT',
      'REOPEN',
      'SUBMIT',
      'START_REVIEW',
      'APPROVE',
      'MARK_PAID',
    ]);
    expect(history[2]?.comment).toBe('The receipt does not match.');
    expect(history[6]?.comment).toBe('Looks right.');
    // Eight screens of user-event interaction: longer than the default budget.
  }, 40_000);

  it('shows each role only the navigation and actions it is entitled to', async () => {
    installFakeServer();
    const { user } = renderApp('/');
    const nav = () => within(screen.getByRole('navigation'));

    await screen.findByRole('navigation');
    await nav().findByRole('link', { name: 'My claims' });
    expect(nav().queryByRole('link', { name: 'Review queue' })).toBeNull();
    expect(nav().queryByRole('link', { name: 'All claims' })).toBeNull();

    await switchTo(user, 'u-chloe');
    await nav().findByRole('link', { name: 'Review queue' });
    expect(nav().queryByRole('link', { name: 'My claims' })).toBeNull();

    await switchTo(user, 'u-dan');
    await nav().findByRole('link', { name: 'Categories' });
    expect(nav().queryByRole('link', { name: 'Review queue' })).toBeNull();

    await switchTo(user, '');
    await waitFor(() => expect(screen.queryByRole('navigation')).toBeNull());
  });
});
