// The AUTHENTICATED route table. This <AppRouter> is only rendered for an
// authenticated session (App.tsx's Gate shows Login otherwise), so the
// inbox/thread/quick-reply/records routes need no extra auth guard; the admin
// routes are wrapped in <RequireAdmin>. The two PUBLIC routes (/flyer/:unitId,
// /housing-fair) live ABOVE this in App.tsx — they are NOT in this table, so
// they never sit behind the auth gate.
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
import Contacts from '../routes/Contacts.js';
import ContactDetail from '../routes/ContactDetail.js';
import ContactNew from '../routes/ContactNew.js';
import Units from '../routes/Units.js';
import UnitDetail from '../routes/UnitDetail.js';
import UnitForm from '../routes/UnitForm.js';
import NewRelayGroup from '../routes/NewRelayGroup.js';
import BroadcastResults from '../routes/broadcast/BroadcastResults.js';

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

          {/* Relay groups (M1.7) — create a new masked group thread. */}
          <Route path="relay-groups/new" element={<NewRelayGroup />} />

          {/* Records — Contacts (M1.5). new BEFORE :contactId so "new" is not
           *  swallowed as an id. */}
          <Route path="contacts" element={<Contacts />} />
          <Route path="contacts/new" element={<ContactNew />} />
          <Route path="contacts/:contactId" element={<ContactDetail />} />

          {/* Records — Properties / units (M1.5). */}
          <Route path="units" element={<Units />} />
          <Route path="units/new" element={<UnitForm />} />
          <Route path="units/:unitId" element={<UnitDetail />} />
          <Route path="units/:unitId/edit" element={<UnitForm />} />

          {/* Share Properties broadcast (M1.8) — the live results view. */}
          <Route path="broadcasts/:id" element={<BroadcastResults />} />

          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>
    </Routes>
  );
}
