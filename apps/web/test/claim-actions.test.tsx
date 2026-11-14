import type { ClaimAction, ClaimDto } from '@claimflow/contracts';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../src/api/claimflow';
import { App } from '../src/app';
import { actionLabels } from '../src/lib/format';
import {
  apiError,
  claim,
  deferred,
  page,
  sessionFor,
  travel,
} from './fixtures';

vi.mock('../src/api/claimflow');

const mocked = vi.mocked(api);

const none = { canEdit: false, canDelete: false, actions: [] as ClaimAction[] };
const can = (...actions: ClaimAction[]) => ({
  canEdit: false,
  canDelete: false,
  actions,
});

function renderAt(path: string) {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
  return user;
}

const headings = () =>
  screen
    .getAllByRole('heading', { level: 2 })
    .map((heading) => heading.textContent);

beforeEach(() => {
  mocked.getSession.mockResolvedValue(sessionFor('u-ben'));
  mocked.listCategories.mockResolvedValue([travel]);
  mocked.getHistory.mockResolvedValue(page([]));
});

describe('lifecycle actions', () => {
  it.each<[ClaimAction, ClaimDto['status'], ClaimDto['status'], string]>([
    ['SUBMIT', 'DRAFT', 'SUBMITTED', 'Claim submitted for approval.'],
    ['START_REVIEW', 'SUBMITTED', 'UNDER_REVIEW', 'Review started.'],
    ['REOPEN', 'REJECTED', 'DRAFT', 'Claim reopened for editing.'],
    ['MARK_PAID', 'APPROVED', 'PAID', 'Claim marked as paid.'],
  ])(
    '%s sends the claim version with no comment, updates the page, and confirms',
    async (action, from, to, message) => {
      mocked.getClaim.mockResolvedValue(
        claim({ status: from, version: 3, permissions: can(action) }),
      );
      mocked.performAction.mockResolvedValue(
        claim({ status: to, version: 4, permissions: none }),
      );
      const user = renderAt('/claims/c-1');
      await user.click(
        await screen.findByRole('button', { name: actionLabels[action] }),
      );

      expect(mocked.performAction).toHaveBeenCalledWith(
        'c-1',
        action,
        3,
        undefined,
      );
      expect(await screen.findByText(message)).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: actionLabels[action] }),
      ).not.toBeInTheDocument();
    },
  );

  it('moves keyboard focus to the claim title once the used button is gone', async () => {
    mocked.getClaim.mockResolvedValue(
      claim({ status: 'SUBMITTED', permissions: can('START_REVIEW') }),
    );
    mocked.performAction.mockResolvedValue(
      claim({ status: 'UNDER_REVIEW', permissions: none }),
    );
    const user = renderAt('/claims/c-1');
    await user.click(
      await screen.findByRole('button', { name: 'Start review' }),
    );
    await screen.findByText('Review started.');
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1 })).toHaveFocus(),
    );
  });

  it('has no comment field when nothing needs a decision', async () => {
    mocked.getClaim.mockResolvedValue(
      claim({ status: 'SUBMITTED', permissions: can('START_REVIEW') }),
    );
    renderAt('/claims/c-1');
    await screen.findByRole('button', { name: 'Start review' });
    expect(
      screen.queryByLabelText('Decision comment (required)'),
    ).not.toBeInTheDocument();
    expect(headings()).toContain('Next step');
  });

  it('disables every action and shows progress on the one running, once only', async () => {
    mocked.getClaim.mockResolvedValue(
      claim({ status: 'UNDER_REVIEW', permissions: can('APPROVE', 'REJECT') }),
    );
    const pending = deferred<ClaimDto>();
    mocked.performAction.mockReturnValue(pending.promise);
    const user = renderAt('/claims/c-1');
    await user.type(
      await screen.findByLabelText('Decision comment (required)'),
      'Fine',
    );
    await user.click(screen.getByRole('button', { name: 'Approve' }));

    expect(screen.getByRole('button', { name: 'Working…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled();
    // A disabled button ignores clicks; user-event refuses to click it at all.
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(mocked.performAction).toHaveBeenCalledTimes(1);

    pending.release(claim({ status: 'APPROVED', permissions: none }));
    expect(await screen.findByText('Claim approved.')).toBeInTheDocument();
  });

  it('keeps the page and the typed comment when the server refuses, and re-enables the buttons', async () => {
    mocked.getClaim.mockResolvedValue(
      claim({ status: 'UNDER_REVIEW', permissions: can('APPROVE', 'REJECT') }),
    );
    mocked.performAction.mockRejectedValue(
      apiError(409, 'INVALID_TRANSITION', 'This claim cannot be approved now.'),
    );
    const user = renderAt('/claims/c-1');
    const comment = await screen.findByLabelText('Decision comment (required)');
    await user.type(comment, 'Looks good');
    await user.click(screen.getByRole('button', { name: 'Approve' }));

    const section = screen.getByRole('region', { name: 'Decision' });
    expect(await within(section).findByRole('alert')).toHaveTextContent(
      'This claim cannot be approved now.',
    );
    expect(comment).toHaveValue('Looks good');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
    expect(screen.queryByText('Claim approved.')).not.toBeInTheDocument();
  });

  it('offers the latest version after a version conflict', async () => {
    mocked.getClaim.mockResolvedValue(
      claim({ status: 'SUBMITTED', permissions: can('START_REVIEW') }),
    );
    mocked.performAction.mockRejectedValue(
      apiError(409, 'VERSION_CONFLICT', 'Changed by someone else.'),
    );
    const user = renderAt('/claims/c-1');
    await user.click(
      await screen.findByRole('button', { name: 'Start review' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Someone else changed this first.',
    );
    mocked.getClaim.mockResolvedValue(
      claim({ status: 'UNDER_REVIEW', version: 2, permissions: none }),
    );
    await user.click(
      screen.getByRole('button', { name: 'Load the latest version' }),
    );
    expect(await screen.findByText('Under review')).toBeInTheDocument();
    expect(mocked.getClaim).toHaveBeenCalledTimes(2);
  });
});

describe('manager decisions', () => {
  const underReview = () =>
    claim({
      status: 'UNDER_REVIEW',
      version: 3,
      permissions: can('APPROVE', 'REJECT'),
    });

  it('is titled Decision and placed after the receipt and before the history', async () => {
    mocked.getClaim.mockResolvedValue(underReview());
    renderAt('/claims/c-1');
    await screen.findByRole('region', { name: 'Decision' });
    expect(headings()).toEqual(['Details', 'Receipt', 'Decision', 'History']);
  });

  it('requires a comment, explains why, and moves focus to the comment', async () => {
    mocked.getClaim.mockResolvedValue(underReview());
    const user = renderAt('/claims/c-1');
    const comment = await screen.findByLabelText('Decision comment (required)');

    await user.click(screen.getByRole('button', { name: 'Reject' }));
    expect(comment).toHaveFocus();
    expect(comment).toHaveAttribute('aria-invalid', 'true');
    expect(comment).toHaveAccessibleDescription(
      /Add a comment explaining your decision\./,
    );
    expect(mocked.performAction).not.toHaveBeenCalled();

    // A comment of only spaces does not count.
    await user.type(comment, '   ');
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(mocked.performAction).not.toHaveBeenCalled();
  });

  it('approves with the comment and the claim version', async () => {
    mocked.getClaim.mockResolvedValue(underReview());
    mocked.performAction.mockResolvedValue(
      claim({ status: 'APPROVED', version: 4, permissions: none }),
    );
    const user = renderAt('/claims/c-1');
    await user.type(
      await screen.findByLabelText('Decision comment (required)'),
      'Within the Travel limit.',
    );
    await user.click(screen.getByRole('button', { name: 'Approve' }));

    expect(mocked.performAction).toHaveBeenCalledWith(
      'c-1',
      'APPROVE',
      3,
      'Within the Travel limit.',
    );
    expect(await screen.findByText('Claim approved.')).toBeInTheDocument();
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Decision' })).toBeNull();
  });

  it('rejects with the comment and the claim version', async () => {
    mocked.getClaim.mockResolvedValue(underReview());
    mocked.performAction.mockResolvedValue(
      claim({ status: 'REJECTED', version: 4, permissions: none }),
    );
    const user = renderAt('/claims/c-1');
    await user.type(
      await screen.findByLabelText('Decision comment (required)'),
      'Wrong date',
    );
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    expect(mocked.performAction).toHaveBeenCalledWith(
      'c-1',
      'REJECT',
      3,
      'Wrong date',
    );
    expect(await screen.findByText('Claim rejected.')).toBeInTheDocument();
  });

  it('is reachable by keyboard in reading order: comment, Approve, Reject', async () => {
    mocked.getClaim.mockResolvedValue(underReview());
    const user = renderAt('/claims/c-1');
    const comment = await screen.findByLabelText('Decision comment (required)');
    await user.click(comment);
    expect(comment).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Approve' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Reject' })).toHaveFocus();
  });

  it('lets a reviewer see the claim evidence but never the owner’s edit controls', async () => {
    mocked.getClaim.mockResolvedValue(underReview());
    renderAt('/claims/c-1');
    await screen.findByRole('region', { name: 'Decision' });
    expect(screen.queryByRole('link', { name: 'Edit draft' })).toBeNull();
    expect(screen.queryByLabelText('Upload receipt')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete draft' })).toBeNull();
  });
});

describe('confirmation messages', () => {
  it('is a polite status that stays until dismissed and does not take focus', async () => {
    mocked.getClaim.mockResolvedValue(
      claim({ status: 'SUBMITTED', permissions: can('START_REVIEW') }),
    );
    mocked.performAction.mockResolvedValue(
      claim({ status: 'UNDER_REVIEW', permissions: none }),
    );
    const user = renderAt('/claims/c-1');
    await user.click(
      await screen.findByRole('button', { name: 'Start review' }),
    );
    const toast = (await screen.findByText('Review started.')).closest(
      '[role="status"]',
    );
    expect(toast).not.toBeNull();
    expect(toast).not.toHaveFocus();
    expect(screen.queryByRole('alert')).toBeNull();

    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByText('Review started.')).not.toBeInTheDocument(),
    );
  });
});

describe('deleting a draft', () => {
  const draft = () =>
    claim({
      version: 3,
      permissions: { canEdit: true, canDelete: true, actions: ['SUBMIT'] },
    });

  it('asks in an alert dialog that names the draft and what is lost, focused on Cancel', async () => {
    mocked.getClaim.mockResolvedValue(draft());
    const user = renderAt('/claims/c-1');
    await user.click(
      await screen.findByRole('button', { name: 'Delete draft' }),
    );

    const dialog = await screen.findByRole('alertdialog', {
      name: 'Delete this draft?',
    });
    expect(dialog).toHaveAccessibleDescription(
      /City Taxi.*receipt.*history.*cannot be undone/,
    );
    expect(
      within(dialog).getByRole('button', { name: 'Cancel' }),
    ).toHaveFocus();
    expect(mocked.deleteClaim).not.toHaveBeenCalled();
  });

  it.each([
    [
      'Cancel',
      (user: ReturnType<typeof userEvent.setup>) =>
        user.click(screen.getByRole('button', { name: 'Cancel' })),
    ],
    [
      'Escape',
      (user: ReturnType<typeof userEvent.setup>) => user.keyboard('{Escape}'),
    ],
  ])(
    '%s keeps the draft and returns focus to Delete draft',
    async (_name, dismiss) => {
      mocked.getClaim.mockResolvedValue(draft());
      const user = renderAt('/claims/c-1');
      const trigger = await screen.findByRole('button', {
        name: 'Delete draft',
      });
      await user.click(trigger);
      await screen.findByRole('alertdialog');
      await dismiss(user);

      await waitFor(() =>
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument(),
      );
      await waitFor(() => expect(trigger).toHaveFocus());
      expect(mocked.deleteClaim).not.toHaveBeenCalled();
    },
  );

  it('deletes with the claim version, shows progress, and leaves for My claims', async () => {
    mocked.getClaim.mockResolvedValue(draft());
    const pending = deferred<undefined>();
    mocked.deleteClaim.mockReturnValue(pending.promise);
    mocked.getSession.mockResolvedValue(sessionFor('u-aisha'));
    mocked.listMyClaims.mockResolvedValue(page([]));
    const user = renderAt('/claims/c-1');
    await user.click(
      await screen.findByRole('button', { name: 'Delete draft' }),
    );
    const dialog = await screen.findByRole('alertdialog');
    await user.click(
      within(dialog).getByRole('button', { name: 'Delete draft' }),
    );

    expect(mocked.deleteClaim).toHaveBeenCalledWith('c-1', 3);
    expect(
      within(dialog).getByRole('button', { name: 'Deleting…' }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole('button', { name: 'Cancel' }),
    ).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();

    pending.release(undefined);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'My claims' }),
    ).toBeInTheDocument();
  });

  it('stays open with the error when deleting fails, and can be retried', async () => {
    mocked.getClaim.mockResolvedValue(draft());
    mocked.deleteClaim.mockRejectedValueOnce(
      apiError(500, 'INTERNAL_ERROR', 'Could not delete the draft.'),
    );
    const user = renderAt('/claims/c-1');
    await user.click(
      await screen.findByRole('button', { name: 'Delete draft' }),
    );
    const dialog = await screen.findByRole('alertdialog');
    await user.click(
      within(dialog).getByRole('button', { name: 'Delete draft' }),
    );

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Could not delete the draft.',
    );
    expect(
      within(dialog).getByRole('button', { name: 'Delete draft' }),
    ).toBeEnabled();
    expect(
      within(dialog).getByRole('button', { name: 'Cancel' }),
    ).toBeEnabled();
  });

  it('offers the latest version after a conflict and reloads the claim', async () => {
    mocked.getClaim.mockResolvedValue(draft());
    mocked.deleteClaim.mockRejectedValue(
      apiError(409, 'VERSION_CONFLICT', 'Changed by someone else.'),
    );
    const user = renderAt('/claims/c-1');
    await user.click(
      await screen.findByRole('button', { name: 'Delete draft' }),
    );
    const dialog = await screen.findByRole('alertdialog');
    await user.click(
      within(dialog).getByRole('button', { name: 'Delete draft' }),
    );
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Someone else changed this first.',
    );

    await user.click(
      within(dialog).getByRole('button', { name: 'Load the latest version' }),
    );
    await waitFor(() => expect(mocked.getClaim).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument(),
    );
  });

  it('is not offered once the claim has been submitted', async () => {
    mocked.getClaim.mockResolvedValue(
      claim({
        submittedAt: '2026-10-14T09:00:00.000Z',
        permissions: { canEdit: true, canDelete: false, actions: ['SUBMIT'] },
      }),
    );
    renderAt('/claims/c-1');
    await screen.findByRole('button', { name: 'Submit for approval' });
    expect(screen.queryByRole('region', { name: 'Delete draft' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete draft' })).toBeNull();
  });
});
