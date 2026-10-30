// FairHousingFlagNotice - the property page's read-only fair-housing notice
// (WP1 B2a spec D10 rev 7, charter item 16). One line per OPEN unlawful flag:
// the field by its staff label, the fixed reason, and that editing the text
// clears it. Nothing while the check runs or when no flag is open; a failed
// check is a short plain note (never an alert - the page itself is fine). No
// Dismiss: B4 builds the admin Dismiss.
import type { UnitFlagsState } from './useUnitFlags.js';
import styles from './FairHousingFlagNotice.module.css';

export const FLAG_CHECK_FAILED_COPY = 'Could not check fair-housing flags.';

export function FairHousingFlagNotice({ state }: { state: UnitFlagsState }): React.JSX.Element | null {
  if (state.status === 'error') return <p className={styles.note}>{FLAG_CHECK_FAILED_COPY}</p>;
  if (state.status !== 'ready' || state.flags.length === 0) return null;
  return (
    <section className={styles.notice} aria-label="Fair-housing flags">
      {/* Explicit role: `list-style: none` makes WebKit drop the list role. */}
      <ul className={styles.list} role="list">
        {state.flags.map((flag) => (
          <li key={flag.field}>
            <strong>Fair-housing flag</strong> - {flag.label}: {flag.reason}. Edit this text to clear the flag.
          </li>
        ))}
      </ul>
    </section>
  );
}
