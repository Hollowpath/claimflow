import type { ClaimDto } from '@claimflow/contracts';

import { api } from '../api/claimflow';
import { useResource } from '../lib/use-resource';
import { ClaimForm, type ClaimFormSubmission } from './claim-form';
import { ErrorNotice, Loading } from './ui';

/**
 * Edits a draft in place. It loads the categories, saves with the claim's
 * version so a newer change is never overwritten, and hands the saved claim
 * back. A version conflict leaves the edits on screen with the offer to
 * discard them and load the latest version.
 */
export function ClaimEditor({
  claim,
  onSaved,
  onCancel,
  onReload,
  onDirtyChange,
}: {
  readonly claim: ClaimDto;
  readonly onSaved: (claim: ClaimDto) => void;
  readonly onCancel: () => void;
  readonly onReload: () => void;
  readonly onDirtyChange: (dirty: boolean) => void;
}) {
  const categories = useResource((signal) => api.listCategories(signal), []);

  if (categories.state === 'loading') {
    return <Loading label="Loading categories…" />;
  }
  if (categories.state === 'error') {
    return (
      <ErrorNotice error={categories.error} onReload={categories.reload} />
    );
  }

  async function save(values: ClaimFormSubmission) {
    onSaved(
      await api.updateClaim(claim.claimId, {
        expectedVersion: claim.version,
        ...values,
      }),
    );
  }

  return (
    <ClaimForm
      claim={claim}
      categories={categories.data}
      submitLabel="Save changes"
      onSubmit={save}
      onCancel={onCancel}
      onReload={onReload}
      onDirtyChange={onDirtyChange}
    />
  );
}
