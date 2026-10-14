import { useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router';

import { roleLabels } from '../lib/format';
import { toApiError } from '../lib/use-resource';
import { useSession } from '../session';
import { ErrorNotice } from './ui';
import type { ApiError } from '../api/client';

export function Layout({ children }: { readonly children: ReactNode }) {
  const { user, hasRole } = useSession();

  return (
    <div className="app">
      <div className="sim-banner" role="note">
        Development sign-in: any sample user can be selected without a password.
        Not for real data.
      </div>
      <header className="topbar">
        <div className="topbar-inner">
          <NavLink to="/" className="brand">
            <span className="brand-mark" aria-hidden="true">
              ✓
            </span>
            ClaimFlow
          </NavLink>
          {user !== null && (
            <nav aria-label="Main" className="nav">
              {hasRole('EMPLOYEE') && (
                <>
                  <NavLink to="/claims" end>
                    My claims
                  </NavLink>
                  <NavLink to="/claims/new">New claim</NavLink>
                </>
              )}
              {hasRole('MANAGER') && (
                <NavLink to="/review">Review queue</NavLink>
              )}
              {hasRole('ADMIN') && (
                <>
                  <NavLink to="/admin/claims">All claims</NavLink>
                  <NavLink to="/admin/categories">Categories</NavLink>
                </>
              )}
            </nav>
          )}
          <UserSwitcher />
        </div>
      </header>
      <main className="content">{children}</main>
    </div>
  );
}

function UserSwitcher() {
  const { session, user, switching, selectUser, signOut } = useSession();
  const navigate = useNavigate();
  const [error, setError] = useState<ApiError | null>(null);

  async function choose(userId: string) {
    setError(null);
    try {
      if (userId === '') {
        await signOut();
      } else {
        await selectUser(userId);
      }
      void navigate('/');
    } catch (caught) {
      setError(toApiError(caught));
    }
  }

  return (
    <div className="user-switcher">
      <label htmlFor="user-switcher">Signed in as</label>
      <select
        id="user-switcher"
        value={user?.userId ?? ''}
        disabled={switching}
        onChange={(event) => void choose(event.target.value)}
      >
        <option value="">Nobody (signed out)</option>
        {session.users.map((u) => (
          <option key={u.userId} value={u.userId}>
            {u.displayName} — {u.roles.map((r) => roleLabels[r]).join(', ')}
          </option>
        ))}
      </select>
      {error !== null && <ErrorNotice error={error} />}
    </div>
  );
}
