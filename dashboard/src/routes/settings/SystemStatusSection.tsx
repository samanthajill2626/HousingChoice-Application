// SystemStatusSection — admin-only (also route-guarded by <AdminRoute>). The
// go-live readiness panel (doc §6): three stacked blocks — FlagPills (go-live
// flags, always load), AlarmGrid (CloudWatch alarms, auto-refresh while
// visible), RecentErrors (recent error events, windowed). Alarms/errors degrade
// to "Available in deployed environments." on the local/hermetic stack (no AWS).
//
// A11y: a real <h2> + per-block headings, status conveyed by text (not colour
// alone), labeled controls, role="alert" on load errors. The two A2P kill-
// switches show an amber "Off · pre-A2P" pill when off — the EXPECTED pre-launch
// state, visually distinct from a red error.
import { FlagPills } from './FlagPills.js';
import { AlarmGrid } from './AlarmGrid.js';
import { RecentErrors } from './RecentErrors.js';
import styles from './SystemStatusSection.module.css';

export function SystemStatusSection(): React.JSX.Element {
  return (
    <section className={styles.section} aria-labelledby="system-heading">
      <h2 id="system-heading" className={styles.heading}>
        System status
      </h2>
      <p className={styles.lede}>
        Go-live readiness, alarms, and recent errors for the environment this app runs in.
      </p>

      <FlagPills />
      <AlarmGrid />
      <RecentErrors />
    </section>
  );
}
