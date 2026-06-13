// App — the top of the React tree. The router lives here, ABOVE the auth gate,
// so two PUBLIC routes can render WITHOUT a session (and without ever probing
// /auth/me):
//   /flyer/:unitId  → a standalone shareable unit flyer
//   /housing-fair   → a standalone public signup form
// Every other path falls through to <AuthedApp>, which mounts the AuthProvider
// (bootstrapping GET /auth/me) and branches on the session state:
//   loading       → a centered spinner (probing /auth/me)
//   anonymous     → the Login screen (Google sign-in; the shell, not a feature)
//   authenticated → the routed app (AppLayout + the feature screens)
// Keeping AuthProvider INSIDE the authed branch is what makes the public pages
// truly anonymous: they mount no auth probe, so they can't redirect to login.
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './app/AuthContext.js';
import { AppRouter } from './app/router.js';
import Login from './routes/Login.js';
import Flyer from './routes/Flyer.js';
import HousingFair from './routes/HousingFair.js';
import { Spinner, ToastProvider } from './ui/index.js';

/** The authenticated app: bootstraps the session, then renders Login or the
 *  routed shell. Mounted only for non-public paths. */
function AuthedApp(): React.JSX.Element {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}

function Gate(): React.JSX.Element {
  const { status } = useAuth();

  if (status === 'loading') {
    return <Spinner center size="lg" label="Checking your session" />;
  }
  if (status === 'anonymous') {
    return <Login />;
  }
  return <AppRouter />;
}

export default function App(): React.JSX.Element {
  return (
    <ToastProvider>
      <BrowserRouter>
        <Routes>
          {/* PUBLIC — render with no session, outside the auth gate. */}
          <Route path="/flyer/:unitId" element={<Flyer />} />
          <Route path="/housing-fair" element={<HousingFair />} />
          {/* Everything else is the authenticated app (its own nested routes). */}
          <Route path="*" element={<AuthedApp />} />
        </Routes>
      </BrowserRouter>
    </ToastProvider>
  );
}
