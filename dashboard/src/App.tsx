// App — the root component: the auth session provider + gate, and (when
// authenticated) the AppFrame shell wrapping the routed pages. The placeholder
// routes are GENERATED from the nav model (allNavTargets) so the nav links and
// the routes can never drift apart; page phases (B1+) swap the real page in one
// route at a time.
import { Route, Routes } from 'react-router-dom';
import { AuthProvider } from './app/AuthContext.js';
import { AuthGate } from './app/AuthGate.js';
import { AppFrame } from './app/AppFrame.js';
import { Placeholder } from './routes/Placeholder.js';
import { Today } from './routes/today/Today.js';
import { ContactDetail } from './routes/contact/ContactDetail.js';
import { ListingDetail } from './routes/listing/ListingDetail.js';
import { allNavTargets } from './app/nav.js';

export default function App(): React.JSX.Element {
  return (
    <AuthProvider>
      <AuthGate>
        <Routes>
          <Route element={<AppFrame />}>
            {allNavTargets().map(({ to, label }) =>
              to === '/' ? (
                <Route key={to} index element={<Today />} />
              ) : (
                <Route key={to} path={to.slice(1)} element={<Placeholder title={label} />} />
              ),
            )}
            {/* B2/B3: the tenant + landlord detail page (one shell). The static
                /contacts/tenants|landlords|unknown placeholders above take
                priority over this dynamic segment in react-router. */}
            <Route path="contacts/:contactId" element={<ContactDetail />} />
            {/* B4: the listing detail page. The static /listings list
                placeholder above takes priority over this dynamic segment. */}
            <Route path="listings/:unitId" element={<ListingDetail />} />
            <Route path="*" element={<Placeholder title="Not found" />} />
          </Route>
        </Routes>
      </AuthGate>
    </AuthProvider>
  );
}
