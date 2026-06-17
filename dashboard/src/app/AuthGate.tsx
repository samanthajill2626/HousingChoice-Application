// AuthGate — the session switch. While the /auth/me probe is in flight it shows
// a centered spinner; anonymous → the Login screen; authenticated → children
// (the AppFrame + routes). Lives between AuthProvider and the app so every
// authenticated surface can assume a logged-in principal.
import type { ReactNode } from 'react';
import { Spinner } from '../ui/index.js';
import Login from '../routes/Login.js';
import { useAuth } from './AuthContext.js';

export function AuthGate({ children }: { children: ReactNode }): React.JSX.Element {
  const { status } = useAuth();

  if (status === 'loading') {
    return <Spinner center label="Loading your workspace" />;
  }
  if (status === 'anonymous') {
    return <Login />;
  }
  return <>{children}</>;
}
