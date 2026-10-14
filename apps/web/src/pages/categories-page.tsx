import {
  categoryNameMaxLength,
  type CategoryDto,
  type FieldError,
} from '@claimflow/contracts';
import { useState, type FormEvent } from 'react';

import type { ApiError } from '../api/client';
import { api } from '../api/claimflow';
import {
  EmptyState,
  ErrorNotice,
  FieldMessages,
  Loading,
  fieldMessages,
} from '../components/ui';
import { formatMoney, parseAmount, toAmountInput } from '../lib/money';
import { toApiError, useResource } from '../lib/use-resource';

export function CategoriesPage() {
  const categories = useResource((signal) => api.listCategories(signal), []);
  // A category ID, or 'new' while adding one.
  const [editing, setEditing] = useState<string | null>(null);

  function saved() {
    setEditing(null);
    categories.reload();
  }

  return (
    <>
      <div className="page-head">
        <h1>Categories</h1>
        {editing !== 'new' && (
          <button
            type="button"
            className="button"
            onClick={() => setEditing('new')}
          >
            Add category
          </button>
        )}
      </div>
      <p className="muted">
        Limits and receipt thresholds apply when a claim is submitted, including
        claims drafted before a change.
      </p>

      {editing === 'new' && (
        <CategoryForm onSaved={saved} onCancel={() => setEditing(null)} />
      )}

      {categories.state === 'loading' && (
        <Loading label="Loading categories…" />
      )}
      {categories.state === 'error' && (
        <ErrorNotice error={categories.error} onReload={categories.reload} />
      )}
      {categories.state === 'ready' &&
        (categories.data.length === 0 ? (
          <EmptyState title="No categories yet." />
        ) : (
          <ul className="category-list" aria-label="Categories">
            {categories.data.map((category) =>
              editing === category.categoryId ? (
                <li key={category.categoryId}>
                  <CategoryForm
                    category={category}
                    onSaved={saved}
                    onCancel={() => setEditing(null)}
                  />
                </li>
              ) : (
                <CategoryRow
                  key={category.categoryId}
                  category={category}
                  onEdit={() => setEditing(category.categoryId)}
                  onChanged={categories.reload}
                />
              ),
            )}
          </ul>
        ))}
    </>
  );
}

function CategoryRow({
  category,
  onEdit,
  onChanged,
}: {
  readonly category: CategoryDto;
  readonly onEdit: () => void;
  readonly onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function run(change: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await change();
      onChanged();
    } catch (caught) {
      setError(toApiError(caught));
    } finally {
      setBusy(false);
      setConfirmingDelete(false);
    }
  }

  const toggle = () =>
    run(() =>
      api.updateCategory(category.categoryId, {
        expectedVersion: category.version,
        active: !category.active,
      }),
    );
  const remove = () =>
    run(() => api.deleteCategory(category.categoryId, category.version));

  return (
    <li className="category-row">
      <div className="category-main">
        <strong>{category.name}</strong>
        <span className={category.active ? 'pill pill-on' : 'pill pill-off'}>
          {category.active ? 'Active' : 'Inactive'}
        </span>
      </div>
      <div className="muted">
        Limit {formatMoney(category.maxAmountMinor, category.currency)} ·
        Receipt above{' '}
        {formatMoney(category.receiptRequiredAboveMinor, category.currency)}
      </div>
      <div className="row-actions">
        <button type="button" className="link-button" onClick={onEdit}>
          Edit <span className="visually-hidden">{category.name}</span>
        </button>
        <button
          type="button"
          className="link-button"
          disabled={busy}
          onClick={() => void toggle()}
        >
          {category.active ? 'Deactivate' : 'Activate'}{' '}
          <span className="visually-hidden">{category.name}</span>
        </button>
        {confirmingDelete ? (
          <>
            <button
              type="button"
              className="link-button danger-link"
              disabled={busy}
              onClick={() => void remove()}
            >
              Confirm delete{' '}
              <span className="visually-hidden">{category.name}</span>
            </button>
            <button
              type="button"
              className="link-button"
              disabled={busy}
              onClick={() => setConfirmingDelete(false)}
            >
              Keep it
            </button>
          </>
        ) : (
          <button
            type="button"
            className="link-button"
            disabled={busy}
            onClick={() => setConfirmingDelete(true)}
          >
            Delete <span className="visually-hidden">{category.name}</span>
          </button>
        )}
      </div>
      {error !== null && <ErrorNotice error={error} onReload={onChanged} />}
    </li>
  );
}

function CategoryForm({
  category,
  onSaved,
  onCancel,
}: {
  readonly category?: CategoryDto;
  readonly onSaved: () => void;
  readonly onCancel: () => void;
}) {
  const currencyOf = category?.currency ?? 'MYR';
  const [name, setName] = useState(category?.name ?? '');
  const [currency, setCurrency] = useState(currencyOf);
  const [max, setMax] = useState(
    category === undefined
      ? ''
      : toAmountInput(category.maxAmountMinor, currencyOf),
  );
  const [threshold, setThreshold] = useState(
    category === undefined
      ? ''
      : toAmountInput(category.receiptRequiredAboveMinor, currencyOf),
  );
  const [active, setActive] = useState(category?.active ?? true);
  const [localErrors, setLocalErrors] = useState<FieldError[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [saving, setSaving] = useState(false);
  const prefix = category?.categoryId ?? 'new';

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const code = currency.trim().toUpperCase();
    const maxAmountMinor = parseAmount(max, code);
    const receiptRequiredAboveMinor = parseAmount(threshold, code);
    const problems: FieldError[] = [];
    if (maxAmountMinor === undefined) {
      problems.push({
        field: 'maxAmountMinor',
        code: 'INVALID',
        message: 'Enter a maximum amount, like 500.00.',
      });
    }
    if (receiptRequiredAboveMinor === undefined) {
      problems.push({
        field: 'receiptRequiredAboveMinor',
        code: 'INVALID',
        message: 'Enter an amount, or 0 to always require a receipt.',
      });
    }
    setLocalErrors(problems);
    if (
      maxAmountMinor === undefined ||
      receiptRequiredAboveMinor === undefined
    ) {
      return;
    }

    const settings = {
      name,
      currency: code,
      maxAmountMinor,
      receiptRequiredAboveMinor,
      active,
    };
    setSaving(true);
    try {
      if (category === undefined) {
        await api.createCategory(settings);
      } else {
        await api.updateCategory(category.categoryId, {
          expectedVersion: category.version,
          ...settings,
        });
      }
      onSaved();
    } catch (caught) {
      setError(toApiError(caught));
    } finally {
      setSaving(false);
    }
  }

  const details = [...localErrors, ...(error?.details ?? [])];
  const messages = (field: string) => fieldMessages(details, field);

  return (
    <form
      className="form panel"
      onSubmit={(e) => void submit(e)}
      aria-label={
        category === undefined ? 'New category' : `Edit ${category.name}`
      }
      noValidate
    >
      {error !== null && (
        <ErrorNotice error={error} onReload={onSaved} showDetails={false} />
      )}
      <div className="form-grid">
        <div className="field">
          <label htmlFor={`${prefix}-name`}>Name</label>
          <input
            id={`${prefix}-name`}
            value={name}
            maxLength={categoryNameMaxLength}
            onChange={(e) => setName(e.target.value)}
          />
          <FieldMessages
            id={`${prefix}-name-error`}
            messages={messages('name')}
          />
        </div>
        <div className="field">
          <label htmlFor={`${prefix}-currency`}>Currency</label>
          <input
            id={`${prefix}-currency`}
            value={currency}
            maxLength={3}
            onChange={(e) => setCurrency(e.target.value)}
          />
          <FieldMessages
            id={`${prefix}-currency-error`}
            messages={messages('currency')}
          />
        </div>
        <div className="field">
          <label htmlFor={`${prefix}-max`}>Maximum claim amount</label>
          <input
            id={`${prefix}-max`}
            inputMode="decimal"
            value={max}
            onChange={(e) => setMax(e.target.value)}
          />
          <FieldMessages
            id={`${prefix}-max-error`}
            messages={messages('maxAmountMinor')}
          />
        </div>
        <div className="field">
          <label htmlFor={`${prefix}-threshold`}>Receipt required above</label>
          <input
            id={`${prefix}-threshold`}
            inputMode="decimal"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
          />
          <FieldMessages
            id={`${prefix}-threshold-error`}
            messages={messages('receiptRequiredAboveMinor')}
          />
        </div>
      </div>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={active}
          onChange={(e) => setActive(e.target.checked)}
        />
        Active (available for new claims)
      </label>
      <div className="form-actions">
        <button type="submit" className="button" disabled={saving}>
          {saving ? 'Saving…' : 'Save category'}
        </button>
        <button
          type="button"
          className="button button-secondary"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
