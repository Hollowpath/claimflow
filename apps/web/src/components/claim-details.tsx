import type { ClaimDto } from '@claimflow/contracts';

import { formatDate, formatDateTime } from '../lib/format';
import { formatMoney } from '../lib/money';
import { DetailItem, DetailList, Section } from '../ui/section';

const none = '—';

/** The claim's facts, read-only. Editing stays on the edit page for now. */
export function ClaimDetails({ claim }: { readonly claim: ClaimDto }) {
  return (
    <Section id="details" title="Details">
      <DetailList>
        <DetailItem label="Amount">
          {claim.amount === undefined
            ? none
            : formatMoney(claim.amount.amountMinor, claim.amount.currency)}
        </DetailItem>
        <DetailItem label="Category">{claim.categoryName ?? none}</DetailItem>
        <DetailItem label="Expense date">
          {claim.expenseDate === undefined
            ? none
            : formatDate(claim.expenseDate)}
        </DetailItem>
        <DetailItem label="Merchant">{claim.merchant ?? none}</DetailItem>
        <DetailItem label="Business purpose">
          <span style={{ whiteSpace: 'pre-wrap' }}>
            {claim.businessPurpose ?? none}
          </span>
        </DetailItem>
        <DetailItem label="Employee">{claim.employee.displayName}</DetailItem>
        <DetailItem label="Reviewer">
          {claim.assignedManager?.displayName ?? 'Assigned on submission'}
        </DetailItem>
        {claim.submittedAt !== undefined && (
          <DetailItem label="Submitted">
            {formatDateTime(claim.submittedAt)}
          </DetailItem>
        )}
        {claim.reviewedAt !== undefined && (
          <DetailItem label="Decided">
            {formatDateTime(claim.reviewedAt)}
          </DetailItem>
        )}
      </DetailList>
    </Section>
  );
}
