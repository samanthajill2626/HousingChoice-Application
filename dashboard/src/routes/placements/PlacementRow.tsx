// PlacementRow - one placement in the ledger list. The WHOLE row opens the
// placement detail via a stretched Link overlay (position:absolute inset:0)
// so the kebab menu button is a SIBLING layered above it - never an
// interactive-inside-interactive nesting. "Needs attention" = the Today-page
// treatment: a 4px var(--c-warning) stripe down the row's left edge
// (::before on .flagged) + visually-hidden text for AT. The old red dot is
// retired on this page.
import { Link } from 'react-router-dom';
import { STAGE_LABELS } from '../../api/index.js';
import { StatusBadge } from '../../ui/index.js';
import { DeadlineChip } from './DeadlineChip.js';
import { shortDate } from './placementsFormat.js';
import type { LedgerRow } from './pageModel.js';
import styles from './PlacementRow.module.css';

export interface PlacementRowProps {
  row: LedgerRow;
  /** True while an optimistic move for THIS row is in flight (dimmed). */
  pending?: boolean;
  /** The desktop-only actions slot (the StageMenu kebab). */
  menu?: React.ReactNode;
}

export function PlacementRow({ row, pending = false, menu }: PlacementRowProps): React.JSX.Element {
  const { placement } = row;
  const stageLabel = STAGE_LABELS[placement.stage] ?? placement.stage;
  const flagged = Boolean(placement.attention);
  const tourDate = shortDate(placement.tour_date);

  return (
    <li
      className={`${styles.row} ${flagged ? styles.flagged : ''} ${pending ? styles.pending : ''}`}
    >
      {flagged ? <span className={styles.srOnly}>Needs attention</span> : null}
      <Link
        className={styles.overlay}
        to={`/placements/${placement.placementId}`}
        aria-label={`${row.tenant} - ${stageLabel}`}
      />
      <div className={styles.main}>
        <span className={styles.tenant}>{row.tenant}</span>
        {row.porting ? (
          <span className={styles.porting} title="Tenant is porting">
            Porting
          </span>
        ) : null}
        <span className={styles.listing} title={row.listing}>
          {row.listing}
        </span>
      </div>
      <div className={styles.meta}>
        <span className={styles.stage}>{stageLabel}</span>
        {tourDate ? <span className={styles.metaItem}>Tour {tourDate}</span> : null}
        <DeadlineChip placement={placement} />
        {row.tenantStatus ? <StatusBadge kind="tenant" status={row.tenantStatus} /> : null}
      </div>
      {menu !== undefined && menu !== null ? <div className={styles.actions}>{menu}</div> : null}
    </li>
  );
}
