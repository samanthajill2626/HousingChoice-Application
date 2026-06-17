// Login — the anonymous landing + Google sign-in (the shell, built by the
// foundation). "Sign in with Google" is a plain navigation to /auth/login — the
// server drives the whole OAuth dance, then redirects back to / where
// AuthContext re-probes /auth/me. Rendered whenever the session is anonymous.
//
// DEV-ONLY affordance: when the hermetic dev router is mounted (GET /__dev/ping
// → 200 {dev:true}), we also surface a "Continue as dev user" button that POSTs
// /auth/dev-login and reloads into / (AuthProvider then re-probes /auth/me). It
// FAILS CLOSED — the probe defaults to absent and any error keeps it hidden, so
// it is never reachable in a deployed env (where the router is 404).
import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/index.js';
import { devLogin, devPing, loginUrl } from '../api/index.js';
import styles from './Login.module.css';

const DEV_EMAIL = 'va@example.com';

export default function Login(): React.JSX.Element {
  const [devAvailable, setDevAvailable] = useState(false);
  const [devBusy, setDevBusy] = useState(false);
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

  async function onDevLogin(): Promise<void> {
    setDevBusy(true);
    setDevError(undefined);
    try {
      await devLogin(DEV_EMAIL);
      // Reload into / so AuthProvider re-runs getMe() with the new cookie.
      window.location.assign('/');
    } catch {
      if (mounted.current) {
        setDevError('Dev login failed. Is the seeded dev user present?');
        setDevBusy(false);
      }
    }
  }

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
              loading={devBusy}
              onClick={() => void onDevLogin()}
            >
              Continue as dev user (seeded VA)
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
