import type { ClaimDto, CreateClaimRequest } from '@claimflow/contracts';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MuiLink from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import { useState } from 'react';
import {
  Link as RouterLink,
  useMatch,
  useNavigate,
  useParams,
} from 'react-router';

import { api } from '../api/claimflow';
import { ClaimActions } from '../components/claim-actions';
import { ClaimDetails } from '../components/claim-details';
import { ClaimEditor } from '../components/claim-editor';
import { ClaimForm, type ClaimFormSubmission } from '../components/claim-form';
import { ClaimList } from '../components/claim-list';
import { DeleteDraft } from '../components/delete-draft';
import {
  HistoryCard,
  RejectionNotice,
  useClaimHistory,
} from '../components/history-card';
import { ReceiptPanel } from '../components/receipt-panel';
import { RequireRole } from '../components/require-role';
import { ErrorNotice, Loading } from '../components/ui';
import { nextStepText } from '../lib/format';
import { useResource } from '../lib/use-resource';
import { useCurrentUser } from '../session';
import { PageHeader } from '../ui/page-header';
import { Section } from '../ui/section';
import { StatusChip } from '../ui/status-chip';

const unsavedReason = 'Save or cancel your changes before submitting.';

export function MyClaimsPage() {
  return (
    <>
      <PageHeader
        title="My claims"
        actions={
          <Button component={RouterLink} to="/claims/new" variant="contained">
            New claim
          </Button>
        }
      />
      <ClaimList
        load={(cursor, signal) => api.listMyClaims(cursor, signal)}
        variant="mine"
        emptyTitle="You have no claims yet."
        emptyHint={
          <MuiLink component={RouterLink} to="/claims/new">
            Create your first claim
          </MuiLink>
        }
      />
    </>
  );
}

/**
 * Creates a draft, then opens its claim page, where the receipt is attached
 * and the claim is submitted.
 */
export function NewClaimPage() {
  const navigate = useNavigate();
  const categories = useResource((signal) => api.listCategories(signal), []);

  async function create(values: ClaimFormSubmission) {
    const body = Object.fromEntries(
      Object.entries(values).filter(([, value]) => value !== null),
    ) as CreateClaimRequest;
    const claim = await api.createClaim(body);
    void navigate(`/claims/${claim.claimId}`);
  }

  return (
    <>
      <PageHeader title="New claim" />
      <Box sx={{ maxWidth: 720 }}>
        {categories.state === 'loading' && <Loading />}
        {categories.state === 'error' && (
          <ErrorNotice error={categories.error} onReload={categories.reload} />
        )}
        {categories.state === 'ready' && (
          <Section id="new-claim" title="Claim details">
            <ClaimForm
              categories={categories.data}
              submitLabel="Save draft"
              onSubmit={create}
              onCancel={() => void navigate('/claims')}
            />
          </Section>
        )}
      </Box>
    </>
  );
}

/**
 * One claim page for every status. `/claims/:id/edit` is the same page with
 * the draft's details open for editing, so it keeps working as a link and the
 * browser's Back button leaves editing.
 */
export function ClaimDetailPage() {
  const editRequested = useMatch('/claims/:claimId/edit') !== null;
  return (
    <RequireRole
      role="EMPLOYEE"
      enforce={editRequested}
      page={<ClaimWorkspace editRequested={editRequested} />}
    />
  );
}

function ClaimWorkspace({
  editRequested,
}: {
  readonly editRequested: boolean;
}) {
  const { claimId = '' } = useParams();
  const claim = useResource(
    (signal) => api.getClaim(claimId, signal),
    [claimId],
  );

  if (claim.state === 'loading') {
    return <Loading label="Loading claim…" />;
  }
  if (claim.state === 'error') {
    return <ErrorNotice error={claim.error} onReload={claim.reload} />;
  }
  return (
    <ClaimDetail
      claim={claim.data}
      editRequested={editRequested}
      onChange={claim.replace}
      onReload={claim.reload}
    />
  );
}

function ClaimDetail({
  claim,
  editRequested,
  onChange,
  onReload,
}: {
  readonly claim: ClaimDto;
  readonly editRequested: boolean;
  readonly onChange: (claim: ClaimDto) => void;
  readonly onReload: () => void;
}) {
  const user = useCurrentUser();
  const navigate = useNavigate();
  const history = useClaimHistory(claim.claimId, claim.version);
  // Reported by the form while it is open: edits that are not saved yet.
  const [unsaved, setUnsaved] = useState(false);
  const isOwner = claim.employee.userId === user.userId;
  const editing = editRequested && claim.permissions.canEdit;
  const claimPath = `/claims/${claim.claimId}`;
  // The next-step and delete controls only exist for some claims and users.
  const hasActions =
    claim.permissions.actions.length > 0 || claim.permissions.canDelete;

  return (
    <>
      <PageHeader
        title={claim.merchant ?? 'Untitled claim'}
        subtitle={`${
          isOwner ? 'Your claim' : `Claim by ${claim.employee.displayName}`
        } · ${nextStepText(claim)}`}
        status={<StatusChip status={claim.status} />}
        actions={
          claim.permissions.canEdit && !editing ? (
            <Button
              component={RouterLink}
              to={`${claimPath}/edit`}
              variant="outlined"
            >
              Edit draft
            </Button>
          ) : undefined
        }
      />

      <Stack spacing={2}>
        {editRequested && !claim.permissions.canEdit && (
          <Alert severity="error">
            This claim can no longer be edited.{' '}
            <MuiLink component={RouterLink} to={claimPath}>
              Back to the claim
            </MuiLink>
          </Alert>
        )}
        <RejectionNotice claim={claim} history={history} />

        {/* One column on narrow screens in reading order: details, receipt,
            the decision or next step, then history. With room, the decision
            and next-step controls move to a side column. */}
        <Box
          sx={{
            display: 'grid',
            gap: 2,
            alignItems: 'start',
            gridTemplateColumns: {
              xs: 'minmax(0, 1fr)',
              md: hasActions
                ? 'minmax(0, 2fr) minmax(0, 1fr)'
                : 'minmax(0, 1fr)',
            },
            gridTemplateAreas: {
              xs: '"details" "receipt" "actions" "history"',
              md: hasActions
                ? '"details actions" "receipt actions" "history actions"'
                : '"details" "receipt" "history"',
            },
          }}
        >
          <Box sx={{ gridArea: 'details', minWidth: 0 }}>
            {editing ? (
              <Section id="details" title="Details">
                <ClaimEditor
                  claim={claim}
                  onSaved={(saved) => {
                    onChange(saved);
                    void navigate(claimPath);
                  }}
                  onCancel={() => void navigate(claimPath)}
                  onReload={onReload}
                  onDirtyChange={setUnsaved}
                />
              </Section>
            ) : (
              <ClaimDetails claim={claim} />
            )}
          </Box>
          <Box sx={{ gridArea: 'receipt', minWidth: 0 }}>
            <ReceiptPanel
              claim={claim}
              onChange={onChange}
              onReload={onReload}
            />
          </Box>
          {hasActions && (
            <Stack spacing={2} sx={{ gridArea: 'actions', minWidth: 0 }}>
              <ClaimActions
                claim={claim}
                onChange={onChange}
                onReload={onReload}
                submitBlockedReason={unsaved ? unsavedReason : undefined}
              />
              <DeleteDraft claim={claim} onReload={onReload} />
            </Stack>
          )}
          <Box sx={{ gridArea: 'history', minWidth: 0 }}>
            <HistoryCard history={history} />
          </Box>
        </Box>
      </Stack>
    </>
  );
}
