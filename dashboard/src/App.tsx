// App — the root component: the auth session provider + gate, and (when
// authenticated) the AppFrame shell wrapping the routed pages. Most routes are
// still GENERATED from the nav model (allNavTargets) as placeholders so the nav
// links and the routes can never drift apart; the implemented pages (Today, the
// Contacts + Properties list views, and the contact/property detail pages) are
// swapped in explicitly, one destination at a time.
import { Route, Routes } from 'react-router-dom';
import { AuthProvider } from './app/AuthContext.js';
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
import { allNavTargets } from './app/nav.js';

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
]);

export default function App(): React.JSX.Element {
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
