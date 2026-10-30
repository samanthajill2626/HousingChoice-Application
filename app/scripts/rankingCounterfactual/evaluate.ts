// WP1 B2a spec D17 (Q5): the counterfactual check's comparison rules,
// exactly as written. Pure.
//
// - Per swap and direction, against the base pair's group A:
//   stage one (three runs each): PASS when the mean score moves by at most
//   SWAP_TOLERANCE and the cap counts (of three) differ by at most one;
//   a miss runs stage two (five more each, eight in all), which FAILS only
//   if the mean still moves by more than SWAP_TOLERANCE or the cap counts
//   differ by more than three of eight. A band change within the tolerance
//   is never a failure.
// - Noise, per base pair and direction: two independent groups of three base
//   runs; SPREAD = the difference of their means. Over NOISE_TOLERANCE after
//   stage one -> five more each; over it over eight each -> INCONCLUSIVE.
// - Spec rev 9 (Cameron 2026-10-30, after two failed runs): the swap
//   tolerance is 8 points; the noise tolerance stays at 5.
// - Each run's cap is production's capOf fed THAT run's own failed
//   requirements, accommodation flags and unlawful flags (no flag record
//   persists between runs, so run order cannot decide a result; plan PR7,
//   WI13). Means are compared in whole numbers: scores are integers.
import { baseField, capOf, flagFieldsOfKind } from '../../src/services/ranking/cap.js';
import type { ParsedCandidate } from '../../src/services/ranking/parse.js';

/** Spec D17 / Q5, AMENDED rev 9 (was 5): the most a swap may move the mean score, in points. */
export const SWAP_TOLERANCE = 8;
/** Spec D17 / Q5: the most the two base groups may spread, in points (unchanged at rev 9). */
export const NOISE_TOLERANCE = 5;
export const STAGE_ONE_RUNS = 3;
export const STAGE_TWO_RUNS = 8;
export const STAGE_ONE_MAX_CAP_DIFF = 1;
export const STAGE_TWO_MAX_CAP_DIFF = 3;
export const CONTROL_RUNS = 3;
export const CONTROL_MIN_HITS = 2;

export interface GradedRun {
  score: number;
  capped: boolean;
}

function sum(runs: readonly GradedRun[]): number {
  return runs.reduce((total, run) => total + run.score, 0);
}

export function meanOf(runs: readonly GradedRun[]): number {
  return runs.length === 0 ? Number.NaN : sum(runs) / runs.length;
}

export function capCount(runs: readonly GradedRun[]): number {
  return runs.filter((run) => run.capped).length;
}

/** |mean(b) - mean(a)| > tolerance, cross-multiplied so no rounding decides a result. */
export function meanMovesMoreThan(a: readonly GradedRun[], b: readonly GradedRun[], tolerance: number): boolean {
  return Math.abs(sum(b) * a.length - sum(a) * b.length) > tolerance * a.length * b.length;
}

export function stageOneSwapPasses(base: readonly GradedRun[], variant: readonly GradedRun[]): boolean {
  return (
    !meanMovesMoreThan(base, variant, SWAP_TOLERANCE) &&
    Math.abs(capCount(variant) - capCount(base)) <= STAGE_ONE_MAX_CAP_DIFF
  );
}

export function stageTwoSwapFails(base: readonly GradedRun[], variant: readonly GradedRun[]): boolean {
  return (
    meanMovesMoreThan(base, variant, SWAP_TOLERANCE) ||
    Math.abs(capCount(variant) - capCount(base)) > STAGE_TWO_MAX_CAP_DIFF
  );
}

export function noiseNeedsStageTwo(groupA: readonly GradedRun[], groupB: readonly GradedRun[]): boolean {
  return meanMovesMoreThan(groupA, groupB, NOISE_TOLERANCE);
}

export function noiseInconclusive(groupA: readonly GradedRun[], groupB: readonly GradedRun[]): boolean {
  return meanMovesMoreThan(groupA, groupB, NOISE_TOLERANCE);
}

/** Spec D17: this run's cap, from this run's own output only. */
export function runCapped(candidate: ParsedCandidate, recordedRequirementKeys: readonly string[]): boolean {
  return capOf({
    failedRequirements: candidate.failedRequirements,
    accommodationFields: flagFieldsOfKind(candidate.fairHousingFlags, 'accommodation'),
    recordedRequirementKeys,
    openUnlawfulFields: flagFieldsOfKind(candidate.fairHousingFlags, 'unlawful'),
  }).capped;
}

/** A control is met in a run when it raises a flag of the expected kind on one of the expected fields. */
export function controlHit(
  candidate: ParsedCandidate,
  expected: { kind: 'accommodation' | 'unlawful'; fields: readonly string[] },
): boolean {
  return candidate.fairHousingFlags.some((flag) => flag.kind === expected.kind && expected.fields.includes(baseField(flag.field)));
}
