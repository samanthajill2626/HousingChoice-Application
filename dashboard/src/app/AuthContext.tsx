// AuthContext — the app-wide session. Bootstraps GET /auth/me on mount into one
// of three states (loading | anonymous | authenticated) and exposes { me,
// refresh }. The shell uses `status` to pick Login vs the AppFrame; components
// read `me` (and `isAdmin`) and call `refresh()` after login/logout/role change.
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError, getMe, type Me } from '../api/index.js';

export type AuthStatus = 'loading' | 'anonymous' | 'authenticated';

export interface AuthState {
  status: AuthStatus;
  /** The principal when authenticated; undefined otherwise. */
  me: Me | undefined;
  /** Convenience: me?.role === 'admin'. */
  isAdmin: boolean;
  /** Re-probe /auth/me (after login, logout, or a role change). */
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [me, setMe] = useState<Me | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const principal = await getMe();
      setMe(principal);
      setStatus('authenticated');
    } catch (err) {
      // 401 = anonymous (expected); any other error also lands us anonymous so
      // the shell shows Login rather than a spinner forever.
      if (!(err instanceof ApiError)) {
        // Non-ApiError (shouldn't happen) — still resolve to anonymous.
      }
      setMe(undefined);
      setStatus('anonymous');
    }
  }, []);

  useEffect(() => {
    // refresh sets state only AFTER an await (the /me probe) — a bootstrap
    // fetch-on-mount, not the synchronous cascading-render case the rule targets.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  return (
    <AuthContext.Provider value={{ status, me, isAdmin: me?.role === 'admin', refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (ctx === undefined) {
    throw new Error('useAuth must be used within an <AuthProvider>');
  }
  return ctx;
}
