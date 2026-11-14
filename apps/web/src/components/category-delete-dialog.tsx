import type { CategoryDto } from '@claimflow/contracts';
import { useState } from 'react';

import type { ApiError } from '../api/client';
import { api } from '../api/claimflow';
import { toApiError } from '../lib/use-resource';
import { ConfirmDialog } from '../ui/confirm-dialog';

/**
 * Confirms deleting a category. A category that claims already use cannot be
 * deleted; the server says so, and an active one can then be deactivated
 * instead with the same update the Deactivate button uses.
 */
export function CategoryDeleteDialog({
  category,
  onCancel,
  onDeleted,
  onDeactivated,
  onReload,
}: {
  readonly category: CategoryDto;
  readonly onCancel: () => void;
  readonly onDeleted: () => void;
  readonly onDeactivated: () => void;
  /** Used when someone else changed the category: close and load the latest. */
  readonly onReload: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function run(action: () => Promise<unknown>, done: () => void) {
    setBusy(true);
    setError(null);
    try {
      await action();
      done();
    } catch (caught) {
      setError(toApiError(caught));
      setBusy(false);
    }
  }

  const inUse = error?.code === 'CATEGORY_IN_USE';
  return (
    <ConfirmDialog
      open
      title={`Delete ${category.name}?`}
      description={`${category.name} will be deleted permanently. This cannot be undone. A category that existing claims use cannot be deleted; deactivate it instead.`}
      confirmLabel="Delete category"
      busyLabel="Deleting…"
      destructive
      busy={busy}
      error={error}
      onReload={error?.isConflict === true ? onReload : undefined}
      alternative={
        inUse && category.active
          ? {
              label: 'Deactivate instead',
              onClick: () =>
                void run(
                  () =>
                    api.updateCategory(category.categoryId, {
                      expectedVersion: category.version,
                      active: false,
                    }),
                  onDeactivated,
                ),
            }
          : undefined
      }
      onConfirm={() =>
        void run(
          () => api.deleteCategory(category.categoryId, category.version),
          onDeleted,
        )
      }
      onCancel={onCancel}
    />
  );
}
