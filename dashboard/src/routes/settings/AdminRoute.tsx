// AdminRoute — a route guard for the admin-only Settings sections (Team, System
// status). Security, not just hidden chrome: a VA navigating directly to a
// guarded path is redirected to the default VA tab. Renders its children only
// when the viewer is an admin.
import { Navigate } from 'react-router-dom';
import { useAuth } from '../../app/AuthContext.js';
import { VA_DEFAULT_TAB_PATH } from './settingsTabs.js';

export function AdminRoute({ children }: { children: React.JSX.Element }): React.JSX.Element {
  const { isAdmin } = useAuth();
  return isAdmin ? children : <Navigate to={VA_DEFAULT_TAB_PATH} replace />;
}
