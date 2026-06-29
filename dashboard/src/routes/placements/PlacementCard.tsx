// PlacementCard — one placement on the board. Shows the tenant NAME (home), the
// property ADDRESS, the stage label, a tour date / next deadline when present, an
// attention dot, and a "Porting" chip when the tenant is porting.
//
// A11y: the draggable role/listeners live on a DEDICATED grip HANDLE (the "⠿"
// button with an aria-label like "Move <tenant>"), NOT on the whole <article> —
// so the card stays a plain container and the "Open" <Link> is no longer nested
// inside a role=button (an interactive-inside-interactive anti-pattern). The
// tenant name + "Open" link remain reachable; cards are findable by the tenant
// name (getByText / link name) for e2e.
import { useDraggable } from '@dnd-kit/core';
import { Link } from 'react-router-dom';
import { STAGE_LABELS, type PlacementItem } from '../../api/index.js';
import { StatusBadge } from '../../ui/index.js';
import { shortDate } from './placementsFormat.js';
import styles from './PlacementCard.module.css';

export interface PlacementCardProps {
  placement: PlacementItem;
  tenant: string;
  listing: string;
  porting: boolean;
  /** Optional derived tenant status badge (eventual consistency — see board). */
  tenantStatus?: string;
  /** True while THIS card is being optimistically moved (dimmed). */
  pending?: boolean;
}

export function PlacementCard({
  placement,
  tenant,
  listing,
  porting,
  tenantStatus,
  pending = false,
}: PlacementCardProps): React.JSX.Element {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: placement.placementId,
    data: { fromStage: placement.stage, tenantId: placement.tenantId },
  });

  const stageLabel = STAGE_LABELS[placement.stage] ?? placement.stage;
  const tourDate = shortDate(placement.tour_date);
  const deadline =
    placement.next_deadline_at !== undefined ? shortDate(placement.next_deadline_at) : '';

  return (
    <article
      ref={setNodeRef}
      className={`${styles.card} ${isDragging ? styles.dragging : ''} ${pending ? styles.pending : ''}`}
      aria-label={`${tenant} — ${stageLabel}`}
    >
      <div className={styles.topRow}>
        {/* Dedicated drag handle — the ONLY draggable element on the card, so the
            article stays a plain container and the Link below is not nested in a
            role=button. */}
        <button
          type="button"
          className={styles.handle}
          aria-label={`Move ${tenant}`}
          {...attributes}
          {...listeners}
        >
          <span aria-hidden="true">⠿</span>
        </button>
        <span className={styles.tenant}>{tenant}</span>
        {porting ? (
          <span className={styles.porting} title="Tenant is porting">
            Porting
          </span>
        ) : null}
        {placement.attention ? (
          <span className={styles.dot} aria-label="Needs attention" role="img" />
        ) : null}
      </div>

      <div className={styles.listing} title={listing}>
        {listing}
      </div>

      <div className={styles.metaRow}>
        <span className={styles.stage}>{stageLabel}</span>
        {tourDate ? <span className={styles.meta}>Tour {tourDate}</span> : null}
        {!tourDate && deadline ? <span className={styles.meta}>Due {deadline}</span> : null}
        {tenantStatus ? <StatusBadge kind="tenant" status={tenantStatus} /> : null}
      </div>

      <Link to={`/placements/${placement.placementId}`} className={styles.open} onClick={(e) => e.stopPropagation()}>
        Open
      </Link>
    </article>
  );
}
