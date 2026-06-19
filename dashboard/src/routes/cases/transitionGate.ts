// transitionGate — PURE: given a from/to stage, decide whether the move needs a
// blocking prompt BEFORE the transition can fire (F2.1 confirmed contract):
//   - to 'lost'                       → needs the Lost-reason modal (F2.2)
//   - OUT of 'awaiting_rent_acceptance' → needs the finalRent prompt (>0)
//   - OUT of 'awaiting_inspection'    → needs the inspectionOutcome prompt
// "OUT of X" means fromStage === X and the move actually leaves it. Tested in
// isolation so the board/detail just react to the returned gate.
import type { PlacementStage } from '../../api/index.js';

export type TransitionGate = 'none' | 'lost' | 'finalRent' | 'inspectionOutcome';

/** Which gating prompt (if any) a from→to stage move requires. A no-op move
 *  (from === to) needs nothing. */
export function gateFor(from: PlacementStage, to: PlacementStage): TransitionGate {
  if (from === to) return 'none';
  if (to === 'lost') return 'lost';
  if (from === 'awaiting_rent_acceptance') return 'finalRent';
  if (from === 'awaiting_inspection') return 'inspectionOutcome';
  return 'none';
}
