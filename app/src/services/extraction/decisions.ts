// Decision assembly for the AI run log (design 2026-08-06 section 7.1).
//
// Decisions are built from what the model SAID (the raw op view of rawText),
// JOINED with apply's outcomes for what we DID. Two earlier revisions got this
// wrong in opposite directions - first deriving no_finding inside apply.ts
// (which fabricates evidence of evaluation, because apply's loop treats a
// missing field and an explicit op:'none' identically), then splitting the
// source by target (which still fabricates a decline whenever the downgrade at
// schema.ts:215-219 fires). Reading rawText for ALL TWELVE targets is both
// simpler and the only correct option.
//
// JOIN RULES:
//  1. An apply outcome (wrote | suggested | dropped) wins outright.
//  2. Else proposedOp 'none'   -> no_finding    (the model explicitly declined).
//  3. Else proposedOp 'absent' -> not_addressed (never mentioned at all).
//  4. Else the model proposed write/suggest and apply produced NOTHING, because
//     schema.ts folded it away before apply ran:
//       - EXPLAINED (an empty/whitespace scalar value, per schema.ts:215-219, or
//         the address target at all, per the zero-usable-parts fold at
//         schema.ts:258-263) -> dropped / empty_value_at_parse. Deliberately
//         DISTINCT from invalid_value: one is the model sending nothing usable,
//         the other is apply rejecting something well-formed but wrong.
//       - UNEXPLAINED (a non-empty value apply never reported) -> a GAP in
//         apply's decision table or a new fold site. Recorded as a REASONLESS
//         drop plus onUnexplained(). Loud, never a guessed reason.
//  5. rawText absent -> every target is forced to 'absent', so NO target can be
//     recorded no_finding. The spec does not permit inferring a decline that was
//     never observed.
//  6. Verdict is DERIVED here, never passed in.
import {
  DECISION_TARGETS,
  type DecisionTarget,
  type RunDecision,
  type Verdict,
} from './runTypes.js';
import type { ExtractionOpsView } from './schema.js';
import type { ApplyDecision } from './apply.js';

export interface BuildDecisionsInput {
  /** parseExtractionOps(rawText), or EMPTY_OPS_VIEW when no response arrived. */
  ops: ExtractionOpsView;
  /** False when the driver produced no rawText at all (the console driver, or a
   *  driver failure before a response arrived). */
  rawTextPresent: boolean;
  /** apply's per-target outcomes. Empty on a run that never reached apply. */
  applyDecisions: ApplyDecision[];
  /** Called when rule 4's UNEXPLAINED branch fires. Pass a logger warn. */
  onUnexplained?: (target: DecisionTarget) => void;
}

/** wrote -> auto_applied; suggested -> pending; everything else -> not_presented. */
function verdictFor(outcome: RunDecision['outcome']): Verdict {
  if (outcome === 'wrote') return 'auto_applied';
  if (outcome === 'suggested') return 'pending';
  return 'not_presented';
}

export function buildDecisions(input: BuildDecisionsInput): Partial<Record<DecisionTarget, RunDecision>> {
  const applied = new Map<string, ApplyDecision>();
  for (const decision of input.applyDecisions) applied.set(decision.target, decision);

  const out: Partial<Record<DecisionTarget, RunDecision>> = {};
  for (const target of DECISION_TARGETS) {
    const op = input.ops[target];
    // Rule 5, asserted rather than assumed.
    const proposedOp = input.rawTextPresent ? op.op : 'absent';
    const hit = applied.get(target);

    let outcome: RunDecision['outcome'];
    let dropReason: RunDecision['dropReason'];
    if (hit !== undefined) {
      outcome = hit.outcome;
      dropReason = hit.dropReason;
    } else if (proposedOp === 'none') {
      outcome = 'no_finding';
    } else if (proposedOp === 'absent') {
      outcome = 'not_addressed';
    } else {
      outcome = 'dropped';
      // Rule 4. `address` carries no value in the ops view, and its only way to
      // vanish before apply is the zero-usable-parts fold - so it is always the
      // explained case. A scalar is explained only when its value was empty.
      const emptyValue = op.value === undefined || op.value.trim().length === 0;
      if (target === 'address' || emptyValue) {
        dropReason = 'empty_value_at_parse';
      } else {
        input.onUnexplained?.(target); // LOUD - never guess a reason
      }
    }

    const proposedValue =
      hit?.proposedValue ?? (proposedOp === 'write' || proposedOp === 'suggest' ? op.value : undefined);
    const reason = hit?.reason ?? op.reason;

    out[target] = {
      proposedOp,
      ...(proposedValue !== undefined && { proposedValue }),
      ...(hit?.coercedValue !== undefined && { coercedValue: hit.coercedValue }),
      ...(hit?.previousValue !== undefined && { previousValue: hit.previousValue }),
      ...(reason !== undefined && { reason }),
      ...(hit?.demotedFrom !== undefined && { demotedFrom: hit.demotedFrom }),
      outcome,
      ...(dropReason !== undefined && { dropReason }),
      verdict: verdictFor(outcome),
    };
  }
  return out;
}
