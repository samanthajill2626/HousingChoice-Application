// App — the root component: the auth session provider + gate, and (when
// authenticated) the AppFrame shell wrapping the routed pages. Every nav target
// is mounted as a placeholder route in B0 so the frame is fully navigable; page
// phases (B1+) swap the real page in one route at a time.
import { Route, Routes } from 'react-router-dom';
import { AuthProvider } from './app/AuthContext.js';
import { AuthGate } from './app/AuthGate.js';
import { AppFrame } from './app/AppFrame.js';
import { Placeholder } from './routes/Placeholder.js';

export default function App(): React.JSX.Element {
  return (
    <AuthProvider>
      <AuthGate>
        <Routes>
          <Route element={<AppFrame />}>
            <Route index element={<Placeholder title="Today" />} />
            <Route path="cases" element={<Placeholder title="Cases" />} />
            <Route path="contacts" element={<Placeholder title="Contacts" />} />
            <Route path="contacts/tenants" element={<Placeholder title="Tenants" />} />
            <Route path="contacts/landlords" element={<Placeholder title="Landlords" />} />
            <Route path="contacts/unknown" element={<Placeholder title="Unknown" />} />
            <Route path="listings" element={<Placeholder title="Listings" />} />
            <Route path="inbox" element={<Placeholder title="Inbox" />} />
            <Route path="broadcasts" element={<Placeholder title="Broadcasts" />} />
            <Route path="settings" element={<Placeholder title="Settings" />} />
            <Route path="*" element={<Placeholder title="Not found" />} />
          </Route>
        </Routes>
      </AuthGate>
    </AuthProvider>
  );
}
