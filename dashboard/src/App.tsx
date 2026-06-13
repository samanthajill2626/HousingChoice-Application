// App — the top of the React tree. Wraps everything in the AuthProvider +
// ToastProvider, then branches on the bootstrap session state:
//   loading       → a centered spinner (probing /auth/me)
//   anonymous     → the Login screen (Google sign-in; the shell, not a feature)
//   authenticated → the routed app (AppLayout + the feature screens)
// The BrowserRouter lives here so the whole authenticated tree (and its links)
// share one router. Login renders OUTSIDE the routes — it has no nav.
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider, useAuth } from './app/AuthContext.js';
import { AppRouter } from './app/router.js';
import Login from './routes/Login.js';
import { Spinner, ToastProvider } from './ui/index.js';

function Gate(): React.JSX.Element {
  const { status } = useAuth();

  if (status === 'loading') {
    return <Spinner center size="lg" label="Checking your session" />;
  }
  if (status === 'anonymous') {
    return <Login />;
  }
  return (
    <BrowserRouter>
      <AppRouter />
    </BrowserRouter>
  );
}

export default function App(): React.JSX.Element {
  return (
    <AuthProvider>
      <ToastProvider>
        <Gate />
      </ToastProvider>
    </AuthProvider>
  );
}
