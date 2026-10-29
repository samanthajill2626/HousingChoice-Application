// WP1 B2a spec D17: the counterfactual check's call plan - every batch built
// through the production cards and prompt (plan PR7, WI12), both
// directions, three runs per group, a twin never in the same batch as its
// twin, the swapped fact actually reaching the call text, and the stage-two
// extension only for misses. No driver, no network.
import { describe, expect, it } from 'vitest';
import { buildRankingSystemPrompt, rankingPromptFingerprint } from '../src/services/ranking/prompt.js';
import { tenantCard } from '../src/services/ranking/cards.js';
import { prepareTenant } from '../scripts/rankingCounterfactual/cards.js';
import {
  DEFAULT_SUITE,
  DIRECTIONS,
  SUBJECT_HANDLE,
  estimateCostUsd,
  planStageOne,
  planStageTwo,
  worstCaseStageTwoCalls,
  type CallResult,
  type CallSpec,
  type CounterfactualSuite,
} from '../scripts/rankingCounterfactual/plan.js';
import { BASE_PAIRS, CONTROLS } from '../scripts/rankingCounterfactual/records.js';
import { SWAPS } from '../scripts/rankingCounterfactual/swaps.js';

const plan = planStageOne(DEFAULT_SUITE);

function family(id: string): string {
  return id.split('--')[0]!;
}

describe('the stage-one plan of the default suite', () => {
  it('is 6 pairs x 2 directions x (6 base runs + 9 swaps x 3) + 3 controls x 2 directions x 3 = 414 calls', () => {
    expect(plan).toHaveLength(414);
    for (const direction of DIRECTIONS) expect(plan.filter((s) => s.direction === direction)).toHaveLength(207);
    expect(DIRECTIONS).toEqual(['tenants_for_property', 'properties_for_tenant']);
  });

  it('runs both base groups three times and every swap three times, per pair and direction', () => {
    for (const pair of BASE_PAIRS) {
      for (const direction of DIRECTIONS) {
        const mine = plan.filter((s) => s.pairId === pair.id && s.direction === direction);
        expect(mine.filter((s) => s.group === 'base-A').map((s) => s.run)).toEqual([1, 2, 3]);
        expect(mine.filter((s) => s.group === 'base-B').map((s) => s.run)).toEqual([1, 2, 3]);
        for (const swap of SWAPS) expect(mine.filter((s) => s.swapId === swap.id).map((s) => s.run)).toEqual([1, 2, 3]);
      }
    }
  });

  it('a twin never sits beside its twin: no batch holds two versions of one tenant', () => {
    for (const spec of plan) {
      const families = spec.batch.handles.map((h) => family(h.candidateId));
      expect(new Set(families).size, spec.id).toBe(families.length);
    }
  });

  it('the subject is c1; base and variant batches differ only through the swapped fact', () => {
    for (const pair of BASE_PAIRS) {
      for (const direction of DIRECTIONS) {
        const mine = plan.filter((s) => s.pairId === pair.id && s.direction === direction);
        const base = mine.find((s) => s.group === 'base-A')!;
        expect(base.subjectHandle).toBe(SUBJECT_HANDLE);
        expect(mine.find((s) => s.group === 'base-B')!.batch.user).toBe(base.batch.user);
        for (const swap of SWAPS) {
          const variant = mine.find((s) => s.swapId === swap.id)!;
          expect(variant.batch.user, `${pair.id} ${direction} ${swap.id}`).not.toBe(base.batch.user);
          expect(variant.batch.handles.slice(1)).toEqual(base.batch.handles.slice(1));
        }
      }
    }
  });

  it('every batch is the production prompt: system text, fingerprint, landlord switch off (PR7)', () => {
    for (const spec of plan) {
      expect(spec.batch.system).toBe(buildRankingSystemPrompt());
      expect(spec.batch.promptFingerprint).toBe(rankingPromptFingerprint({ landlordCard: false }));
      expect(spec.batch.landlordCard).toBe(false);
    }
  });

  it('every tenant card is the production tenantCard (WI12)', () => {
    const prepared = prepareTenant(BASE_PAIRS[0]!.tenant);
    expect(prepared.card).toEqual(tenantCard(BASE_PAIRS[0]!.tenant, prepared.ctx));
  });

  it('the controls run three times in each direction', () => {
    for (const control of CONTROLS) {
      for (const direction of DIRECTIONS) {
        expect(plan.filter((s) => s.group === 'control' && s.pairId === control.id && s.direction === direction).map((s) => s.run)).toEqual([1, 2, 3]);
      }
    }
  });

  it('every call id is unique', () => {
    expect(new Set(plan.map((s) => s.id)).size).toBe(plan.length);
  });
});

describe('stage two', () => {
  const suite: CounterfactualSuite = { basePairs: [BASE_PAIRS[0]!], swaps: SWAPS.slice(0, 2), controls: [] };
  const stageOne = planStageOne(suite);

  function graded(spec: CallSpec, score: number): CallResult {
    return { spec, graded: true, score, capped: false, latencyMs: 1, candidatesScored: 3 };
  }

  it('nothing missed: no stage-two call', () => {
    expect(planStageTwo(stageOne.map((s) => graded(s, 70)), suite)).toEqual([]);
  });

  it('a missed swap extends group A and that swap by five runs each (runs 4-8), in that direction only', () => {
    const results = stageOne.map((s) => graded(s, s.swapId === SWAPS[0]!.id && s.direction === 'tenants_for_property' ? 80 : 70));
    const two = planStageTwo(results, suite);
    expect(two.map((s) => [s.direction, s.group, s.swapId ?? '', s.run])).toEqual([
      ...[4, 5, 6, 7, 8].map((run) => ['tenants_for_property', 'base-A', '', run]),
      ...[4, 5, 6, 7, 8].map((run) => ['tenants_for_property', 'variant', SWAPS[0]!.id, run]),
    ]);
  });

  it('a noisy base extends both groups', () => {
    const results = stageOne.map((s) => graded(s, s.group === 'base-B' && s.direction === 'properties_for_tenant' ? 80 : 70));
    const two = planStageTwo(results, suite);
    expect(two.filter((s) => s.group === 'base-A')).toHaveLength(5);
    expect(two.filter((s) => s.group === 'base-B')).toHaveLength(5);
    expect(new Set(two.map((s) => s.direction))).toEqual(new Set(['properties_for_tenant']));
  });

  it('a pair and direction with an ungraded run spends no stage-two call', () => {
    const results = stageOne.map((s, i) => (i === 0 ? { spec: s, graded: false, failure: 'refusal', latencyMs: 1, candidatesScored: 0 } : graded(s, s.swapId === SWAPS[0]!.id ? 90 : 70)));
    const two = planStageTwo(results, suite);
    expect(two.every((s) => s.direction !== stageOne[0]!.direction)).toBe(true);
  });

  it('the worst case is (2 groups + swaps) x 5 per pair and direction', () => {
    expect(worstCaseStageTwoCalls(DEFAULT_SUITE)).toBe(6 * 2 * (2 + 9) * 5);
  });
});

describe('the cost estimate', () => {
  it('is a positive dollar figure in cents for a supported model', () => {
    const estimate = estimateCostUsd(plan, 'claude-sonnet-5-5');
    expect(estimate).toBeGreaterThan(0);
    expect(Math.round(estimate * 100) / 100).toBe(estimate);
  });
});
