import {
  businessPurposeMaxLength,
  merchantMaxLength,
  type CategoryDto,
  type ClaimDto,
  type CreateClaimRequest,
  type FieldError,
} from '@claimflow/contracts';
import { useState, type FormEvent } from 'react';

import type { ApiError } from '../api/client';
import { localToday } from '../lib/format';
import { formatMoney, parseAmount, toAmountInput } from '../lib/money';
import { toApiError } from '../lib/use-resource';
import { ErrorNotice, FieldMessages, fieldMessages } from './ui';

interface FormValues {
  categoryId: string;
  amount: string;
  expenseDate: string;
  merchant: string;
  businessPurpose: string;
}

/** The full set of draft details; empty fields are sent as `null`. */
export type ClaimFormSubmission = {
  [K in keyof Required<CreateClaimRequest>]: NonNullable<
    CreateClaimRequest[K]
  > | null;
};

const defaultCurrency = 'MYR';

function initialValues(claim: ClaimDto | undefined): FormValues {
  return {
    categoryId: claim?.categoryId ?? '',
    amount:
      claim?.amount === undefined
        ? ''
        : toAmountInput(claim.amount.amountMinor, claim.amount.currency),
    expenseDate: claim?.expenseDate ?? '',
    merchant: claim?.merchant ?? '',
    businessPurpose: claim?.businessPurpose ?? '',
  };
}

/**
 * Collects draft details. It only checks what the browser can know (amount
 * format, lengths); every business rule is enforced and reported by the API.
 */
export function ClaimForm({
  claim,
  categories,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  readonly claim?: ClaimDto;
  readonly categories: readonly CategoryDto[];
  readonly submitLabel: string;
  readonly onSubmit: (values: ClaimFormSubmission) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const [values, setValues] = useState<FormValues>(() => initialValues(claim));
  const [localErrors, setLocalErrors] = useState<FieldError[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [saving, setSaving] = useState(false);

  const selectable = categories.filter(
    (c) => c.active || c.categoryId === claim?.categoryId,
  );
  const category = categories.find((c) => c.categoryId === values.categoryId);
  const currency =
    category?.currency ?? claim?.amount?.currency ?? defaultCurrency;

  const set =
    (field: keyof FormValues) => (event: { target: { value: string } }) =>
      setValues((current) => ({ ...current, [field]: event.target.value }));

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    const amountMinor =
      values.amount.trim() === ''
        ? null
        : (parseAmount(values.amount, currency) ?? undefined);
    if (amountMinor === undefined || amountMinor === 0) {
      setLocalErrors([
        {
          field: 'amount',
          code: 'INVALID_AMOUNT',
          message: `Enter an amount greater than zero, like ${toAmountInput(12550, currency)}.`,
        },
      ]);
      return;
    }
    setLocalErrors([]);

    const text = (value: string) => (value.trim() === '' ? null : value.trim());
    setSaving(true);
    try {
      await onSubmit({
        categoryId: text(values.categoryId),
        amount: amountMinor === null ? null : { amountMinor, currency },
        expenseDate: text(values.expenseDate),
        merchant: text(values.merchant),
        businessPurpose: text(values.businessPurpose),
      });
    } catch (caught) {
      setError(toApiError(caught));
    } finally {
      setSaving(false);
    }
  }

  const details = [...localErrors, ...(error?.details ?? [])];
  const messages = (field: string) => fieldMessages(details, field);
  const described = (field: string) =>
    messages(field).length > 0 ? { 'aria-describedby': `${field}-error` } : {};

  return (
    <form className="form" onSubmit={(e) => void handleSubmit(e)} noValidate>
      <p className="hint">
        You can save an incomplete draft. Everything is required to submit.
      </p>
      {error !== null && <ErrorNotice error={error} showDetails={false} />}

      <div className="field">
        <label htmlFor="categoryId">Category</label>
        <select
          id="categoryId"
          value={values.categoryId}
          onChange={set('categoryId')}
          aria-invalid={messages('categoryId').length > 0}
          {...described('categoryId')}
        >
          <option value="">Choose a category</option>
          {selectable.map((c) => (
            <option key={c.categoryId} value={c.categoryId}>
              {c.name}
              {c.active ? '' : ' (inactive)'}
            </option>
          ))}
        </select>
        {category !== undefined && (
          <p className="hint">
            Limit {formatMoney(category.maxAmountMinor, category.currency)}.
            Receipt needed above{' '}
            {formatMoney(category.receiptRequiredAboveMinor, category.currency)}
            .
          </p>
        )}
        <FieldMessages
          id="categoryId-error"
          messages={messages('categoryId')}
        />
      </div>

      <div className="field">
        <label htmlFor="amount">Amount ({currency})</label>
        <input
          id="amount"
          inputMode="decimal"
          autoComplete="off"
          placeholder={toAmountInput(0, currency)}
          value={values.amount}
          onChange={set('amount')}
          aria-invalid={messages('amount').length > 0}
          {...described('amount')}
        />
        <FieldMessages id="amount-error" messages={messages('amount')} />
      </div>

      <div className="field">
        <label htmlFor="expenseDate">Expense date</label>
        <input
          id="expenseDate"
          type="date"
          max={localToday()}
          value={values.expenseDate}
          onChange={set('expenseDate')}
          aria-invalid={messages('expenseDate').length > 0}
          {...described('expenseDate')}
        />
        <FieldMessages
          id="expenseDate-error"
          messages={messages('expenseDate')}
        />
      </div>

      <div className="field">
        <label htmlFor="merchant">Merchant</label>
        <input
          id="merchant"
          maxLength={merchantMaxLength}
          value={values.merchant}
          onChange={set('merchant')}
          aria-invalid={messages('merchant').length > 0}
          {...described('merchant')}
        />
        <FieldMessages id="merchant-error" messages={messages('merchant')} />
      </div>

      <div className="field">
        <label htmlFor="businessPurpose">Business purpose</label>
        <textarea
          id="businessPurpose"
          rows={3}
          maxLength={businessPurposeMaxLength}
          value={values.businessPurpose}
          onChange={set('businessPurpose')}
          aria-invalid={messages('businessPurpose').length > 0}
          {...described('businessPurpose')}
        />
        <FieldMessages
          id="businessPurpose-error"
          messages={messages('businessPurpose')}
        />
      </div>

      <div className="form-actions">
        <button type="submit" className="button" disabled={saving}>
          {saving ? 'Saving…' : submitLabel}
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
