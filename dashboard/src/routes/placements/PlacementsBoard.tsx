// PlacementsBoard — the placement board at /placements (F2.1). One column per
// PLACEMENT_PHASE; cards grouped by STAGE_PHASE. Drag a card to another phase's
// column to transition it to that phase's FIRST stage (firstStageOfPhase).
// Terminal placements (moved_in / lost) live in a collapsed "Closed" area below
// the columns (see board.ts).
//
// ACCESSIBILITY: pointer drag is the primary affordance. A KeyboardSensor wired
// to sortableKeyboardCoordinates makes keyboard drag work too, but the GUARANTEED
// keyboard-operable path is the non-drag fallback on each card — the "Move to…"
// phase <select> and the "Mark lost" button (see Column.tsx). Those are always
// reachable by Tab and do not depend on the drag sensors.
//
// MOVE PIPELINE (drag drop OR the per-card "Move to…" fallback both call
// requestMove):
//   1. gateFor(from, to) decides whether a blocking prompt is needed first:
//        - 'lost'             → open LostReasonModal; transition only on confirm.
//        - 'finalRent'        → open MovePromptModal(finalRent); >0 required.
//        - 'inspectionOutcome'→ open MovePromptModal(inspectionOutcome).
//        - 'none'             → fire immediately.
//   2. OPTIMISTIC: the card is shown in the target column right away (pendingMove
//      overrides its stage for grouping) and dimmed.
//   3. transitionPlacement(placementId, { toStage, source:'manual', … }) runs.
//        - success → applyPlacement(returned PlacementItem) (authoritative), clear pending.
//        - error   → clear pending (rolls the card back to its original column)
//                    and show a non-blocking inline error banner.
//
// Derived badges: the card shows the authoritative STAGE. We do NOT fabricate a
// derived tenant status — the board accepts eventual consistency (the tenant
// badge reflects whatever the last contacts load returned; the next board load /
// a contact-page visit refreshes it).
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import {
  transitionPlacement,
  type LostReason,
  type PlacementStage,
} from '../../api/index.js';
import { Button, Spinner } from '../../ui/index.js';
import { buildBoard, isNoOpMove } from './board.js';
import { listingAddress, tenantName } from './placementsFormat.js';
import { gateFor, type TransitionGate } from './transitionGate.js';
import { Column } from './Column.js';
import { ClosedArea } from './ClosedArea.js';
import { LostReasonModal } from './LostReasonModal.js';
import { MovePromptModal, type MovePromptResult } from './MovePromptModal.js';
import { PlacementCreateForm } from './PlacementCreateForm.js';
import { usePlacements } from './usePlacements.js';
import styles from './PlacementsBoard.module.css';

/** A move awaiting its prompt and/or its in-flight transition. */
interface PendingMove {
  placementId: string;
  fromStage: PlacementStage;
  toStage: PlacementStage;
  gate: TransitionGate;
}

export function PlacementsBoard(): React.JSX.Element {
  const navigate = useNavigate();
  const { status, placements, contacts, units, applyPlacement } = usePlacements();
  const [pending, setPending] = useState<PendingMove | null>(null);
  // The "New placement" dialog (blank — no side pre-filled).
  const [createOpen, setCreateOpen] = useState(false);
  // placementIds whose optimistic move is in flight → dim + group in the target column.
  const [optimistic, setOptimistic] = useState<Map<string, PlacementStage>>(new Map());
  const [error, setError] = useState<string | null>(null);

  // DnD sensors: a pointer sensor for mouse/touch AND a keyboard sensor wired to
  // sortableKeyboardCoordinates so keyboard drag actually MOVES focus across
  // columns (without a coordinateGetter the KeyboardSensor can pick up a card but
  // can't translate arrow keys into a droppable, so keyboard drag was a no-op).
  // The fully-accessible non-drag path remains the per-card "Move to…" select +
  // "Mark lost" button in Column — those are the guaranteed keyboard route.
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Apply optimistic overrides on top of the loaded placements before grouping, so a
  // card visually sits in its target column while the transition is in flight.
  const board = useMemo(() => {
    const effective =
      optimistic.size === 0
        ? placements
        : placements.map((c) =>
            optimistic.has(c.placementId) ? { ...c, stage: optimistic.get(c.placementId)! } : c,
          );
    return buildBoard(effective);
  }, [placements, optimistic]);

  /** Run the actual transition (after any gate is satisfied), with optimistic
   *  move + rollback. `extra` carries lostReason / finalRent / inspectionOutcome. */
  function runTransition(
    move: PendingMove,
    extra: { lostReason?: LostReason } & MovePromptResult,
  ): void {
    setError(null);
    setOptimistic((prev) => new Map(prev).set(move.placementId, move.toStage));
    void transitionPlacement(move.placementId, {
      toStage: move.toStage,
      source: 'manual',
      ...(extra.lostReason !== undefined && { lostReason: extra.lostReason }),
      ...(extra.finalRent !== undefined && { finalRent: extra.finalRent }),
      ...(extra.inspectionOutcome !== undefined && { inspectionOutcome: extra.inspectionOutcome }),
    })
      .then((updated) => {
        applyPlacement(updated); // authoritative stage from the server
      })
      .catch(() => {
        setError('That move was rejected. The card was returned to its column.');
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

  /** Entry point for both drag-drop and the per-card fallback: decide the gate.
   *  Two no-op guards before any transition/prompt fires:
   *   1. Exact same stage (the trivial case).
   *   2. SAME PHASE: a drop onto the card's OWN phase column would otherwise
   *      "regress" it to that phase's first stage (e.g. awaiting_rent_acceptance
   *      dropped on Rent Determination → determine_rent, even firing the finalRent
   *      prompt). A within-phase move is meaningless on a phase board, so we
   *      no-op it. (The per-card "Move to…" select already filters the current
   *      phase, so this only bites the DROP path — but we guard centrally.) */
  function requestMove(placementId: string, fromStage: PlacementStage, toStage: PlacementStage): void {
    // No-op guard (isNoOpMove): same stage OR same phase → no transition, no
    // prompt, no optimistic move. (Computed via phaseOfPlacement under the hood.)
    if (isNoOpMove(fromStage, toStage)) return;
    const gate = gateFor(fromStage, toStage);
    const move: PendingMove = { placementId, fromStage, toStage, gate };
    if (gate === 'none') {
      runTransition(move, {});
      return;
    }
    // A gated move opens the relevant modal first; the transition fires on confirm.
    setPending(move);
  }

  function onDragEnd(event: DragEndEvent): void {
    const { active, over } = event;
    if (!over) return;
    const fromStage = (active.data.current?.fromStage as PlacementStage | undefined) ?? undefined;
    const toStage = (over.data.current?.targetStage as PlacementStage | undefined) ?? undefined;
    if (fromStage === undefined || toStage === undefined) return;
    requestMove(String(active.id), fromStage, toStage);
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
          We couldn&apos;t load the placement board. Please try again.
        </p>
      </div>
    );
  }

  const pendingModal = pending !== null && (pending.gate === 'finalRent' || pending.gate === 'inspectionOutcome');

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Placements</h1>
        <Button variant="primary" size="sm" type="button" onClick={() => setCreateOpen(true)}>
          New placement
        </Button>
      </div>
      <p className={styles.sub}>
        Placements by phase. Drag a card to a column to move it; terminal placements collapse below.
      </p>

      {error !== null ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}

      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div className={styles.board} role="list" aria-label="Placement phases">
          {board.columns.map((col) => (
            <Column
              key={col.phase}
              phase={col.phase}
              targetStage={col.targetStage}
              placements={col.placements}
              contacts={contacts}
              units={units}
              optimistic={optimistic}
              onMove={requestMove}
            />
          ))}
        </div>
      </DndContext>

      <ClosedArea
        placements={board.closed}
        tenantName={(id) => tenantName(contacts, id)}
        listingAddress={(id) => listingAddress(units, id)}
      />

      {pending !== null && pending.gate === 'lost' ? (
        <LostReasonModal
          subject={tenantName(contacts, placements.find((c) => c.placementId === pending.placementId)?.tenantId ?? '')}
          onClose={() => setPending(null)}
          onConfirm={(reason) => runTransition(pending, { lostReason: reason })}
          busy={optimistic.has(pending.placementId)}
        />
      ) : null}

      {pendingModal ? (
        <MovePromptModal
          mode={pending.gate === 'finalRent' ? 'finalRent' : 'inspectionOutcome'}
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
