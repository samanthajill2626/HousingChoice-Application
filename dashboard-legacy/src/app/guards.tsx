// Route guards. RequireAdmin gates the admin-only screens (Users, Settings): a
// non-admin sees a clear "not authorized" view rather than a blank or a
// redirect-loop. Authentication itself is handled one level up (App.tsx renders
// the Login screen for anonymous sessions), so these guards assume an
// authenticated session and only check role.
import type { ReactNode } from 'react';
import { EmptyState } from '../ui/index.js';
import { useAuth } from './AuthContext.js';

export function RequireAdmin({ children }: { children: ReactNode }): React.JSX.Element {
  const { isAdmin } = useAuth();
  if (!isAdmin) {
    return (
      <EmptyState
        title="Not authorized"
        description="This area is for admins only. Ask an admin if you need access."
      />
    );
  }
  return <>{children}</>;
}
