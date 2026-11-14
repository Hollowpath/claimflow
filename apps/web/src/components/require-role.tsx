import type { Role } from '@claimflow/contracts';
import Link from '@mui/material/Link';
import type { ReactNode } from 'react';
import { Link as RouterLink } from 'react-router';

import { roleLabels } from '../lib/format';
import { useSession } from '../session';
import { EmptyState } from './ui';

export function StartPageLink() {
  return (
    <Link component={RouterLink} to="/">
      Go to your start page
    </Link>
  );
}

/**
 * Navigation convenience only; the API enforces every permission. With
 * `enforce` off the page is shown to everyone, so one route can ask for a role
 * only for part of its behaviour without remounting the page.
 */
export function RequireRole({
  role,
  page,
  enforce = true,
}: {
  readonly role: Role;
  readonly page: ReactNode;
  readonly enforce?: boolean;
}) {
  const { hasRole } = useSession();
  return !enforce || hasRole(role) ? (
    page
  ) : (
    <EmptyState title={`This page is for the ${roleLabels[role]} role.`}>
      <StartPageLink />
    </EmptyState>
  );
}
