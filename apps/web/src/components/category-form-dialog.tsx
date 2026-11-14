import {
  categoryNameMaxLength,
  type CategoryDto,
  type FieldError,
} from '@claimflow/contracts';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import Stack from '@mui/material/Stack';
import { useEffect, useId, useState, type FormEvent } from 'react';

import type { ApiError } from '../api/client';
import { api } from '../api/claimflow';
import { parseAmount, toAmountInput } from '../lib/money';
import { toApiError } from '../lib/use-resource';
import { Field } from '../ui/fields';
import { ErrorNotice, fieldMessages } from './ui';

/** Fields in the order they are filled in, so errors can focus the first. */
const fieldIds = {
  name: 'category-name',
  currency: 'category-currency',
  maxAmountMinor: 'category-max',
  receiptRequiredAboveMinor: 'category-threshold',
} as const;
const fieldOrder = [
  'name',
  'currency',
  'maxAmountMinor',
  'receiptRequiredAboveMinor',
] as const;

/**
 * Adds a category, or edits one when `category` is given. It checks only the
 * amounts' format; limits, currency and names are validated by the API and
 * shown beside their fields. Edits are saved with the category's version.
 * Deleting is offered only when editing, apart from the routine buttons.
 */
export function CategoryFormDialog({
  category,
  onClose,
  onSaved,
  onReload,
  onDelete,
}: {
  readonly category?: CategoryDto;
  readonly onClose: () => void;
  readonly onSaved: (saved: CategoryDto) => void;
  /** Used when someone else changed the category: close and load the latest. */
  readonly onReload: () => void;
  readonly onDelete?: () => void;
}) {
  const titleId = useId();
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
  const [focusTarget, setFocusTarget] = useState<{ id: string } | null>(null);

  // After a failed save, move focus to the first field with a problem.
  useEffect(() => {
    if (focusTarget !== null) {
      document.getElementById(focusTarget.id)?.focus();
    }
  }, [focusTarget]);

  function focusFirstProblem(details: readonly FieldError[]) {
    const field = fieldOrder.find(
      (candidate) => fieldMessages(details, candidate).length > 0,
    );
    if (field !== undefined) {
      setFocusTarget({ id: fieldIds[field] });
    }
  }

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
      focusFirstProblem(problems);
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
      onSaved(
        category === undefined
          ? await api.createCategory(settings)
          : await api.updateCategory(category.categoryId, {
              expectedVersion: category.version,
              ...settings,
            }),
      );
    } catch (caught) {
      const failure = toApiError(caught);
      setError(failure);
      focusFirstProblem(failure.details);
      setSaving(false);
    }
  }

  const details = [...localErrors, ...(error?.details ?? [])];
  const messages = (field: string) => fieldMessages(details, field);

  return (
    <Dialog
      open
      onClose={saving ? undefined : onClose}
      fullWidth
      maxWidth="sm"
      aria-labelledby={titleId}
    >
      <Box component="form" noValidate onSubmit={(e) => void submit(e)}>
        <DialogTitle id={titleId}>
          {category === undefined ? 'New category' : `Edit ${category.name}`}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2.5} sx={{ pt: 1 }}>
            {error !== null && (
              <ErrorNotice
                error={error}
                onReload={onReload}
                showDetails={false}
              />
            )}
            <Field
              id={fieldIds.name}
              label="Name"
              value={name}
              onChange={setName}
              messages={messages('name')}
              maxLength={categoryNameMaxLength}
              autoFocus
            />
            <Field
              id={fieldIds.currency}
              label="Currency"
              value={currency}
              onChange={setCurrency}
              messages={messages('currency')}
              maxLength={3}
              autoComplete="off"
              hint="A three-letter code, such as MYR."
            />
            <Field
              id={fieldIds.maxAmountMinor}
              label="Maximum claim amount"
              value={max}
              onChange={setMax}
              messages={messages('maxAmountMinor')}
              inputMode="decimal"
              autoComplete="off"
            />
            <Field
              id={fieldIds.receiptRequiredAboveMinor}
              label="Receipt required above"
              value={threshold}
              onChange={setThreshold}
              messages={messages('receiptRequiredAboveMinor')}
              inputMode="decimal"
              autoComplete="off"
              hint="Claims above this amount need a receipt. Use 0 to always require one."
            />
            <FormControlLabel
              control={
                <Checkbox
                  checked={active}
                  onChange={(e) => setActive(e.target.checked)}
                />
              }
              label="Active (available for new claims)"
            />
          </Stack>
        </DialogContent>
        <DialogActions
          sx={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}
        >
          {onDelete === undefined ? (
            <span />
          ) : (
            <Button color="error" onClick={onDelete} disabled={saving}>
              Delete category
            </Button>
          )}
          <Stack direction="row" spacing={1}>
            <Button onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" variant="contained" disabled={saving}>
              {saving ? 'Saving…' : 'Save category'}
            </Button>
          </Stack>
        </DialogActions>
      </Box>
    </Dialog>
  );
}
