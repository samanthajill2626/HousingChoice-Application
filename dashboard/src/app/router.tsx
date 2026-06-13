// The route table. Every path is pre-wired here so the app compiles and every
// route renders; the screens themselves are owned by the feature agents (the
// placeholder files under src/routes/). Auth-gating: this <AppRouter> is only
// rendered for an AUTHENTICATED session (App.tsx shows Login otherwise), so the
// inbox/thread/quick-reply routes need no extra auth guard; the admin routes are
// wrapped in <RequireAdmin>.
//
// Layout nesting (M1.4 responsive layout):
//   <AppLayout>  topbar + (mobile) tabbar; full-height content area
//     <HubLayout>     full-bleed two-pane conversation hub (list + thread)
//       /                    → Inbox list (left); empty thread pane (right, desktop)
//       /conversations/:id   → Thread (right pane on desktop; full-screen on mobile)
//     <NarrowLayout>  centered readable max-width column (--hc-content-max)
//       /admin/users         → AdminUsers   (admin)
//       /settings            → Settings     (admin)
//       /quick-reply/:callId → QuickReply
//       *                    → NotFound
import { Route, Routes } from 'react-router-dom';
import { AppLayout } from './AppLayout.js';
import { HubLayout } from './HubLayout.js';
import { NarrowLayout } from './NarrowLayout.js';
import { RequireAdmin } from './guards.js';
import Thread from '../routes/Thread.js';
import AdminUsers from '../routes/AdminUsers.js';
import Settings from '../routes/Settings.js';
import QuickReply from '../routes/QuickReply.js';
import NotFound from '../routes/NotFound.js';

export function AppRouter(): React.JSX.Element {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        {/* The conversation hub: the list pane is rendered by HubLayout itself
         * (shared across both routes), so the thread route only supplies the
         * thread for the right pane via the nested <Outlet/>. */}
        <Route element={<HubLayout />}>
          <Route index element={null} />
          <Route path="conversations/:id" element={<Thread />} />
        </Route>

        {/* Everything else: a centered readable column. */}
        <Route element={<NarrowLayout />}>
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
      </Route>
    </Routes>
  );
}
