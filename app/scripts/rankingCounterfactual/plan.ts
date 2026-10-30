// WP1 B2a spec D17: the counterfactual check's call plan. For each base pair
// and BOTH directions - the tenant as a candidate of the property (a property
// anchor) and the tenant as the anchor scoring properties - three runs of
// base group A, three of base group B (the noise check) and three of each
// swap; then each control three times in each direction (plan C2). Every
// call holds ONE version of the subject at c1 plus the same two fixed fillers
// (C3), so a twin never sits beside its twin and base and variant batches
// are otherwise identical. Batches are built with the production cards
// (cards.ts) and buildRankingBatch; only the pool is bypassed. Stage two
// adds five runs (runs 4-8) to group A and a missed swap, or to both groups
// for a noisy base - never for a pair and direction holding an ungraded run
// (C6).
//
// TARGETED mode (spec rev 9; Cameron: "If we need to retest, lets just retest
// these ones only before we retest the whole thing"): a suite with `only`
// set runs the base groups only for the named pair and direction pairs, and
// only the named swaps, through the same two stages; no controls. A targeted
// run is never the gate (report.ts marks its record section).
import { DEFAULT_AI_PRICE_TABLE } from '../../src/lib/config.js';
import type { ContactItem } from '../../src/repos/contactsRepo.js';
import type { UnitItem } from '../../src/repos/unitsRepo.js';
import { costUsd } from '../../src/services/ranking/cost.js';
import type { RankingUsage } from '../../src/services/ranking/driverTypes.js';
import type { ParsedCandidate } from '../../src/services/ranking/parse.js';
import { buildRankingBatch, type RankingBatchInput } from '../../src/services/ranking/prompt.js';
import type { Direction, PairHistory } from '../../src/services/ranking/types.js';
import { prepareProperty, prepareTenant } from './cards.js';
import { CONTROL_RUNS, STAGE_ONE_RUNS, STAGE_TWO_RUNS, noiseNeedsStageTwo, stageOneSwapPasses, type GradedRun } from './evaluate.js';
import { BASE_PAIRS, CONTROLS, fillerTenantsFor, fillerUnitsFor, type BasePair, type Control } from './records.js';
import { SWAPS, type Swap } from './swaps.js';

export const DIRECTIONS: readonly Direction[] = Object.freeze(['tenants_for_property', 'properties_for_tenant'] as const);
export const SUBJECT_HANDLE = 'c1';
/** C9: the planning estimate - 4 characters a token in, 2,500 tokens a call out. */
export const CHARS_PER_TOKEN_ESTIMATE = 4;
export const ESTIMATED_OUTPUT_TOKENS_PER_CALL = 2500;

const EMPTY_PAIR_HISTORY: PairHistory = { sends: [], declined: null, tours: [], daysSinceLastSend: null };

/** One --only target: a base pair, a direction and one swap. */
export interface OnlyTarget {
  pairId: string;
  direction: Direction;
  swapId: string;
}

export interface CounterfactualSuite {
  basePairs: readonly BasePair[];
  swaps: readonly Swap[];
  controls: readonly Control[];
  /** TARGETED mode (--only): run only these swaps (with their pair and direction base groups) and no control. */
  only?: readonly OnlyTarget[];
}

export const DEFAULT_SUITE: CounterfactualSuite = { basePairs: BASE_PAIRS, swaps: SWAPS, controls: CONTROLS };

/** The --only list format, for usage messages. */
export const ONLY_FORMAT = 'P<n>:<direction>:<swap>[,P<n>:<direction>:<swap>...]';

/** "P2:tenants_for_property:sogi" - the text form of a target. */
export function onlyTargetText(t: OnlyTarget): string {
  return `${t.pairId}:${t.direction}:${t.swapId}`;
}

/**
 * Parses an --only list against the suite: comma-separated
 * P<n>:<direction>:<swap>, each naming a base pair, a direction and a swap of
 * the suite. Duplicates collapse; the order kept is the list's. Anything
 * else is a usage error (the caller exits 2 having called nothing).
 */
export function parseOnlyTargets(text: string, suite: CounterfactualSuite): OnlyTarget[] | { usage: string } {
  const items = text.split(',').map((item) => item.trim()).filter((item) => item.length > 0);
  if (items.length === 0) return { usage: `--only needs at least one target (${ONLY_FORMAT})` };
  const out: OnlyTarget[] = [];
  for (const item of items) {
    const parts = item.split(':').map((part) => part.trim());
    if (parts.length !== 3) return { usage: `--only target "${item}" is not ${'P<n>:<direction>:<swap>'}` };
    const [pairId, direction, swapId] = parts as [string, string, string];
    if (!/^P\d+$/.test(pairId) || !suite.basePairs.some((p) => p.id === pairId)) {
      return { usage: `--only target "${item}": unknown base pair "${pairId}" (one of ${suite.basePairs.map((p) => p.id).join(', ')})` };
    }
    if (!(DIRECTIONS as readonly string[]).includes(direction)) {
      return { usage: `--only target "${item}": unknown direction "${direction}" (one of ${DIRECTIONS.join(', ')})` };
    }
    if (!suite.swaps.some((s) => s.id === swapId)) {
      return { usage: `--only target "${item}": unknown swap "${swapId}" (one of ${suite.swaps.map((s) => s.id).join(', ')})` };
    }
    const target: OnlyTarget = { pairId, direction: direction as Direction, swapId };
    if (!out.some((t) => onlyTargetText(t) === onlyTargetText(target))) out.push(target);
  }
  return out;
}

/** One base pair and direction the run covers, with the swaps it runs there. */
export interface Selection {
  pair: BasePair;
  direction: Direction;
  swaps: readonly Swap[];
}

/**
 * The pairs, directions and swaps a run covers, in suite order: all of them
 * for the full check; for a targeted run only the named pair and direction
 * pairs, each with only its named swaps.
 */
export function selectionOf(suite: CounterfactualSuite): Selection[] {
  const out: Selection[] = [];
  for (const pair of suite.basePairs) {
    for (const direction of DIRECTIONS) {
      if (suite.only === undefined) {
        out.push({ pair, direction, swaps: suite.swaps });
        continue;
      }
      const named = suite.only.filter((t) => t.pairId === pair.id && t.direction === direction).map((t) => t.swapId);
      if (named.length > 0) out.push({ pair, direction, swaps: suite.swaps.filter((s) => named.includes(s.id)) });
    }
  }
  return out;
}

/** The controls a run covers: every one for the full check, none for a targeted run. */
export function controlsOf(suite: CounterfactualSuite): readonly Control[] {
  return suite.only === undefined ? suite.controls : [];
}

export type CallGroup = 'base-A' | 'base-B' | 'variant' | 'control' | 'timing';

export interface CallSpec {
  id: string;
  group: CallGroup;
  /** The base pair's or control's id ('timing' for the timing batch). */
  pairId: string;
  swapId?: string;
  direction: Direction;
  run: number;
  batch: RankingBatchInput;
  subjectHandle: string;
  /** The pair property's recorded requirement keys (production propertyFacts), for the run's cap. */
  recordedRequirementKeys: readonly string[];
}

export interface CallResult {
  spec: CallSpec;
  /** The call answered and scored the subject. */
  graded: boolean;
  score?: number;
  capped?: boolean;
  parsed?: ParsedCandidate;
  /** A driver failure kind, or 'not_scored' when the call answered without the subject. */
  failure?: string;
  message?: string;
  usage?: RankingUsage;
  latencyMs: number;
  candidatesScored: number;
}

export interface PreparedBatch {
  batch: RankingBatchInput;
  recordedRequirementKeys: readonly string[];
}

export function pairBatch(
  direction: Direction,
  tenant: ContactItem,
  unit: UnitItem,
  fillers: { tenants: readonly ContactItem[]; units: readonly UnitItem[] },
): PreparedBatch {
  const property = prepareProperty(unit);
  if (direction === 'tenants_for_property') {
    const tenants = [tenant, ...fillers.tenants].map(prepareTenant);
    const batch = buildRankingBatch({
      direction,
      batchIndex: 0,
      landlordCard: false,
      anchor: { card: property.card, missing: property.missing },
      candidates: tenants.map((t) => ({
        candidateId: t.contactId,
        unitId: unit.unitId,
        card: t.card,
        missing: t.missing,
        authority: property.authority,
        pairHistory: EMPTY_PAIR_HISTORY,
        propertyFacts: property.facts,
      })),
      homes: new Map(),
    });
    return { batch, recordedRequirementKeys: property.facts.recordedRequirementKeys };
  }
  const anchor = prepareTenant(tenant);
  const properties = [property, ...fillers.units.map(prepareProperty)];
  const batch = buildRankingBatch({
    direction,
    batchIndex: 0,
    landlordCard: false,
    anchor: { card: anchor.card, missing: anchor.missing },
    candidates: properties.map((p) => ({
      candidateId: p.unitId,
      unitId: p.unitId,
      card: p.card,
      missing: p.missing,
      authority: p.authority,
      pairHistory: EMPTY_PAIR_HISTORY,
      propertyFacts: p.facts,
    })),
    homes: new Map(),
  });
  return { batch, recordedRequirementKeys: property.facts.recordedRequirementKeys };
}

function makeSpec(
  group: CallGroup,
  pairId: string,
  swapId: string | undefined,
  direction: Direction,
  run: number,
  prepared: PreparedBatch,
): CallSpec {
  const label = swapId === undefined ? group : `variant:${swapId}`;
  return {
    id: `${pairId}/${direction}/${label}/${run}`,
    group,
    pairId,
    ...(swapId === undefined ? {} : { swapId }),
    direction,
    run,
    batch: prepared.batch,
    subjectHandle: SUBJECT_HANDLE,
    recordedRequirementKeys: prepared.recordedRequirementKeys,
  };
}

function fillersFor(subject: ContactItem): { tenants: ContactItem[]; units: UnitItem[] } {
  return { tenants: fillerTenantsFor(subject), units: fillerUnitsFor(subject) };
}

export function planStageOne(suite: CounterfactualSuite): CallSpec[] {
  const specs: CallSpec[] = [];
  for (const { pair, direction, swaps } of selectionOf(suite)) {
    const fillers = fillersFor(pair.tenant);
    const base = pairBatch(direction, pair.tenant, pair.unit, fillers);
    for (const group of ['base-A', 'base-B'] as const) {
      for (let run = 1; run <= STAGE_ONE_RUNS; run += 1) specs.push(makeSpec(group, pair.id, undefined, direction, run, base));
    }
    for (const swap of swaps) {
      const variant = pairBatch(direction, swap.apply(pair), pair.unit, fillers);
      for (let run = 1; run <= STAGE_ONE_RUNS; run += 1) specs.push(makeSpec('variant', pair.id, swap.id, direction, run, variant));
    }
  }
  for (const control of controlsOf(suite)) {
    const fillers = fillersFor(control.tenant);
    for (const direction of DIRECTIONS) {
      const prepared = pairBatch(direction, control.tenant, control.unit, fillers);
      for (let run = 1; run <= CONTROL_RUNS; run += 1) specs.push(makeSpec('control', control.id, undefined, direction, run, prepared));
    }
  }
  return specs;
}

export interface PairRuns {
  pairId: string;
  about: string;
  direction: Direction;
  groupA: CallResult[];
  groupB: CallResult[];
  variants: Array<{ swapId: string; runs: CallResult[] }>;
}

function byRun(results: readonly CallResult[]): CallResult[] {
  return [...results].sort((x, y) => x.spec.run - y.spec.run);
}

/** The base-pair results grouped per pair and direction, in suite order, runs ascending. */
export function pairRuns(results: readonly CallResult[], suite: CounterfactualSuite): PairRuns[] {
  const out: PairRuns[] = [];
  for (const { pair, direction, swaps } of selectionOf(suite)) {
    const mine = results.filter((r) => r.spec.pairId === pair.id && r.spec.direction === direction);
    out.push({
      pairId: pair.id,
      about: pair.about,
      direction,
      groupA: byRun(mine.filter((r) => r.spec.group === 'base-A')),
      groupB: byRun(mine.filter((r) => r.spec.group === 'base-B')),
      variants: swaps.map((swap) => ({
        swapId: swap.id,
        runs: byRun(mine.filter((r) => r.spec.group === 'variant' && r.spec.swapId === swap.id)),
      })),
    });
  }
  return out;
}

export function gradedRuns(results: readonly CallResult[]): GradedRun[] {
  return results.filter((r) => r.graded).map((r) => ({ score: r.score!, capped: r.capped! }));
}

export function allGraded(p: PairRuns): boolean {
  return [...p.groupA, ...p.groupB, ...p.variants.flatMap((v) => v.runs)].every((r) => r.graded);
}

function extend(template: CallSpec): CallSpec[] {
  const out: CallSpec[] = [];
  for (let run = STAGE_ONE_RUNS + 1; run <= STAGE_TWO_RUNS; run += 1) {
    out.push({ ...template, id: template.id.replace(/\/\d+$/, `/${run}`), run });
  }
  return out;
}

export function planStageTwo(stageOne: readonly CallResult[], suite: CounterfactualSuite): CallSpec[] {
  const out: CallSpec[] = [];
  for (const p of pairRuns(stageOne, suite)) {
    if (!allGraded(p) || p.groupA.length === 0 || p.groupB.length === 0) continue;
    const a = gradedRuns(p.groupA);
    const noisy = noiseNeedsStageTwo(a, gradedRuns(p.groupB));
    const missed = p.variants.filter((v) => v.runs.length > 0 && !stageOneSwapPasses(a, gradedRuns(v.runs)));
    if (noisy || missed.length > 0) out.push(...extend(p.groupA[0]!.spec));
    if (noisy) out.push(...extend(p.groupB[0]!.spec));
    for (const v of missed) out.push(...extend(v.runs[0]!.spec));
  }
  return out;
}

export function worstCaseStageTwoCalls(suite: CounterfactualSuite): number {
  return selectionOf(suite).reduce((total, s) => total + (2 + s.swaps.length) * (STAGE_TWO_RUNS - STAGE_ONE_RUNS), 0);
}

/** C9: a planning estimate in dollars (built-in prices), rounded to the cent. */
export function estimateCostUsd(specs: readonly CallSpec[], model: string): number {
  let dollars = 0;
  for (const spec of specs) {
    const inputTokens = Math.ceil((spec.batch.system.length + spec.batch.user.length) / CHARS_PER_TOKEN_ESTIMATE);
    dollars += costUsd(model, { inputTokens, outputTokens: ESTIMATED_OUTPUT_TOKENS_PER_CALL }, DEFAULT_AI_PRICE_TABLE);
  }
  return Math.round(dollars * 100) / 100;
}
