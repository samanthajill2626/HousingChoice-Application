// ClosedArea — the collapsed list of terminal placements (moved_in / lost) below
// the active board columns. A <details> so it's collapsed by default and
// keyboard-toggleable; each row links to the placement detail and shows the terminal
// stage label (and the lost-reason CATEGORY label for lost placements). Terminal
// placements are not draggable (they're done).
//
// PII: this is a board LIST, so it shows the lost-reason CATEGORY label ONLY
// (LOST_REASON_CATEGORY_LABELS) — never the free `text` (which can hold PII).
// formatLostReason (which concatenates the free text) is reserved for the
// PlacementDetail pane, not list/card surfaces.
import { Link } from 'react-router-dom';
import { LOST_REASON_CATEGORY_LABELS, STAGE_LABELS, type PlacementItem } from '../../api/index.js';
import styles from './ClosedArea.module.css';

export interface ClosedAreaProps {
  placements: PlacementItem[];
  tenantName: (tenantId: string) => string;
  listingAddress: (unitId: string) => string;
}

export function ClosedArea({ placements, tenantName, listingAddress }: ClosedAreaProps): React.JSX.Element | null {
  if (placements.length === 0) return null;
  return (
    <details className={styles.closed}>
      <summary className={styles.summary}>
        Closed
        <span className={styles.count}>{placements.length}</span>
      </summary>
      <ul className={styles.rows} aria-label="Closed placements">
        {placements.map((c) => {
          // CATEGORY label only (never the free text — PII). Empty when the lost
          // reason carries no category (e.g. free-text only).
          const reason =
            c.stage === 'lost' && c.lost_reason?.category !== undefined
              ? LOST_REASON_CATEGORY_LABELS[c.lost_reason.category]
              : '';
          return (
            <li key={c.placementId} className={styles.rowItem}>
              <Link to={`/placements/${c.placementId}`} className={styles.row}>
                <span className={styles.tenant}>{tenantName(c.tenantId)}</span>
                <span className={styles.listing}>{listingAddress(c.unitId)}</span>
                <span className={styles.stage}>
                  {STAGE_LABELS[c.stage] ?? c.stage}
                  {reason ? ` · ${reason}` : ''}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
