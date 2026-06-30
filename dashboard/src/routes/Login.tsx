// Login — the anonymous landing + Google sign-in (the shell, built by the
// foundation). "Sign in with Google" is a plain navigation to /auth/login — the
// server drives the whole OAuth dance, then redirects back to / where
// AuthContext re-probes /auth/me. Rendered whenever the session is anonymous.
//
// DEV-ONLY affordance: when the hermetic dev router is mounted (GET /__dev/ping
// → 200 {dev:true}), we also surface "Continue as dev …" buttons that POST
// /auth/dev-login and reload into / (AuthProvider then re-probes /auth/me). Two
// seeded personas are offered — the VA (va@example.com) and the admin/founder
// (founder@example.com) — so the local stack can be exercised at BOTH roles
// without OAuth. It FAILS CLOSED — the probe defaults to absent and any error
// keeps it hidden, so it is never reachable in a deployed env: the dev router
// only mounts on a hermetic LOCAL stack (NODE_ENV!=='production' + the dev flag
// + a DynamoDB-Local endpoint — see app/src/lib/devRoutes.ts), and config.ts
// fails fast if the flag is ever set in production.
import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/index.js';
import { devLogin, devPing, loginUrl } from '../api/index.js';
import styles from './Login.module.css';

// The two seeded dev personas (app/src/routes/dev.ts KNOWN_PERSONAS): va → 'va',
// founder → 'admin'. Offering both named personas makes the role explicit at a
// glance (the admin one reaches the admin-only Team + System Status surfaces).
const DEV_VA_EMAIL = 'va@example.com';
const DEV_ADMIN_EMAIL = 'founder@example.com';

export default function Login(): React.JSX.Element {
  const [devAvailable, setDevAvailable] = useState(false);
  // The email currently being submitted — so only the clicked button spins and
  // both are disabled while a login is in flight; undefined when idle.
  const [devBusyEmail, setDevBusyEmail] = useState<string | undefined>(undefined);
  const [devError, setDevError] = useState<string | undefined>(undefined);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void devPing(controller.signal)
      .then((available) => {
        if (mounted.current) setDevAvailable(available);
      })
      // devPing itself never throws (it fails closed), but guard the chain so a
      // rejected probe can never surface as an unhandled rejection / crash.
      .catch(() => {
        if (mounted.current) setDevAvailable(false);
      });
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, []);

  async function onDevLogin(email: string): Promise<void> {
    setDevBusyEmail(email);
    setDevError(undefined);
    try {
      await devLogin(email);
      // Reload into / so AuthProvider re-runs getMe() with the new cookie.
      window.location.assign('/');
    } catch {
      if (mounted.current) {
        setDevError('Dev login failed. Is the seeded dev user present?');
        setDevBusyEmail(undefined);
      }
    }
  }

  const devBusy = devBusyEmail !== undefined;

  return (
    <main className={styles.wrapper}>
      <div className={styles.card}>
        <h1 className={styles.heading}>HousingChoice</h1>
        <p className={styles.subtitle}>Tenant placement, text-first.</p>
        <Button as="a" href={loginUrl()} size="lg" block className={styles.signIn}>
          Sign in with Google
        </Button>
        <p className={styles.muted}>Invited workspace accounts only.</p>
        {devAvailable && (
          <div className={styles.dev}>
            <Button
              variant="secondary"
              size="md"
              block
              loading={devBusyEmail === DEV_VA_EMAIL}
              disabled={devBusy}
              onClick={() => void onDevLogin(DEV_VA_EMAIL)}
            >
              Continue as dev user (seeded VA)
            </Button>
            <Button
              variant="secondary"
              size="md"
              block
              loading={devBusyEmail === DEV_ADMIN_EMAIL}
              disabled={devBusy}
              onClick={() => void onDevLogin(DEV_ADMIN_EMAIL)}
            >
              Continue as dev admin (seeded founder)
            </Button>
            {devError !== undefined && (
              <p className={styles.devError} role="alert">
                {devError}
              </p>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
