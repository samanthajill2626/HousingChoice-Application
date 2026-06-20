// Column — one phase column on the board: a droppable region (the drop target
// stage = the phase's first stage) holding its PlacementCards. Labeled by the phase
// so e2e can target columns (getByRole('listitem' / region, name: phase)). Each
// card also carries a non-drag "Move to…" fallback (a phase <select>) for an
// accessible alternative to drag (drag stays the primary affordance).
import { useDroppable } from '@dnd-kit/core';
import {
  PLACEMENT_PHASES,
  type PlacementItem,
  type Contact,
  type PlacementPhase,
  type PlacementStage,
  type UnitItem,
} from '../../api/index.js';
import { PlacementCard } from './PlacementCard.js';
import { firstStageOfPhase } from './board.js';
import { isPorting, listingAddress, tenantName } from './placementsFormat.js';
import styles from './Column.module.css';

export interface ColumnProps {
  phase: PlacementPhase;
  targetStage: PlacementStage;
  placements: PlacementItem[];
  contacts: Map<string, Contact>;
  units: Map<string, UnitItem>;
  /** placementId → optimistic target stage (dim those cards). */
  optimistic: Map<string, PlacementStage>;
  /** Request a move (drag drop OR the per-card fallback both call this). */
  onMove: (placementId: string, fromStage: PlacementStage, toStage: PlacementStage) => void;
}

export function Column({
  phase,
  targetStage,
  placements,
  contacts,
  units,
  optimistic,
  onMove,
}: ColumnProps): React.JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id: `phase:${phase}`, data: { targetStage } });

  return (
    <section
      ref={setNodeRef}
      className={`${styles.column} ${isOver ? styles.over : ''}`}
      role="listitem"
      aria-label={phase}
    >
      <h2 className={styles.heading}>
        {phase}
        <span className={styles.count}>{placements.length}</span>
      </h2>
      <div className={styles.cards}>
        {placements.length === 0 ? (
          <p className={styles.empty}>No placements.</p>
        ) : (
          placements.map((c) => (
            <div key={c.placementId} className={styles.cardWrap}>
              <PlacementCard
                placement={c}
                tenant={tenantName(contacts, c.tenantId)}
                listing={listingAddress(units, c.unitId)}
                porting={isPorting(contacts, c.tenantId)}
                {...(contacts.get(c.tenantId)?.status !== undefined && {
                  tenantStatus: contacts.get(c.tenantId)!.status,
                })}
                pending={optimistic.has(c.placementId)}
              />
              <div className={styles.cardActions}>
                <label className={styles.moveLabel}>
                  <span className={styles.srOnly}>Move {tenantName(contacts, c.tenantId)} to phase</span>
                  <select
                    className={styles.moveSelect}
                    value=""
                    onChange={(e) => {
                      const toPhase = e.target.value as PlacementPhase;
                      if (toPhase) onMove(c.placementId, c.stage, firstStageOfPhase(toPhase));
                    }}
                  >
                    <option value="">Move to…</option>
                    {PLACEMENT_PHASES.filter((p) => p !== phase).map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className={styles.lostBtn}
                  aria-label={`Mark ${tenantName(contacts, c.tenantId)}'s placement lost`}
                  onClick={() => onMove(c.placementId, c.stage, 'lost')}
                >
                  Mark lost
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
