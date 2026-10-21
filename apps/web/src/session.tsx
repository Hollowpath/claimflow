import type { CurrentUserDto, Role, SessionDto } from '@claimflow/contracts';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router';

import { setUnauthenticatedListener, type ApiError } from './api/client';
import { api } from './api/claimflow';
import { AuthError, getAuth } from './auth';
import { authCallbackPath } from './config';
import { toApiError } from './lib/use-resource';

interface SessionContextValue {
  readonly session: SessionDto;
  readonly user: CurrentUserDto | null;
  readonly switching: boolean;
  /** `cognito` when users sign in through the hosted UI, else sample users. */
  readonly authMode: 'local' | 'cognito';
  /** Why the last hosted UI sign-in did not complete, if it did not. */
  readonly authError: string | null;
  readonly selectUser: (userId: string) => Promise<void>;
  readonly signIn: () => Promise<void>;
  readonly signOut: () => Promise<void>;
  readonly hasRole: (role: Role) => boolean;
}

const SessionContext = createContext<SessionContextValue | null>(null);

type State =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly error: ApiError }
  | {
      readonly status: 'ready';
      readonly session: SessionDto;
      readonly authError: string | null;
    };

const signedOutSession: SessionDto = { user: null, users: [] };

export function SessionProvider({
  children,
  loading,
  failed,
}: {
  readonly children: ReactNode;
  readonly loading: ReactNode;
  readonly failed: (error: ApiError, retry: () => void) => ReactNode;
}) {
  const auth = getAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // Only the address the page was opened with matters for the sign-in redirect.
  const [openedAt] = useState(location);
  // navigate changes with every location; the sign-in effect must run once.
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);
  const [state, setState] = useState<State>({ status: 'loading' });
  const [switching, setSwitching] = useState(false);

  const load = useCallback(
    () =>
      api.getSession().then(
        (session) => setState({ status: 'ready', session, authError: null }),
        (error: unknown) => {
          const apiError = toApiError(error);
          // Rejected Cognito authentication (tokens already cleared) is a
          // sign-in screen, not an API failure.
          if (auth !== null && apiError.code === 'UNAUTHENTICATED') {
            setState({
              status: 'ready',
              session: signedOutSession,
              authError: apiError.message,
            });
            return;
          }
          setState({ status: 'error', error: apiError });
        },
      ),
    [auth],
  );

  const retry = useCallback(() => {
    setState({ status: 'loading' });
    void load();
  }, [load]);

  useEffect(() => {
    setUnauthenticatedListener(() => {
      setState((current) =>
        current.status === 'ready'
          ? { ...current, session: { ...current.session, user: null } }
          : current,
      );
    });
    if (auth === null) {
      void load();
      return;
    }
    void (async () => {
      let authError: string | null = null;
      if (openedAt.pathname === authCallbackPath) {
        try {
          await auth.completeSignIn(openedAt.search);
        } catch (error) {
          authError =
            error instanceof AuthError
              ? error.message
              : 'Sign-in failed. Please try again.';
        }
        // The code and state are spent; keep them out of the address bar.
        void navigateRef.current('/', { replace: true });
      }
      if (auth.isSignedIn()) {
        await load();
      } else {
        setState({ status: 'ready', session: signedOutSession, authError });
      }
    })();
  }, [auth, load, openedAt]);

  const selectUser = useCallback(async (userId: string) => {
    setSwitching(true);
    try {
      const session = await api.selectUser(userId);
      setState({ status: 'ready', session, authError: null });
    } finally {
      setSwitching(false);
    }
  }, []);

  const signIn = useCallback(async () => {
    await auth?.beginSignIn();
  }, [auth]);

  const signOut = useCallback(async () => {
    if (auth !== null) {
      auth.signOut();
      setState({
        status: 'ready',
        session: signedOutSession,
        authError: null,
      });
      return;
    }
    const session = await api.signOut();
    setState({ status: 'ready', session, authError: null });
  }, [auth]);

  const value = useMemo((): SessionContextValue | null => {
    if (state.status !== 'ready') {
      return null;
    }
    const { user } = state.session;
    return {
      session: state.session,
      user,
      switching,
      authMode: auth === null ? 'local' : 'cognito',
      authError: state.authError,
      selectUser,
      signIn,
      signOut,
      hasRole: (role) => user?.roles.includes(role) ?? false,
    };
  }, [state, switching, auth, selectUser, signIn, signOut]);

  if (state.status === 'loading') {
    return loading;
  }
  if (state.status === 'error') {
    return failed(state.error, retry);
  }
  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === null) {
    throw new Error('useSession must be used inside SessionProvider.');
  }
  return value;
}

/** The signed-in user; only for components rendered after sign-in. */
export function useCurrentUser(): CurrentUserDto {
  const { user } = useSession();
  if (user === null) {
    throw new Error('No user is signed in.');
  }
  return user;
}
