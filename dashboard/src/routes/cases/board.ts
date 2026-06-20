// board — PURE helpers for the placement board (no React, no I/O), tested
// in isolation so CasesBoard stays declarative.
//
// LAYOUT MODEL (documented, consistent):
//  - The board renders one column per PLACEMENT_PHASE (the 7 phases). A case is
//    grouped into the column of STAGE_PHASE[stage].
//  - TERMINAL handling: `moved_in` and `lost` both map to the Closure phase in
//    STAGE_PHASE, but a terminal placement is no longer ACTIVE on the board — so
//    we DO NOT put terminal cards in the Closure column. Instead they're split
//    into a separate collapsed "Closed" area (partitionCases → closed). The
//    Closure column therefore holds only the in-flight `awaiting_move_in` cases.
//  - DROP TARGET: dragging a card onto a phase column transitions it to the
//    FIRST stage of that phase (firstStageOfPhase) — the card menu / detail
//    offers the finer per-stage choice.
import {
  PLACEMENT_PHASES,
  PLACEMENT_STAGES,
  STAGE_PHASE,
  TERMINAL_STAGES,
  type CaseItem,
  type PlacementPhase,
  type PlacementStage,
} from '../../api/index.js';

/** The first stage of each phase, in PLACEMENT_STAGES order — the stage a drop
 *  onto that phase's column transitions to. Computed once from the ordered
 *  ladder so it can never drift from the stage list. */
export const FIRST_STAGE_OF_PHASE: Readonly<Record<PlacementPhase, PlacementStage>> = (() => {
  const out = {} as Record<PlacementPhase, PlacementStage>;
  for (const stage of PLACEMENT_STAGES) {
    const phase = STAGE_PHASE[stage];
    if (!(phase in out)) out[phase] = stage;
  }
  return out;
})();

/** The drop-target stage for a phase column (the phase's first stage). */
export function firstStageOfPhase(phase: PlacementPhase): PlacementStage {
  return FIRST_STAGE_OF_PHASE[phase];
}

/** True when a stage is terminal (moved_in / lost) — excluded from the columns
 *  and shown in the collapsed Closed area instead. */
export function isTerminal(stage: PlacementStage): boolean {
  return TERMINAL_STAGES.has(stage);
}

export interface BoardColumn {
  phase: PlacementPhase;
  /** The drop-target stage for this column (its first stage). */
  targetStage: PlacementStage;
  cases: CaseItem[];
}

export interface BoardModel {
  /** One entry per PLACEMENT_PHASE, in canonical order. */
  columns: BoardColumn[];
  /** Terminal placements (moved_in / lost) — the collapsed "Closed" area. */
  closed: CaseItem[];
}

/** Split the case list into the active phase columns + the closed (terminal)
 *  bucket. Pure; preserves input order within each group. */
export function buildBoard(cases: CaseItem[]): BoardModel {
  const byPhase = new Map<PlacementPhase, CaseItem[]>();
  for (const phase of PLACEMENT_PHASES) byPhase.set(phase, []);
  const closed: CaseItem[] = [];

  for (const c of cases) {
    if (isTerminal(c.stage)) {
      closed.push(c);
      continue;
    }
    const phase = STAGE_PHASE[c.stage];
    const bucket = phase ? byPhase.get(phase) : undefined;
    if (bucket) {
      bucket.push(c);
    } else {
      // An unknown/legacy stage (not in STAGE_PHASE — e.g. a removed stage on an
      // old record) maps to no column. Rather than silently DROP it (invisible,
      // unopenable), surface it in the Closed area so staff can still see and
      // open it. The Closed row falls back to the raw stage label via STAGE_LABELS
      // (`?? c.stage`), so it stays readable.
      closed.push(c);
    }
  }

  const columns: BoardColumn[] = PLACEMENT_PHASES.map((phase) => ({
    phase,
    targetStage: firstStageOfPhase(phase),
    cases: byPhase.get(phase) ?? [],
  }));

  return { columns, closed };
}

/** The phase a case currently sits in (its column), or null for a terminal case
 *  (which lives in the Closed area, not a column). */
export function phaseOfCase(c: CaseItem): PlacementPhase | null {
  if (isTerminal(c.stage)) return null;
  return STAGE_PHASE[c.stage];
}

/** True when a board move (drag drop OR the per-card fallback) should be a NO-OP:
 *  the exact same stage, OR a move WITHIN the card's own phase (e.g. dropping
 *  awaiting_rent_acceptance back onto the Rent Determination column, which would
 *  otherwise regress it to determine_rent and fire the finalRent prompt). A
 *  within-phase move is meaningless on a phase board. Pure — exercises the same
 *  decision the drop handler uses. */
export function isNoOpMove(fromStage: PlacementStage, toStage: PlacementStage): boolean {
  if (fromStage === toStage) return true;
  const fromPhase = phaseOfCase({ stage: fromStage } as CaseItem);
  const toPhase = STAGE_PHASE[toStage];
  return fromPhase !== null && fromPhase === toPhase;
}
