import type { ClaimDto, CreateClaimRequest } from '@claimflow/contracts';
import { Link, useNavigate, useParams } from 'react-router';

import { api } from '../api/claimflow';
import { ClaimActions } from '../components/claim-actions';
import { ClaimForm, type ClaimFormSubmission } from '../components/claim-form';
import { ClaimList } from '../components/claim-list';
import { DeleteDraft } from '../components/delete-draft';
import { HistoryTimeline } from '../components/history-timeline';
import { ReceiptPanel } from '../components/receipt-panel';
import { ErrorNotice, Loading, StatusBadge } from '../components/ui';
import { formatDate, formatDateTime } from '../lib/format';
import { formatMoney } from '../lib/money';
import { useResource } from '../lib/use-resource';
import { useCurrentUser } from '../session';

export function MyClaimsPage() {
  return (
    <>
      <div className="page-head">
        <h1>My claims</h1>
        <Link to="/claims/new" className="button">
          New claim
        </Link>
      </div>
      <ClaimList
        load={(cursor, signal) => api.listMyClaims(cursor, signal)}
        emptyTitle="You have no claims yet."
        emptyHint={<Link to="/claims/new">Create your first claim</Link>}
      />
    </>
  );
}

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
      <h1>New claim</h1>
      {categories.state === 'loading' && <Loading />}
      {categories.state === 'error' && (
        <ErrorNotice error={categories.error} onReload={categories.reload} />
      )}
      {categories.state === 'ready' && (
        <ClaimForm
          categories={categories.data}
          submitLabel="Save draft"
          onSubmit={create}
          onCancel={() => void navigate('/claims')}
        />
      )}
    </>
  );
}

export function EditClaimPage() {
  const { claimId = '' } = useParams();
  const navigate = useNavigate();
  const data = useResource(
    async (signal) => {
      const [claim, categories] = await Promise.all([
        api.getClaim(claimId, signal),
        api.listCategories(signal),
      ]);
      return { claim, categories };
    },
    [claimId],
  );

  if (data.state === 'loading') {
    return <Loading label="Loading claim…" />;
  }
  if (data.state === 'error') {
    return <ErrorNotice error={data.error} onReload={data.reload} />;
  }
  const { claim, categories } = data.data;
  if (!claim.permissions.canEdit) {
    return (
      <div className="notice notice-error" role="alert">
        This claim can no longer be edited.{' '}
        <Link to={`/claims/${claim.claimId}`}>Back to the claim</Link>
      </div>
    );
  }

  async function save(values: ClaimFormSubmission) {
    await api.updateClaim(claim.claimId, {
      expectedVersion: claim.version,
      ...values,
    });
    void navigate(`/claims/${claim.claimId}`);
  }

  return (
    <>
      <h1>Edit draft</h1>
      <ClaimForm
        key={claim.version}
        claim={claim}
        categories={categories}
        submitLabel="Save changes"
        onSubmit={save}
        onCancel={() => void navigate(`/claims/${claim.claimId}`)}
      />
      <button type="button" className="link-button" onClick={data.reload}>
        Discard my edits and load the latest version
      </button>
    </>
  );
}

export function ClaimDetailPage() {
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
      onChange={claim.replace}
      onReload={claim.reload}
    />
  );
}

function ClaimDetail({
  claim,
  onChange,
  onReload,
}: {
  readonly claim: ClaimDto;
  readonly onChange: (claim: ClaimDto) => void;
  readonly onReload: () => void;
}) {
  const user = useCurrentUser();
  const isOwner = claim.employee.userId === user.userId;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{claim.merchant ?? 'Untitled claim'}</h1>
          <p className="muted">
            {isOwner ? 'Your claim' : `Claim by ${claim.employee.displayName}`}{' '}
            · version {claim.version}
          </p>
        </div>
        <StatusBadge status={claim.status} />
      </div>

      <div className="detail-grid">
        <div className="detail-main">
          <section className="panel" aria-labelledby="details-heading">
            <div className="panel-head">
              <h2 id="details-heading">Details</h2>
              {claim.permissions.canEdit && (
                <Link
                  to={`/claims/${claim.claimId}/edit`}
                  className="button button-secondary"
                >
                  Edit draft
                </Link>
              )}
            </div>
            <dl className="details">
              <dt>Amount</dt>
              <dd>
                {claim.amount === undefined
                  ? '—'
                  : formatMoney(
                      claim.amount.amountMinor,
                      claim.amount.currency,
                    )}
              </dd>
              <dt>Category</dt>
              <dd>{claim.categoryName ?? '—'}</dd>
              <dt>Expense date</dt>
              <dd>
                {claim.expenseDate === undefined
                  ? '—'
                  : formatDate(claim.expenseDate)}
              </dd>
              <dt>Merchant</dt>
              <dd>{claim.merchant ?? '—'}</dd>
              <dt>Business purpose</dt>
              <dd className="pre-wrap">{claim.businessPurpose ?? '—'}</dd>
              <dt>Employee</dt>
              <dd>{claim.employee.displayName}</dd>
              <dt>Reviewer</dt>
              <dd>
                {claim.assignedManager?.displayName ?? 'Assigned on submission'}
              </dd>
              {claim.submittedAt !== undefined && (
                <>
                  <dt>Submitted</dt>
                  <dd>{formatDateTime(claim.submittedAt)}</dd>
                </>
              )}
              {claim.reviewedAt !== undefined && (
                <>
                  <dt>Decided</dt>
                  <dd>{formatDateTime(claim.reviewedAt)}</dd>
                </>
              )}
            </dl>
          </section>
          <ReceiptPanel claim={claim} onChange={onChange} onReload={onReload} />
          <ClaimActions claim={claim} onChange={onChange} onReload={onReload} />
          <DeleteDraft claim={claim} onReload={onReload} />
        </div>
        <HistoryTimeline claimId={claim.claimId} version={claim.version} />
      </div>
    </>
  );
}
