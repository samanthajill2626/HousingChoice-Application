// SystemStubSection — the Phase-A placeholder for the System status tab. The
// tab is in the model (admin-only) and deep-links, but the real panel (go-live
// flags + CloudWatch alarms + recent errors) is Phase B. Until then this renders
// an honest "available soon" stub.
import styles from './NotificationsSection.module.css';

export function SystemStubSection(): React.JSX.Element {
  return (
    <section className={styles.section} aria-labelledby="system-heading">
      <h2 id="system-heading" className={styles.heading}>
        System status
      </h2>
      <p className={styles.unsupported}>
        System status (go-live flags, alarms, and recent errors) is coming soon.
      </p>
    </section>
  );
}
