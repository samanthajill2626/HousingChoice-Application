// The route table. Every path is pre-wired here so the app compiles and every
// route renders; the screens themselves are owned by the feature agents (the
// placeholder files under src/routes/). Auth-gating: this <AppRouter> is only
// rendered for an AUTHENTICATED session (App.tsx shows Login otherwise), so the
// inbox/thread/quick-reply routes need no extra auth guard; the admin routes are
// wrapped in <RequireAdmin>.
//
// Routes:
//   /                       → Inbox            (Feature Agent 1)
//   /conversations/:id      → Thread           (Feature Agent 2)
//   /admin/users            → AdminUsers        (Feature Agent 3, admin)
//   /settings               → Settings          (Feature Agent 3, admin)
//   /quick-reply/:callId    → QuickReply         (Feature Agent 4)
//   *                       → NotFound           (foundation)
import { Route, Routes } from 'react-router-dom';
import { AppLayout } from './AppLayout.js';
import { RequireAdmin } from './guards.js';
import Inbox from '../routes/Inbox.js';
import Thread from '../routes/Thread.js';
import AdminUsers from '../routes/AdminUsers.js';
import Settings from '../routes/Settings.js';
import QuickReply from '../routes/QuickReply.js';
import NotFound from '../routes/NotFound.js';

export function AppRouter(): React.JSX.Element {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<Inbox />} />
        <Route path="conversations/:id" element={<Thread />} />
        <Route
          path="admin/users"
          element={
            <RequireAdmin>
              <AdminUsers />
            </RequireAdmin>
          }
        />
        <Route
          path="settings"
          element={
            <RequireAdmin>
              <Settings />
            </RequireAdmin>
          }
        />
        <Route path="quick-reply/:callId" element={<QuickReply />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
