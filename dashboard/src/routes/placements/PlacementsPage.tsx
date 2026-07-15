// PlacementsPage - /placements: a phase FILTER (rail on desktop, chips on
// mobile) + ONE ledger list. Replaces the kanban PlacementsBoard: no drag; the
// row link opens the placement detail; the desktop-only StageMenu kebab moves a
// placement by exact stage. Jobs (per the 2026-07-08 spec): pipeline overview +
// fast lookup - triage lives on Today.
//
// MOVE PIPELINE (ported from PlacementsBoard, widened to the FULL gate set the
// way PlacementDetail handles it - stage-level moves can hit every gate):
//   1. gateFor(from, to): 'lost' -> LostReasonModal; finalRent /
//      inspectionOutcome / inspectionDate / rentDetermined / moveInReady ->
//      MovePromptModal(mode=gate, prefilled); 'none' -> fire immediately.
//   2. OPTIMISTIC: the row regroups/dims immediately (pendingMove overrides its
//      stage); success applies the authoritative PlacementItem; failure rolls
//      back and shows a non-blocking inline error banner.
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  transitionPlacement,
  type LostReason,
  type PlacementStage,
} from '../../api/index.js';
import { Button, Spinner } from '../../ui/index.js';
import { gateFor, type TransitionGate } from './transitionGate.js';
import { buildLedger, ledgerCounts, parseFilter } from './pageModel.js';
import { PhaseFilter } from './PhaseFilter.js';
import { PlacementRow } from './PlacementRow.js';
import { StageMenu } from './StageMenu.js';
import { LostReasonModal } from './LostReasonModal.js';
import { MovePromptModal, type MovePromptResult } from './MovePromptModal.js';
import { PlacementCreateForm } from './PlacementCreateForm.js';
import { tenantName } from './placementsFormat.js';
import { usePlacements } from './usePlacements.js';
import styles from './PlacementsPage.module.css';

/** A move awaiting its gate prompt and/or its in-flight transition. */
interface PendingMove {
  placementId: string;
  fromStage: PlacementStage;
  toStage: PlacementStage;
  gate: TransitionGate;
}

const PROMPT_GATES = new Set<TransitionGate>([
  'finalRent',
  'inspectionOutcome',
  'inspectionDate',
  'rentDetermined',
  'moveInReady',
]);

export function PlacementsPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { status, placements, contacts, units, applyPlacement } = usePlacements();
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<PendingMove | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [optimistic, setOptimistic] = useState<Map<string, PlacementStage>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const filter = useMemo(() => parseFilter(searchParams), [searchParams]);

  // Optimistic stage overrides applied BEFORE grouping so an in-flight move
  // shows the row in its target group immediately (same trick as the board).
  const effective = useMemo(
    () =>
      optimistic.size === 0
        ? placements
        : placements.map((c) =>
            optimistic.has(c.placementId) ? { ...c, stage: optimistic.get(c.placementId)! } : c,
          ),
    [placements, optimistic],
  );
  const counts = useMemo(() => ledgerCounts(effective), [effective]);
  const groups = useMemo(
    () => buildLedger(effective, contacts, units, filter, query),
    [effective, contacts, units, filter, query],
  );

  function runTransition(move: PendingMove, extra: { lostReason?: LostReason } & MovePromptResult): void {
    setError(null);
    setOptimistic((prev) => new Map(prev).set(move.placementId, move.toStage));
    void transitionPlacement(move.placementId, {
      toStage: move.toStage,
      source: 'manual',
      ...(extra.lostReason !== undefined && { lostReason: extra.lostReason }),
      ...(extra.finalRent !== undefined && { finalRent: extra.finalRent }),
      ...(extra.inspectionOutcome !== undefined && { inspectionOutcome: extra.inspectionOutcome }),
      ...(extra.inspectionDate !== undefined && { inspectionDate: extra.inspectionDate }),
      ...(extra.rentDetermined !== undefined && { rentDetermined: extra.rentDetermined }),
    })
      .then((updated) => {
        applyPlacement(updated);
      })
      .catch(() => {
        setError('That move was rejected. The placement kept its stage.');
      })
      .finally(() => {
        setOptimistic((prev) => {
          const next = new Map(prev);
          next.delete(move.placementId);
          return next;
        });
        setPending(null);
      });
  }

  function requestMove(placementId: string, fromStage: PlacementStage, toStage: PlacementStage): void {
    if (fromStage === toStage) return;
    const gate = gateFor(fromStage, toStage);
    const move: PendingMove = { placementId, fromStage, toStage, gate };
    if (gate === 'none') {
      runTransition(move, {});
      return;
    }
    setPending(move);
  }

  if (status === 'loading') {
    return (
      <div className={styles.page}>
        <h1 className={styles.title}>Placements</h1>
        <Spinner center />
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className={styles.page}>
        <h1 className={styles.title}>Placements</h1>
        <p role="alert" className={styles.error}>
          We couldn&apos;t load placements. Please try again.
        </p>
      </div>
    );
  }

  const pendingPlacement =
    pending !== null ? placements.find((c) => c.placementId === pending.placementId) : undefined;
  const pendingTenant =
    pendingPlacement !== undefined ? contacts.get(pendingPlacement.tenantId) : undefined;

  const trimmed = query.trim();
  const emptyText =
    trimmed !== ''
      ? `No matches for '${trimmed}'.`
      : filter.kind === 'phase'
        ? `No placements in ${filter.phase}.`
        : filter.kind === 'closed'
          ? 'No closed placements.'
          : 'No active placements.';

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Placements</h1>
        <Button variant="primary" size="sm" type="button" onClick={() => setCreateOpen(true)}>
          + New placement
        </Button>
      </div>

      {error !== null ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}

      <div className={styles.search}>
        <input
          type="search"
          className={styles.searchInput}
          aria-label="Search placements"
          placeholder="Search tenant or property..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className={styles.layout}>
        <PhaseFilter counts={counts} filter={filter} />
        <div className={styles.listArea}>
          {groups.length === 0 ? (
            <p className={styles.empty}>{emptyText}</p>
          ) : (
            groups.map((group) => (
              <section key={group.phase ?? 'flat'} className={styles.group}>
                {group.phase !== null ? (
                  <h2 className={styles.groupHead}>
                    {group.phase}
                    <span className={styles.groupCount}>{group.rows.length}</span>
                  </h2>
                ) : null}
                <ul
                  className={styles.rows}
                  aria-label={group.phase !== null ? `${group.phase} placements` : 'Placements'}
                >
                  {group.rows.map((row) => (
                    <PlacementRow
                      key={row.placement.placementId}
                      row={row}
                      pending={optimistic.has(row.placement.placementId)}
                      menu={
                        <StageMenu
                          tenant={row.tenant}
                          currentStage={row.placement.stage}
                          busy={optimistic.has(row.placement.placementId)}
                          onSelect={(toStage) =>
                            requestMove(row.placement.placementId, row.placement.stage, toStage)
                          }
                        />
                      }
                    />
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      </div>

      {pending !== null && pending.gate === 'lost' ? (
        <LostReasonModal
          subject={tenantName(contacts, pendingPlacement?.tenantId ?? '')}
          onClose={() => setPending(null)}
          onConfirm={(reason) => runTransition(pending, { lostReason: reason })}
          busy={optimistic.has(pending.placementId)}
        />
      ) : null}

      {pending !== null && PROMPT_GATES.has(pending.gate) && pendingPlacement !== undefined ? (
        <MovePromptModal
          mode={pending.gate as 'finalRent' | 'inspectionOutcome' | 'inspectionDate' | 'rentDetermined' | 'moveInReady'}
          initial={{
            finalRent: units.get(pendingPlacement.unitId)?.final_rent,
            inspectionOutcome: pendingPlacement.inspection_outcome,
            inspectionDate: pendingPlacement.inspection_date,
            rentDetermined: pendingPlacement.rent_determined,
          }}
          {...(pending.gate === 'moveInReady' && {
            lifPending: pendingTenant?.lifEligible === true && pendingPlacement.lif !== true,
          })}
          onClose={() => setPending(null)}
          onConfirm={(result) => runTransition(pending, result)}
          busy={optimistic.has(pending.placementId)}
        />
      ) : null}

      {createOpen ? (
        <PlacementCreateForm
          onClose={() => setCreateOpen(false)}
          onCreated={(p) => {
            setCreateOpen(false);
            void navigate('/placements/' + p.placementId);
          }}
        />
      ) : null}
    </div>
  );
}
