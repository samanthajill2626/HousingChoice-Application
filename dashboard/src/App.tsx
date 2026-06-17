// App — the root component: the auth session provider + gate around the app.
// Anonymous → Login; authenticated → the app shell. B0.4 replaces the
// authenticated placeholder with the AppFrame + routes.
import { AuthProvider } from './app/AuthContext.js';
import { AuthGate } from './app/AuthGate.js';

export default function App(): React.JSX.Element {
  return (
    <AuthProvider>
      <AuthGate>
        <main>
          <h1>HousingChoice</h1>
        </main>
      </AuthGate>
    </AuthProvider>
  );
}
