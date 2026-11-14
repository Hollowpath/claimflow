import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import CardContent from '@mui/material/CardContent';
import Container from '@mui/material/Container';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import { Navigate, Route, Routes } from 'react-router';

import { Layout } from './components/layout';
import { RequireRole, StartPageLink } from './components/require-role';
import { EmptyState, ErrorNotice, Loading } from './components/ui';
import { roleLabels } from './lib/format';
import { CategoriesPage } from './pages/categories-page';
import {
  ClaimDetailPage,
  MyClaimsPage,
  NewClaimPage,
} from './pages/claim-pages';
import { AdminClaimsPage, ReviewQueuePage } from './pages/review-pages';
import { SessionProvider, useSession } from './session';
import { AppProviders } from './ui/providers';

/** Render inside a router: the toasts it provides are cleared on navigation. */
export function App() {
  return (
    <AppProviders>
      <SessionProvider
        loading={<Loading label="Starting ClaimFlow…" />}
        failed={(error, retry) => (
          <Container component="main" maxWidth="lg" sx={{ py: 3 }}>
            <ErrorNotice error={error} onReload={retry} />
          </Container>
        )}
      >
        <Layout>
          <SignedInRoutes />
        </Layout>
      </SessionProvider>
    </AppProviders>
  );
}

function SignedInRoutes() {
  const { user, authMode } = useSession();
  if (user === null) {
    return authMode === 'cognito' ? <SignIn /> : <ChooseUser />;
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
      {/* One route for the claim page and its edit link, so opening or
          leaving edit mode never remounts the page. */}
      <Route path="/claims/:claimId/edit?" element={<ClaimDetailPage />} />
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
            <StartPageLink />
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

function SignIn() {
  const { authError, signIn } = useSession();
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setError(null);
    try {
      await signIn();
    } catch {
      setError('Sign-in could not be started. Please try again.');
    }
  }

  const message = error ?? authError;
  return (
    <Card variant="outlined" sx={{ maxWidth: 480, mx: 'auto' }}>
      <CardContent>
        <Stack spacing={2}>
          <Typography variant="h5" component="h1">
            Sign in to ClaimFlow
          </Typography>
          <Typography sx={{ color: 'text.secondary' }}>
            You sign in on the secure ClaimFlow sign-in page and come back here.
          </Typography>
          {message !== null && <Alert severity="error">{message}</Alert>}
          <Box>
            <Button variant="contained" onClick={() => void start()}>
              Sign in
            </Button>
          </Box>
        </Stack>
      </CardContent>
    </Card>
  );
}

function ChooseUser() {
  const { session, selectUser, switching } = useSession();
  return (
    <Stack spacing={2}>
      <Typography variant="h5" component="h1">
        Choose a local user
      </Typography>
      <Typography sx={{ color: 'text.secondary' }}>
        This development environment uses sample users instead of passwords.
        Choose one to work in ClaimFlow with that person&apos;s role. You can
        switch at any time from the header.
      </Typography>
      <Box
        component="ul"
        sx={{
          display: 'grid',
          gridTemplateColumns: {
            xs: '1fr',
            sm: 'repeat(2, 1fr)',
            md: 'repeat(3, 1fr)',
          },
          gap: 2,
          listStyle: 'none',
          m: 0,
          p: 0,
        }}
      >
        {session.users.map((user) => (
          <li key={user.userId}>
            <Card variant="outlined" sx={{ height: 1 }}>
              <CardActionArea
                disabled={switching}
                onClick={() => void selectUser(user.userId)}
                sx={{ height: 1, p: 2, textAlign: 'left' }}
              >
                <Typography sx={{ fontWeight: 600 }}>
                  {user.displayName}
                </Typography>
                <Typography variant="body2">{user.title}</Typography>
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                  {user.roles.map((r) => roleLabels[r]).join(', ')}
                </Typography>
              </CardActionArea>
            </Card>
          </li>
        ))}
      </Box>
    </Stack>
  );
}
