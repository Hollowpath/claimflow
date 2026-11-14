import Alert from '@mui/material/Alert';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Container from '@mui/material/Container';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link as RouterLink, useLocation, useNavigate } from 'react-router';

import { roleLabels } from '../lib/format';
import { toApiError } from '../lib/use-resource';
import { useSession } from '../session';
import { ColorModeButton } from '../ui/color-mode-button';
import { SelectField } from '../ui/fields';
import { MainNav, NavItem, SkipLink } from '../ui/navigation';
import { ErrorNotice } from './ui';
import type { ApiError } from '../api/client';

export function Layout({ children }: { readonly children: ReactNode }) {
  const { user, hasRole, authMode } = useSession();
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const previousPath = useRef(location.pathname);

  // A new page is announced by moving focus to the main content, as a full
  // page load would. The first render keeps the browser's own focus.
  useEffect(() => {
    if (previousPath.current !== location.pathname) {
      previousPath.current = location.pathname;
      mainRef.current?.focus({ preventScroll: true });
    }
  }, [location.pathname]);

  return (
    <>
      <SkipLink targetId="main" />
      {authMode === 'local' && (
        <Alert severity="warning" role="note" sx={{ borderRadius: 0 }}>
          Development sign-in: any sample user can be selected without a
          password. Not for real data.
        </Alert>
      )}
      <AppBar
        position="static"
        color="default"
        elevation={0}
        sx={{ borderBottom: 1, borderColor: 'divider' }}
      >
        <Toolbar sx={{ flexWrap: 'wrap', columnGap: 3, rowGap: 1, py: 1 }}>
          <Link
            component={RouterLink}
            to="/"
            underline="none"
            color="inherit"
            sx={{ fontWeight: 700, fontSize: '1.25rem' }}
          >
            ClaimFlow
          </Link>
          {user !== null && (
            <MainNav>
              {hasRole('EMPLOYEE') && (
                <NavItem to="/claims" end>
                  My claims
                </NavItem>
              )}
              {hasRole('MANAGER') && (
                <NavItem to="/review">Review queue</NavItem>
              )}
              {hasRole('ADMIN') && (
                <>
                  <NavItem to="/admin/claims">All claims</NavItem>
                  <NavItem to="/admin/categories">Categories</NavItem>
                </>
              )}
            </MainNav>
          )}
          <Box sx={{ ml: { sm: 'auto' } }}>
            <ColorModeButton />
          </Box>
          <Box sx={{ width: { xs: '100%', sm: 'auto' } }}>
            {authMode === 'cognito' ? <AccountMenu /> : <UserSwitcher />}
          </Box>
        </Toolbar>
      </AppBar>
      <Box
        component="main"
        id="main"
        tabIndex={-1}
        ref={mainRef}
        sx={{ outline: 'none' }}
      >
        <Container maxWidth="lg" sx={{ py: 3 }}>
          {children}
        </Container>
      </Box>
    </>
  );
}

function AccountMenu() {
  const { user, signOut } = useSession();
  if (user === null) {
    return null;
  }
  return (
    <Stack
      direction="row"
      spacing={2}
      useFlexGap
      sx={{ alignItems: 'center', justifyContent: { sm: 'flex-end' } }}
    >
      <Typography variant="body2">{user.displayName}</Typography>
      <Button variant="outlined" size="small" onClick={() => void signOut()}>
        Sign out
      </Button>
    </Stack>
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
    <Stack spacing={1}>
      <Box sx={{ minWidth: { sm: 300 } }}>
        <SelectField
          id="user-switcher"
          label="Signed in as"
          size="small"
          value={user?.userId ?? ''}
          disabled={switching}
          onChange={(userId) => void choose(userId)}
        >
          <option value="">Nobody (signed out)</option>
          {session.users.map((u) => (
            <option key={u.userId} value={u.userId}>
              {u.displayName} — {u.roles.map((r) => roleLabels[r]).join(', ')}
            </option>
          ))}
        </SelectField>
      </Box>
      {error !== null && <ErrorNotice error={error} />}
    </Stack>
  );
}
