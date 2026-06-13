// Dashboard shell (M1.3): a login screen and an authenticated landing stub.
// The real conversation-hub UI is M1.4 — this only proves the auth plumbing:
// GET /auth/me decides which screen renders, "Sign in with Google" is a plain
// navigation to /auth/login (the server drives the whole OAuth dance), and
// sign-out POSTs /auth/logout. Locally the Vite dev server proxies
// /api + /auth to the app on :8080 (vite.config.ts).
import { useEffect, useState, type CSSProperties } from 'react';

interface Me {
  userId: string;
  email: string;
  role: string;
}

type Session =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'authenticated'; me: Me };

const styles = {
  wrapper: {
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    padding: '2rem',
  },
  heading: {
    fontSize: '2rem',
    fontWeight: 700,
    margin: 0,
  },
  subtitle: {
    fontSize: '1.1rem',
    margin: '0.5rem 0 0',
  },
  muted: {
    fontSize: '0.9rem',
    color: '#6b7280',
    margin: '1rem 0 0',
  },
  signIn: {
    display: 'inline-block',
    marginTop: '1.5rem',
    padding: '0.65rem 1.5rem',
    borderRadius: '0.375rem',
    backgroundColor: '#1f2937',
    color: '#f9fafb',
    fontSize: '1rem',
    fontWeight: 600,
    textDecoration: 'none',
  },
  signOut: {
    marginTop: '1.5rem',
    padding: '0.5rem 1.25rem',
    borderRadius: '0.375rem',
    border: '1px solid #d1d5db',
    backgroundColor: '#ffffff',
    color: '#1f2937',
    fontSize: '0.9rem',
    cursor: 'pointer',
  },
} satisfies Record<string, CSSProperties>;

export default function App() {
  const [session, setSession] = useState<Session>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/auth/me');
        if (res.ok) {
          const me = (await res.json()) as Me;
          if (!cancelled) setSession({ status: 'authenticated', me });
        } else if (!cancelled) {
          setSession({ status: 'anonymous' });
        }
      } catch {
        if (!cancelled) setSession({ status: 'anonymous' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function signOut() {
    try {
      await fetch('/auth/logout', { method: 'POST' });
    } finally {
      setSession({ status: 'anonymous' });
    }
  }

  if (session.status === 'loading') {
    return (
      <main style={styles.wrapper}>
        <h1 style={styles.heading}>HousingChoice</h1>
        <p style={styles.muted}>Checking your session&hellip;</p>
      </main>
    );
  }

  if (session.status === 'anonymous') {
    return (
      <main style={styles.wrapper}>
        <h1 style={styles.heading}>HousingChoice</h1>
        <p style={styles.subtitle}>Tenant placement, text-first.</p>
        <a style={styles.signIn} href="/auth/login">
          Sign in with Google
        </a>
        <p style={styles.muted}>Workspace accounts only.</p>
      </main>
    );
  }

  return (
    <main style={styles.wrapper}>
      <h1 style={styles.heading}>HousingChoice</h1>
      <p style={styles.subtitle}>
        Signed in as <strong>{session.me.email}</strong> ({session.me.role})
      </p>
      <p style={styles.muted}>The conversation hub arrives in M1.4.</p>
      <button style={styles.signOut} type="button" onClick={() => void signOut()}>
        Sign out
      </button>
    </main>
  );
}
