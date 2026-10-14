import type { Role } from '@claimflow/contracts';
import type { ReactNode } from 'react';
import { Link, Navigate, Route, Routes } from 'react-router';

import { Layout } from './components/layout';
import { EmptyState, ErrorNotice, Loading } from './components/ui';
import { roleLabels } from './lib/format';
import { CategoriesPage } from './pages/categories-page';
import {
  ClaimDetailPage,
  EditClaimPage,
  MyClaimsPage,
  NewClaimPage,
} from './pages/claim-pages';
import { AdminClaimsPage, ReviewQueuePage } from './pages/review-pages';
import { SessionProvider, useSession } from './session';

export function App() {
  return (
    <SessionProvider
      loading={<Loading label="Starting ClaimFlow…" />}
      failed={(error, retry) => (
        <main className="content">
          <ErrorNotice error={error} onReload={retry} />
        </main>
      )}
    >
      <Layout>
        <SignedInRoutes />
      </Layout>
    </SessionProvider>
  );
}

function SignedInRoutes() {
  const { user } = useSession();
  if (user === null) {
    return <ChooseUser />;
  }

  // Keyed by user so switching users remounts every page and drops their data.
  return (
    <Routes key={user.userId}>
      <Route path="/" element={<Home />} />
      <Route
        path="/claims"
        element={<RequireRole role="EMPLOYEE" page={<MyClaimsPage />} />}
      />
      <Route
        path="/claims/new"
        element={<RequireRole role="EMPLOYEE" page={<NewClaimPage />} />}
      />
      <Route path="/claims/:claimId" element={<ClaimDetailPage />} />
      <Route
        path="/claims/:claimId/edit"
        element={<RequireRole role="EMPLOYEE" page={<EditClaimPage />} />}
      />
      <Route
        path="/review"
        element={<RequireRole role="MANAGER" page={<ReviewQueuePage />} />}
      />
      <Route
        path="/admin/claims"
        element={<RequireRole role="ADMIN" page={<AdminClaimsPage />} />}
      />
      <Route
        path="/admin/categories"
        element={<RequireRole role="ADMIN" page={<CategoriesPage />} />}
      />
      <Route
        path="*"
        element={
          <EmptyState title="Page not found.">
            <Link to="/">Go to your start page</Link>
          </EmptyState>
        }
      />
    </Routes>
  );
}

function Home() {
  const { hasRole } = useSession();
  if (hasRole('EMPLOYEE')) {
    return <Navigate to="/claims" replace />;
  }
  if (hasRole('MANAGER')) {
    return <Navigate to="/review" replace />;
  }
  if (hasRole('ADMIN')) {
    return <Navigate to="/admin/claims" replace />;
  }
  return <EmptyState title="Your account has no roles." />;
}

/** Navigation convenience only; the API enforces every permission. */
function RequireRole({
  role,
  page,
}: {
  readonly role: Role;
  readonly page: ReactNode;
}) {
  const { hasRole } = useSession();
  return hasRole(role) ? (
    page
  ) : (
    <EmptyState title={`This page is for the ${roleLabels[role]} role.`}>
      <Link to="/">Go to your start page</Link>
    </EmptyState>
  );
}

function ChooseUser() {
  const { session, selectUser, switching } = useSession();
  return (
    <section className="choose-user">
      <h1>Choose a local user</h1>
      <p className="muted">
        This development environment uses sample users instead of passwords.
        Choose one to work in ClaimFlow with that person&apos;s role. You can
        switch at any time from the header.
      </p>
      <ul className="user-cards">
        {session.users.map((user) => (
          <li key={user.userId}>
            <button
              type="button"
              className="user-card"
              disabled={switching}
              onClick={() => void selectUser(user.userId)}
            >
              <strong>{user.displayName}</strong>
              <span>{user.title}</span>
              <span className="muted">
                {user.roles.map((r) => roleLabels[r]).join(', ')}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
