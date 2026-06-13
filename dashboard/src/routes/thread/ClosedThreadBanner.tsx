// ClosedThreadBanner — shown above the timeline when a relay group is CLOSED
// (M1.7). A closed relay has released its pool number, so no fan-out happens;
// inbound that still arrives is a "late reply" (received_on_closed_thread) and
// is persisted but not relayed. The banner tells the operator to reopen to relay
// again. (The inline per-message "Late reply" badge lives on MessageBubble.)
import styles from './ClosedThreadBanner.module.css';

export function ClosedThreadBanner(): React.JSX.Element {
  return (
    <div className={styles.banner} role="status">
      <span className={styles.dot} aria-hidden="true" />
      <span>
        This relay group is <strong>closed</strong>. The pool number is released —
        new replies arrive as late replies and are not relayed. Reopen to relay again.
      </span>
    </div>
  );
}
