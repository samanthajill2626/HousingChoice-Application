// Login — the anonymous landing + Google sign-in (the shell, built by the
// foundation; NOT a feature placeholder). "Sign in with Google" is a plain
// navigation to /auth/login — the server drives the whole OAuth dance, then
// redirects back to / where AuthContext re-probes /auth/me. Styled with the
// design system. Rendered by App.tsx whenever the session is anonymous.
import { Button } from '../ui/index.js';
import { loginUrl } from '../api/index.js';
import styles from './Login.module.css';

export default function Login(): React.JSX.Element {
  return (
    <main className={styles.wrapper}>
      <div className={styles.card}>
        <h1 className={styles.heading}>HousingChoice</h1>
        <p className={styles.subtitle}>Tenant placement, text-first.</p>
        <Button as="a" href={loginUrl()} size="lg" block className={styles.signIn}>
          Sign in with Google
        </Button>
        <p className={styles.muted}>Invited workspace accounts only.</p>
      </div>
    </main>
  );
}
