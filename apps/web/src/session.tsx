import type { CurrentUserDto, Role, SessionDto } from '@claimflow/contracts';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { setUnauthenticatedListener, type ApiError } from './api/client';
import { api } from './api/claimflow';
import { toApiError } from './lib/use-resource';

interface SessionContextValue {
  readonly session: SessionDto;
  readonly user: CurrentUserDto | null;
  readonly switching: boolean;
  readonly selectUser: (userId: string) => Promise<void>;
  readonly signOut: () => Promise<void>;
  readonly hasRole: (role: Role) => boolean;
}

const SessionContext = createContext<SessionContextValue | null>(null);

type State =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly error: ApiError }
  | { readonly status: 'ready'; readonly session: SessionDto };

export function SessionProvider({
  children,
  loading,
  failed,
}: {
  readonly children: ReactNode;
  readonly loading: ReactNode;
  readonly failed: (error: ApiError, retry: () => void) => ReactNode;
}) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [switching, setSwitching] = useState(false);

  const load = useCallback(
    () =>
      api.getSession().then(
        (session) => setState({ status: 'ready', session }),
        (error: unknown) =>
          setState({ status: 'error', error: toApiError(error) }),
      ),
    [],
  );

  const retry = useCallback(() => {
    setState({ status: 'loading' });
    void load();
  }, [load]);

  useEffect(() => {
    void load();
    setUnauthenticatedListener(() => {
      setState((current) =>
        current.status === 'ready'
          ? { ...current, session: { ...current.session, user: null } }
          : current,
      );
    });
  }, [load]);

  const selectUser = useCallback(async (userId: string) => {
    setSwitching(true);
    try {
      const session = await api.selectUser(userId);
      setState({ status: 'ready', session });
    } finally {
      setSwitching(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    const session = await api.signOut();
    setState({ status: 'ready', session });
  }, []);

  const value = useMemo((): SessionContextValue | null => {
    if (state.status !== 'ready') {
      return null;
    }
    const { user } = state.session;
    return {
      session: state.session,
      user,
      switching,
      selectUser,
      signOut,
      hasRole: (role) => user?.roles.includes(role) ?? false,
    };
  }, [state, switching, selectUser, signOut]);

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
