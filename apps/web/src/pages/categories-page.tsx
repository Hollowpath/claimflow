import type { CategoryDto } from '@claimflow/contracts';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import { useState } from 'react';

import type { ApiError } from '../api/client';
import { api } from '../api/claimflow';
import { CategoryDeleteDialog } from '../components/category-delete-dialog';
import { CategoryFormDialog } from '../components/category-form-dialog';
import { EmptyState, ErrorNotice, Loading } from '../components/ui';
import { formatMoney } from '../lib/money';
import { toApiError, useResource } from '../lib/use-resource';
import { DataTable, RowHeader } from '../ui/data-table';
import { PageHeader } from '../ui/page-header';
import { useToast } from '../ui/toast';

const addButtonId = 'add-category';
const editButtonId = (category: CategoryDto) =>
  `edit-category-${category.categoryId}`;

function focusLater(id: string) {
  // Wait for the dialog that is closing to give focus back, then move it on.
  setTimeout(() => document.getElementById(id)?.focus(), 0);
}

export function CategoriesPage() {
  const categories = useResource((signal) => api.listCategories(signal), []);
  const { notify } = useToast();
  // A category being edited, 'new' while adding one, or nothing.
  const [editing, setEditing] = useState<CategoryDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<CategoryDto | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);

  async function toggle(category: CategoryDto) {
    setBusyId(category.categoryId);
    setActionError(null);
    try {
      await api.updateCategory(category.categoryId, {
        expectedVersion: category.version,
        active: !category.active,
      });
      notify(
        `${category.name} ${category.active ? 'deactivated' : 'activated'}.`,
      );
      categories.reload();
    } catch (caught) {
      setActionError(toApiError(caught));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Categories"
        subtitle="Limits and receipt thresholds apply when a claim is submitted, including claims drafted before a change."
        actions={
          <Button
            id={addButtonId}
            variant="contained"
            onClick={() => setEditing('new')}
          >
            Add category
          </Button>
        }
      />

      {actionError !== null && (
        <Stack sx={{ mb: 2 }}>
          <ErrorNotice error={actionError} onReload={categories.reload} />
        </Stack>
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
          <DataTable label="Categories">
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Currency</TableCell>
                <TableCell align="right">Maximum claim amount</TableCell>
                <TableCell align="right">Receipt required above</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {categories.data.map((category) => (
                <TableRow key={category.categoryId} hover>
                  <RowHeader>{category.name}</RowHeader>
                  <TableCell>{category.currency}</TableCell>
                  <TableCell
                    align="right"
                    sx={{
                      whiteSpace: 'nowrap',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {formatMoney(category.maxAmountMinor, category.currency)}
                  </TableCell>
                  <TableCell
                    align="right"
                    sx={{
                      whiteSpace: 'nowrap',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {formatMoney(
                      category.receiptRequiredAboveMinor,
                      category.currency,
                    )}
                  </TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      label={category.active ? 'Active' : 'Inactive'}
                      color={category.active ? 'success' : 'default'}
                      variant="outlined"
                    />
                  </TableCell>
                  <TableCell>
                    <Stack
                      direction="row"
                      spacing={1}
                      useFlexGap
                      sx={{ flexWrap: 'nowrap' }}
                    >
                      <Button
                        id={editButtonId(category)}
                        size="small"
                        variant="outlined"
                        aria-label={`Edit ${category.name}`}
                        onClick={() => setEditing(category)}
                      >
                        Edit
                      </Button>
                      <Button
                        size="small"
                        aria-label={`${category.active ? 'Deactivate' : 'Activate'} ${category.name}`}
                        disabled={busyId !== null}
                        onClick={() => void toggle(category)}
                      >
                        {category.active ? 'Deactivate' : 'Activate'}
                      </Button>
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
        ))}

      {editing !== null && (
        <CategoryFormDialog
          key={editing === 'new' ? 'new' : editing.categoryId}
          {...(editing === 'new' ? {} : { category: editing })}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            notify(
              editing === 'new'
                ? `${saved.name} added.`
                : `${saved.name} saved.`,
            );
            setEditing(null);
            categories.reload();
          }}
          onReload={() => {
            setEditing(null);
            categories.reload();
          }}
          {...(editing === 'new'
            ? {}
            : {
                onDelete: () => {
                  setDeleting(editing);
                  setEditing(null);
                },
              })}
        />
      )}

      {deleting !== null && (
        <CategoryDeleteDialog
          category={deleting}
          onCancel={() => {
            const category = deleting;
            setDeleting(null);
            focusLater(editButtonId(category));
          }}
          onDeleted={() => {
            notify(`${deleting.name} deleted.`);
            setDeleting(null);
            categories.reload();
            focusLater(addButtonId);
          }}
          onDeactivated={() => {
            notify(`${deleting.name} deactivated.`);
            const category = deleting;
            setDeleting(null);
            categories.reload();
            focusLater(editButtonId(category));
          }}
          onReload={() => {
            setDeleting(null);
            categories.reload();
          }}
        />
      )}
    </>
  );
}
