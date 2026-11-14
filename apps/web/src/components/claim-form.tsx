import {
  businessPurposeMaxLength,
  merchantMaxLength,
  type CategoryDto,
  type ClaimDto,
  type CreateClaimRequest,
  type FieldError,
} from '@claimflow/contracts';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useEffect, useState, type FormEvent } from 'react';

import type { ApiError } from '../api/client';
import { localToday } from '../lib/format';
import { formatMoney, parseAmount, toAmountInput } from '../lib/money';
import { toApiError } from '../lib/use-resource';
import { Field, SelectField } from '../ui/fields';
import { ErrorNotice, fieldMessages } from './ui';

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

/** Fields in the order a person fills them in, so errors can focus the first. */
const fieldOrder: readonly (keyof FormValues)[] = [
  'categoryId',
  'amount',
  'expenseDate',
  'merchant',
  'businessPurpose',
];

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
 *
 * `onDirtyChange` reports whether the fields differ from the values the form
 * started with, and false again when the form goes away. Pass a stable
 * function, such as a state setter.
 */
export function ClaimForm({
  claim,
  categories,
  submitLabel,
  onSubmit,
  onCancel,
  onReload,
  onDirtyChange,
}: {
  readonly claim?: ClaimDto;
  readonly categories: readonly CategoryDto[];
  readonly submitLabel: string;
  readonly onSubmit: (values: ClaimFormSubmission) => Promise<void>;
  readonly onCancel: () => void;
  /** Offers to discard the edits and load the latest saved version. */
  readonly onReload?: () => void;
  readonly onDirtyChange?: (dirty: boolean) => void;
}) {
  const [initial] = useState(() => initialValues(claim));
  const [values, setValues] = useState<FormValues>(initial);
  const [localErrors, setLocalErrors] = useState<FieldError[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [saving, setSaving] = useState(false);
  const [focusTarget, setFocusTarget] = useState<{ id: string } | null>(null);

  const dirty = fieldOrder.some((field) => values[field] !== initial[field]);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  // After a failed save, move focus to the first field with a problem.
  useEffect(() => {
    if (focusTarget !== null) {
      document.getElementById(focusTarget.id)?.focus();
    }
  }, [focusTarget]);

  const selectable = categories.filter(
    (c) => c.active || c.categoryId === claim?.categoryId,
  );
  const category = categories.find((c) => c.categoryId === values.categoryId);
  const currency =
    category?.currency ?? claim?.amount?.currency ?? defaultCurrency;

  const set = (field: keyof FormValues) => (value: string) =>
    setValues((current) => ({ ...current, [field]: value }));

  function focusFirstProblem(details: readonly FieldError[]) {
    const id = fieldOrder.find(
      (field) => fieldMessages(details, field).length > 0,
    );
    if (id !== undefined) {
      setFocusTarget({ id });
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    const amountMinor =
      values.amount.trim() === ''
        ? null
        : (parseAmount(values.amount, currency) ?? undefined);
    if (amountMinor === undefined || amountMinor === 0) {
      const problems: FieldError[] = [
        {
          field: 'amount',
          code: 'INVALID_AMOUNT',
          message: `Enter an amount greater than zero, like ${toAmountInput(12550, currency)}.`,
        },
      ];
      setLocalErrors(problems);
      focusFirstProblem(problems);
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
      const failure = toApiError(caught);
      setError(failure);
      focusFirstProblem(failure.details);
    } finally {
      setSaving(false);
    }
  }

  const details = [...localErrors, ...(error?.details ?? [])];
  const messages = (field: string) => fieldMessages(details, field);

  return (
    <Box component="form" noValidate onSubmit={(e) => void handleSubmit(e)}>
      <Stack spacing={2.5}>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          You can save an incomplete draft. Everything is required to submit.
        </Typography>
        {error !== null && <ErrorNotice error={error} showDetails={false} />}

        <SelectField
          id="categoryId"
          label="Category"
          value={values.categoryId}
          onChange={set('categoryId')}
          messages={messages('categoryId')}
          hint={
            category === undefined
              ? undefined
              : `Limit ${formatMoney(category.maxAmountMinor, category.currency)}. Receipt needed above ${formatMoney(category.receiptRequiredAboveMinor, category.currency)}.`
          }
        >
          <option value="">Choose a category</option>
          {selectable.map((c) => (
            <option key={c.categoryId} value={c.categoryId}>
              {c.name}
              {c.active ? '' : ' (inactive)'}
            </option>
          ))}
        </SelectField>

        <Field
          id="amount"
          label={`Amount (${currency})`}
          value={values.amount}
          onChange={set('amount')}
          messages={messages('amount')}
          inputMode="decimal"
          autoComplete="off"
          placeholder={toAmountInput(0, currency)}
        />

        <Field
          id="expenseDate"
          label="Expense date"
          type="date"
          max={localToday()}
          value={values.expenseDate}
          onChange={set('expenseDate')}
          messages={messages('expenseDate')}
        />

        <Field
          id="merchant"
          label="Merchant"
          maxLength={merchantMaxLength}
          value={values.merchant}
          onChange={set('merchant')}
          messages={messages('merchant')}
        />

        <Field
          id="businessPurpose"
          label="Business purpose"
          multiline
          rows={3}
          maxLength={businessPurposeMaxLength}
          value={values.businessPurpose}
          onChange={set('businessPurpose')}
          messages={messages('businessPurpose')}
        />

        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ flexWrap: 'wrap', alignItems: 'center' }}
        >
          <Button type="submit" variant="contained" disabled={saving}>
            {saving ? 'Saving…' : submitLabel}
          </Button>
          <Button variant="outlined" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          {onReload !== undefined && (
            <Button onClick={onReload} disabled={saving}>
              Discard my edits and load the latest version
            </Button>
          )}
        </Stack>
      </Stack>
    </Box>
  );
}
