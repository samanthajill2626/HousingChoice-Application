// App — the root component: the auth session provider + gate, and (when
// authenticated) the AppFrame shell wrapping the routed pages. Most routes are
// still GENERATED from the nav model (allNavTargets) as placeholders so the nav
// links and the routes can never drift apart; the implemented pages (Today, the
// Contacts + Properties list views, and the contact/property detail pages) are
// swapped in explicitly, one destination at a time.
import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './app/AuthContext.js';
import { AuthGate } from './app/AuthGate.js';
import { AppFrame } from './app/AppFrame.js';
import { UnreadProvider } from './app/UnreadContext.js';
import { EventStreamProvider } from './api/index.js';
import { Placeholder } from './routes/Placeholder.js';
import { Today } from './routes/today/Today.js';
import { ContactsList } from './routes/contacts/ContactsList.js';
import { ListingsList } from './routes/listings/ListingsList.js';
import { ContactDetail } from './routes/contact/ContactDetail.js';
import { ListingDetail } from './routes/listing/ListingDetail.js';
import { PlacementsBoard } from './routes/placements/PlacementsBoard.js';
import { PlacementDetail } from './routes/placements/PlacementDetail.js';
import { Inbox } from './routes/inbox/Inbox.js';
import { BroadcastsList } from './routes/broadcasts/BroadcastsList.js';
import { BroadcastComposer } from './routes/broadcasts/BroadcastComposer.js';
import { BroadcastResults } from './routes/broadcasts/BroadcastResults.js';
import { SettingsPage } from './routes/settings/SettingsPage.js';
import { TeamSection } from './routes/settings/TeamSection.js';
import { TemplatesSection } from './routes/settings/TemplatesSection.js';
import { NotificationsSection } from './routes/settings/NotificationsSection.js';
import { VoiceSection } from './routes/settings/VoiceSection.js';
import { SystemStatusSection } from './routes/settings/SystemStatusSection.js';
import { AdminRoute } from './routes/settings/AdminRoute.js';
import { defaultTabPath } from './routes/settings/settingsTabs.js';
import { allNavTargets } from './app/nav.js';
import { PublicLayout } from './routes/public/PublicLayout.js';
import { FlyerFunnel } from './routes/public/FlyerFunnel.js';
import { HousingFairIntake } from './routes/public/HousingFairIntake.js';

/** /settings index → the first tab visible for the viewer's role (admin → Team,
 *  VA → Templates). A tiny component so it can read useAuth inside the routes. */
function SettingsIndexRedirect(): React.JSX.Element {
  const { isAdmin } = useAuth();
  return <Navigate to={defaultTabPath(isAdmin)} replace />;
}

// Nav destinations that now have a REAL page (handled by an explicit <Route>
// below) — excluded from the placeholder generator so they aren't double-mounted.
const IMPLEMENTED = new Set<string>([
  '/',
  '/placements',
  '/contacts',
  '/contacts/tenants',
  '/contacts/landlords',
  '/contacts/unknown',
  '/listings',
  '/inbox',
  // Broadcasts now has a REAL list page + the static composer route (the
  // /broadcasts/:broadcastId Results route is a dynamic <Route> below). Exclude
  // them from the placeholder generator so they aren't double-mounted.
  '/broadcasts',
  '/broadcasts/new',
  // /settings now has a REAL tabbed page (with nested sub-routes below); exclude
  // it from the placeholder generator (allNavTargets includes the footer link).
  '/settings',
]);

/**
 * The PUBLIC, UNAUTHENTICATED surface. These routes render OUTSIDE
 * AuthProvider / AuthGate / EventStreamProvider / AppFrame — they must NEVER
 * trigger the auth gate (no redirect-to-login, no session fetch, no event
 * stream). `/p/:unitId` is what `flyerUrl()` emits, so every shared
 * [FlyerLink] broadcast lands on the funnel teaser. `/join` is the standalone
 * housing-fair intake. The trailing `<Route path="/*">` hands everything else
 * to the authed app.
 */
export default function App(): React.JSX.Element {
  return (
    <Routes>
      <Route
        path="/p/:unitId"
        element={
          <PublicLayout>
            <FlyerFunnel />
          </PublicLayout>
        }
      />
      <Route
        path="/join"
        element={
          <PublicLayout>
            <HousingFairIntake />
          </PublicLayout>
        }
      />
      <Route path="/*" element={<AuthedApp />} />
    </Routes>
  );
}

/**
 * The authenticated app: the session provider + gate, and (when authenticated)
 * the AppFrame shell wrapping the routed pages. Extracted from the former root
 * `App` so the public routes above can be siblings that never mount this tree.
 */
function AuthedApp(): React.JSX.Element {
  return (
    <AuthProvider>
      <AuthGate>
        {/* One shared /api/events connection for every live-update consumer
            below (badge, timeline, mark-read, …). Inside the gate so it only
            runs when authenticated. */}
        <EventStreamProvider>
          <Routes>
          <Route
            element={
              <UnreadProvider>
                <AppFrame />
              </UnreadProvider>
            }
          >
            <Route index element={<Today />} />

            {/* Contacts list views (§IA: Contacts parent ▸ Tenants/Landlords/
                Unknown). One component, route-driven filter. These static paths
                rank above the dynamic contacts/:contactId detail route. */}
            <Route path="contacts" element={<ContactsList filter="all" />} />
            <Route path="contacts/tenants" element={<ContactsList filter="tenant" />} />
            <Route path="contacts/landlords" element={<ContactsList filter="landlord" />} />
            <Route path="contacts/unknown" element={<ContactsList filter="unknown" />} />
            <Route path="contacts/deleted" element={<ContactsList filter="deleted" />} />

            {/* Placement board (§F2). Static — ranks above placements/:placementId. */}
            <Route path="placements" element={<PlacementsBoard />} />
            <Route path="placements/:placementId" element={<PlacementDetail />} />

            {/* Properties list view. Static — ranks above listings/:unitId. */}
            <Route path="listings" element={<ListingsList />} />
            <Route path="listings/deleted" element={<ListingsList deleted />} />

            {/* Communications ▸ Inbox (replaces the generated placeholder). */}
            <Route path="inbox" element={<Inbox />} />

            {/* Communications ▸ Broadcasts (replaces the generated placeholder):
                the list, the composer, and the live Results view. The static
                /broadcasts/new ranks above the dynamic /broadcasts/:broadcastId
                (per the route-ordering convention). */}
            <Route path="broadcasts" element={<BroadcastsList />} />
            <Route path="broadcasts/new" element={<BroadcastComposer />} />
            <Route path="broadcasts/:broadcastId" element={<BroadcastResults />} />

            {/* Settings ▸ tabbed surface (replaces the generated placeholder).
                The index redirects to the first tab visible for the role; the
                admin-only sections (team, system) are route-guarded so a VA
                hitting them directly is redirected to /settings/templates. */}
            <Route path="settings" element={<SettingsPage />}>
              <Route index element={<SettingsIndexRedirect />} />
              <Route
                path="team"
                element={
                  <AdminRoute>
                    <TeamSection />
                  </AdminRoute>
                }
              />
              <Route path="templates" element={<TemplatesSection />} />
              <Route path="notifications" element={<NotificationsSection />} />
              {/* Voice: self cell verification — reachable by any logged-in
                  user (NOT admin-guarded). */}
              <Route path="voice" element={<VoiceSection />} />
              <Route
                path="system"
                element={
                  <AdminRoute>
                    <SystemStatusSection />
                  </AdminRoute>
                }
              />
            </Route>

            {/* The remaining nav destinations stay placeholders for now. */}
            {allNavTargets()
              .filter(({ to }) => !IMPLEMENTED.has(to))
              .map(({ to, label }) => (
                <Route key={to} path={to.slice(1)} element={<Placeholder title={label} />} />
              ))}

            {/* The tenant + landlord detail page (one shell). The static
                /contacts/* list routes above rank above this dynamic segment. */}
            <Route path="contacts/:contactId" element={<ContactDetail />} />
            {/* The property detail page. The static /listings list route above
                ranks above this dynamic segment. */}
            <Route path="listings/:unitId" element={<ListingDetail />} />

            <Route path="*" element={<Placeholder title="Not found" />} />
          </Route>
          </Routes>
        </EventStreamProvider>
      </AuthGate>
    </AuthProvider>
  );
}
