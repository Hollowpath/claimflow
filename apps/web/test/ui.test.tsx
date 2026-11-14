import type { ClaimStatus } from '@claimflow/contracts';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { Link, MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../src/api/client';
import { statusLabels } from '../src/lib/format';
import { DataTable, RowHeader } from '../src/ui/data-table';
import { ConfirmDialog } from '../src/ui/confirm-dialog';
import { EmptyState, ErrorAlert, Loading } from '../src/ui/feedback';
import { Field, FileButton, SelectField } from '../src/ui/fields';
import { MainNav, NavItem, SkipLink } from '../src/ui/navigation';
import { PageHeader } from '../src/ui/page-header';
import { AppProviders } from '../src/ui/providers';
import { StatusChip } from '../src/ui/status-chip';
import { theme } from '../src/ui/theme';
import { useToast } from '../src/ui/toast';

function renderUi(ui: ReactNode, path = '/') {
  const user = userEvent.setup();
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders>{ui}</AppProviders>
    </MemoryRouter>,
  );
  return { user, ...view };
}

describe('theme', () => {
  it('uses system fonts only and defines both colour schemes', () => {
    expect(theme.typography.fontFamily).toContain('system-ui');
    expect(theme.typography.fontFamily).not.toMatch(/fontsource|googleapis/);
    // `colorSchemes` exists at runtime when CSS variables are enabled, but the
    // plain `Theme` type does not declare it.
    const { colorSchemes } = theme as unknown as {
      colorSchemes: Record<string, unknown>;
    };
    expect(Object.keys(colorSchemes).sort()).toEqual(['dark', 'light']);
  });

  it('scopes the light and dark CSS variables to the colour-scheme attribute', () => {
    renderUi(<p>themed</p>);
    const css = Array.from(document.querySelectorAll('style'))
      .map((style) => style.textContent)
      .join('\n');
    expect(css).toContain('--mui-palette-primary-main');
    // Selected by attribute, so an explicit choice beats the OS preference.
    expect(css).toContain('[data-mui-color-scheme="dark"]');
    expect(css).not.toMatch(
      /@media \(prefers-color-scheme: dark\)\s*\{\s*:root/,
    );
  });
});

describe('StatusChip', () => {
  it.each(Object.keys(statusLabels) as ClaimStatus[])(
    'shows the %s status as text, not colour alone',
    (status) => {
      renderUi(<StatusChip status={status} />);
      expect(screen.getByText(statusLabels[status])).toBeInTheDocument();
    },
  );
});

describe('PageHeader', () => {
  it('has one level-one heading with status, subtitle and actions', () => {
    renderUi(
      <PageHeader
        title="Skyline Airways"
        subtitle="Claim by Aisha Rahman"
        status={<StatusChip status="PAID" />}
        actions={<button type="button">Edit</button>}
      />,
    );
    expect(
      screen.getByRole('heading', { level: 1, name: 'Skyline Airways' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Claim by Aisha Rahman')).toBeInTheDocument();
    expect(screen.getByText('Paid')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('renders with only a title', () => {
    renderUi(<PageHeader title="My claims" />);
    expect(
      screen.getByRole('heading', { name: 'My claims' }),
    ).toBeInTheDocument();
  });
});

describe('feedback', () => {
  it('Loading is a polite status region with visible text', () => {
    renderUi(<Loading label="Loading claims…" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading claims…');
  });

  it('EmptyState explains the empty list and keeps its action', () => {
    renderUi(
      <EmptyState title="You have no claims yet.">
        <a href="/claims/new">Create your first claim</a>
      </EmptyState>,
    );
    expect(screen.getByText('You have no claims yet.')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Create your first claim' }),
    ).toBeInTheDocument();
  });

  it('ErrorAlert shows the safe message, details, reference, and a retry', async () => {
    const onReload = vi.fn();
    const error = new ApiError(
      500,
      'INTERNAL_ERROR',
      'Something went wrong.',
      [{ field: 'amount', code: 'X', message: 'Amount is too large.' }],
      'req-123',
    );
    const { user } = renderUi(<ErrorAlert error={error} onReload={onReload} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong.');
    expect(alert).toHaveTextContent('Amount is too large.');
    expect(alert).toHaveTextContent('Reference: req-123');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(onReload).toHaveBeenCalledOnce();
  });

  it('ErrorAlert offers no retry for validation failures and can hide details', () => {
    const error = new ApiError(400, 'VALIDATION_FAILED', 'Not valid.', [
      { field: 'amount', code: 'X', message: 'Amount is too large.' },
    ]);
    renderUi(
      <ErrorAlert error={error} onReload={vi.fn()} showDetails={false} />,
    );
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByText('Amount is too large.')).toBeNull();
  });

  it('ErrorAlert explains a version conflict and loads the latest version', async () => {
    const onReload = vi.fn();
    const error = new ApiError(409, 'VERSION_CONFLICT', 'Changed by someone.');
    const { user } = renderUi(<ErrorAlert error={error} onReload={onReload} />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Someone else changed this first.',
    );
    await user.click(
      screen.getByRole('button', { name: /load the latest version/i }),
    );
    expect(onReload).toHaveBeenCalledOnce();
  });
});

describe('ConfirmDialog', () => {
  function Host({
    busy = false,
    error = null,
    initiallyOpen = false,
    onConfirm,
  }: {
    busy?: boolean;
    error?: ApiError | null;
    initiallyOpen?: boolean;
    onConfirm: () => void;
  }) {
    const [open, setOpen] = useState(initiallyOpen);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Delete draft
        </button>
        <ConfirmDialog
          open={open}
          title="Delete this draft?"
          description="This removes the draft, its receipt, and its history. It cannot be undone."
          confirmLabel="Delete draft"
          destructive
          busy={busy}
          error={error}
          onConfirm={onConfirm}
          onCancel={() => setOpen(false)}
        />
      </>
    );
  }

  it('is a named, described alert dialog that moves focus to the safe choice', async () => {
    const { user } = renderUi(<Host onConfirm={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Delete draft' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Delete this draft?',
    });
    expect(dialog).toHaveAccessibleDescription(
      'This removes the draft, its receipt, and its history. It cannot be undone.',
    );
    expect(
      within(dialog).getByRole('button', { name: 'Cancel' }),
    ).toHaveFocus();
  });

  it('traps focus, cancels on Escape, and returns focus to the trigger', async () => {
    const onConfirm = vi.fn();
    const { user } = renderUi(<Host onConfirm={onConfirm} />);
    const trigger = screen.getByRole('button', { name: 'Delete draft' });
    await user.click(trigger);
    const dialog = await screen.findByRole('alertdialog');
    for (let i = 0; i < 5; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('confirms with the named action', async () => {
    const onConfirm = vi.fn();
    const { user } = renderUi(<Host initiallyOpen onConfirm={onConfirm} />);
    const dialog = await screen.findByRole('alertdialog');
    await user.click(
      within(dialog).getByRole('button', { name: 'Delete draft' }),
    );
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('while busy disables both buttons and ignores Escape', async () => {
    const { user } = renderUi(<Host initiallyOpen busy onConfirm={vi.fn()} />);
    const dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog).getByRole('button', { name: 'Cancel' }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole('button', { name: 'Working…' }),
    ).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('shows an API error inside the dialog', async () => {
    const error = new ApiError(
      409,
      'CATEGORY_IN_USE',
      'This category is used by existing claims. Deactivate it instead.',
    );
    renderUi(<Host initiallyOpen error={error} onConfirm={vi.fn()} />);
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Deactivate it instead.',
    );
  });

  it('offers an alternative action between Cancel and the confirm button', async () => {
    const onAlternative = vi.fn();
    const { user } = renderUi(
      <ConfirmDialog
        open
        title="Delete Travel?"
        description="Travel will be deleted."
        confirmLabel="Delete category"
        alternative={{ label: 'Deactivate instead', onClick: onAlternative }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Cancel', 'Deactivate instead', 'Delete category']);
    await user.click(
      within(dialog).getByRole('button', { name: 'Deactivate instead' }),
    );
    expect(onAlternative).toHaveBeenCalledOnce();
  });

  it('shows no alternative by default', async () => {
    renderUi(
      <ConfirmDialog
        open
        title="Delete?"
        description="Gone."
        confirmLabel="Delete"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getAllByRole('button')).toHaveLength(2);
  });
});

describe('fields', () => {
  it('Field can take focus when it appears', () => {
    renderUi(
      <Field id="name" label="Name" value="" onChange={vi.fn()} autoFocus />,
    );
    expect(screen.getByLabelText('Name')).toHaveFocus();
  });

  it('Field binds the label, reports changes, and exposes error and hint', async () => {
    const onChange = vi.fn();
    const { user } = renderUi(
      <Field
        id="amount"
        label="Amount (MYR)"
        value=""
        onChange={onChange}
        hint="Limit RM 2,000.00."
        messages={['Enter an amount greater than zero.']}
      />,
    );
    const input = screen.getByLabelText('Amount (MYR)');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(
      /Limit RM 2,000\.00\..*Enter an amount greater than zero\./,
    );
    await user.type(input, '1');
    expect(onChange).toHaveBeenCalledWith('1');
  });

  it('Field is not invalid without messages, and keeps the exact label', () => {
    renderUi(
      <Field id="merchant" label="Merchant" value="" onChange={vi.fn()} />,
    );
    const input = screen.getByLabelText('Merchant');
    expect(input).toHaveAttribute('aria-invalid', 'false');
    expect(input).not.toBeRequired();
  });

  it('Field supports a labelled native date input with a maximum', () => {
    renderUi(
      <Field
        id="expenseDate"
        label="Expense date"
        type="date"
        max="2026-11-10"
        value="2026-10-10"
        onChange={vi.fn()}
      />,
    );
    const input = screen.getByLabelText('Expense date');
    expect(input).toHaveAttribute('type', 'date');
    expect(input).toHaveAttribute('max', '2026-11-10');
    expect(input).toHaveValue('2026-10-10');
  });

  it('Field supports a labelled multiline input and a length limit', () => {
    renderUi(
      <Field
        id="purpose"
        label="Business purpose"
        multiline
        rows={3}
        maxLength={200}
        value=""
        onChange={vi.fn()}
      />,
    );
    const textarea = screen.getByLabelText('Business purpose');
    expect(textarea.tagName).toBe('TEXTAREA');
    expect(textarea).toHaveAttribute('maxlength', '200');
  });

  it('SelectField is a native controlled select', async () => {
    function Host() {
      const [value, setValue] = useState('');
      return (
        <SelectField
          id="categoryId"
          label="Category"
          value={value}
          onChange={setValue}
          hint="Limit RM 2,000.00."
        >
          <option value="">Choose a category</option>
          <option value="travel">Travel</option>
        </SelectField>
      );
    }
    const { user } = renderUi(<Host />);
    const select = screen.getByLabelText('Category');
    expect(select.tagName).toBe('SELECT');
    expect(select).toHaveValue('');
    await user.selectOptions(select, 'travel');
    expect(select).toHaveValue('travel');
    expect(select).toHaveAccessibleDescription('Limit RM 2,000.00.');
  });

  it('SelectField reports an error to assistive technology', () => {
    renderUi(
      <SelectField
        id="categoryId"
        label="Category"
        value=""
        onChange={vi.fn()}
        messages={['Choose a category.']}
      >
        <option value="">Choose a category</option>
      </SelectField>,
    );
    const select = screen.getByLabelText('Category');
    expect(select).toHaveAttribute('aria-invalid', 'true');
    expect(select).toHaveAccessibleDescription('Choose a category.');
  });

  it('FileButton is reachable by keyboard and reports the chosen file', async () => {
    const onFile = vi.fn();
    const { user } = renderUi(
      <FileButton
        label="Upload receipt"
        accept="application/pdf,image/jpeg,image/png"
        onFile={onFile}
      />,
    );
    await user.tab();
    const input = screen.getByLabelText('Upload receipt');
    expect(input).toHaveFocus();
    const file = new File(['%PDF'], 'flight.pdf', { type: 'application/pdf' });
    await user.upload(input, file);
    expect(onFile).toHaveBeenCalledWith(file);
    // Choosing the same file again works because the value is cleared.
    await user.upload(input, file);
    expect(onFile).toHaveBeenCalledTimes(2);
  });

  it('FileButton is disabled while busy', () => {
    renderUi(
      <FileButton
        label="Replace receipt"
        accept="image/png"
        disabled
        onFile={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Replace receipt')).toBeDisabled();
  });
});

describe('DataTable', () => {
  it('names the table and its scroll region and exposes row headers', () => {
    renderUi(
      <DataTable label="Claims">
        <thead>
          <tr>
            <th scope="col">Merchant</th>
            <th scope="col">Amount</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <RowHeader>Skyline Airways</RowHeader>
            <td>RM 450.00</td>
          </tr>
        </tbody>
      </DataTable>,
    );
    const region = screen.getByRole('region', { name: 'Claims (scrollable)' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(
      within(region).getByRole('table', { name: 'Claims' }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader')).toHaveLength(2);
    expect(
      screen.getByRole('rowheader', { name: 'Skyline Airways' }),
    ).toBeInTheDocument();
  });
});

describe('navigation', () => {
  it('MainNav is a landmark of links that marks the current page', () => {
    renderUi(
      <MainNav>
        <NavItem to="/claims">My claims</NavItem>
        <NavItem to="/review">Review queue</NavItem>
      </MainNav>,
      '/review',
    );
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['My claims', 'Review queue']);
    expect(
      within(nav).getByRole('link', { name: 'Review queue' }),
    ).toHaveAttribute('aria-current', 'page');
    expect(
      within(nav).getByRole('link', { name: 'My claims' }),
    ).not.toHaveAttribute('aria-current');
    expect(within(nav).queryByRole('tab')).toBeNull();
  });

  it('SkipLink is the first stop and targets the main content', async () => {
    const { user } = renderUi(
      <>
        <SkipLink targetId="main" />
        <button type="button">Other</button>
        <main id="main">Content</main>
      </>,
    );
    await user.tab();
    const skip = screen.getByRole('link', { name: 'Skip to main content' });
    expect(skip).toHaveFocus();
    expect(skip).toHaveAttribute('href', '#main');
  });
});

describe('toasts', () => {
  function Trigger() {
    const { notify } = useToast();
    return (
      <>
        <button type="button" onClick={() => notify('Draft saved.')}>
          Save
        </button>
        <Link to="/other">Elsewhere</Link>
      </>
    );
  }

  it('announces a polite status without taking focus', async () => {
    const { user } = renderUi(<Trigger />);
    const save = screen.getByRole('button', { name: 'Save' });
    await user.click(save);
    expect(await screen.findByRole('status')).toHaveTextContent('Draft saved.');
    expect(save).toHaveFocus();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('is dismissed by Escape and by its close button', async () => {
    const { user } = renderUi(<Trigger />);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('status');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());

    await user.click(screen.getByRole('button', { name: 'Save' }));
    const toast = await screen.findByRole('status');
    await user.click(within(toast).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  it('does not follow the user to another page', async () => {
    const { user } = renderUi(<Trigger />);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('status');
    await user.click(screen.getByRole('link', { name: 'Elsewhere' }));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  it('useToast outside the provider is an error', () => {
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    expect(() => render(<Trigger />)).toThrow(/ToastProvider/);
    error.mockRestore();
  });
});
