// PublicLayout — the standalone, UNAUTHENTICATED shell for the public funnel.
// A HousingChoice brand header + a minimal footer, NO dashboard nav. Mobile-
// first (a single centered column). Wraps every public route (the FlyerFunnel
// and the /join intake), which mount OUTSIDE AuthProvider / AuthGate / AppFrame
// — so nothing here may read auth/session state.
import type { ReactNode } from 'react';
import styles from './PublicLayout.module.css';

export function PublicLayout({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <span className={styles.brand}>HousingChoice</span>
      </header>
      <main className={styles.main}>{children}</main>
      <footer className={styles.footer}>
        <span>HousingChoice — connecting voucher holders with homes.</span>
      </footer>
    </div>
  );
}
