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
  controlsOf,
  estimateCostUsd,
  onlyTargetText,
  parseOnlyTargets,
  planStageOne,
  planStageTwo,
  selectionOf,
  worstCaseStageTwoCalls,
  type CallResult,
  type CallSpec,
  type CounterfactualSuite,
  type OnlyTarget,
} from '../scripts/rankingCounterfactual/plan.js';
import { BASE_PAIRS, CONTROLS } from '../scripts/rankingCounterfactual/records.js';
import { SWAPS } from '../scripts/rankingCounterfactual/swaps.js';

const plan = planStageOne(DEFAULT_SUITE);

/** Charter section 20 items 18 and 19: the swaps whose fact is on no card, with the stored fields each changes. */
const ABSENT_SWAPS = ['name', 'address', 'authority'];
const ABSENT_FIELDS: Record<string, string[]> = { name: ['firstName', 'lastName'], address: ['address'], authority: ['housingAuthority'] };

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
          expect(variant.batch.handles.slice(1)).toEqual(base.batch.handles.slice(1));
          // Charter section 20 items 18 and 19: the authority, name and address
          // swaps must NOT reach the call text (their guard is the next test).
          if (ABSENT_SWAPS.includes(swap.id)) continue;
          expect(variant.batch.user, `${pair.id} ${direction} ${swap.id}`).not.toBe(base.batch.user);
        }
      }
    }
  });

  it('charter section 20 items 18 and 19: the authority, name and address swaps leave the model input byte-identical (they now test the absence)', () => {
    for (const swapId of ABSENT_SWAPS) {
      const swap = SWAPS.find((s) => s.id === swapId)!;
      for (const pair of BASE_PAIRS) {
        const swapped = swap.apply(pair);
        // The swap still changes the stored record ...
        const fields = ABSENT_FIELDS[swapId]!;
        expect(fields.some((f) => JSON.stringify(swapped[f]) !== JSON.stringify(pair.tenant[f])), `${swapId} ${pair.id}`).toBe(true);
        for (const direction of DIRECTIONS) {
          const mine = plan.filter((s) => s.pairId === pair.id && s.direction === direction);
          const base = mine.find((s) => s.group === 'base-A')!;
          const variant = mine.find((s) => s.swapId === swapId)!;
          const where = `${swapId} ${pair.id} ${direction}`;
          // ... but not one byte of what the model is sent.
          expect(variant.batch.system, where).toBe(base.batch.system);
          expect(variant.batch.user, where).toBe(base.batch.user);
          expect(variant.batch.promptFingerprint, where).toBe(base.batch.promptFingerprint);
          expect(variant.batch.wire, where).toEqual(base.batch.wire);
          // Neither the base value nor the swapped one is in the request: a
          // one-word value (a name) as a whole word, a longer one as text, an
          // address as its JSON.
          const words = new Set(variant.batch.user.split(/[^A-Za-z0-9]+/));
          for (const record of [pair.tenant, swapped]) {
            for (const f of fields) {
              const value = record[f];
              if (value === undefined) continue;
              const line1 = (value as { line1?: unknown } | null)?.line1;
              const present =
                typeof value !== 'string'
                  ? variant.batch.user.includes(JSON.stringify(value)) ||
                    (typeof line1 === 'string' && variant.batch.user.includes(JSON.stringify(line1)))
                  : /\s/.test(value.trim())
                    ? variant.batch.user.includes(value)
                    : words.has(value.trim());
              expect(present, `${where} ${f}`).toBe(false);
            }
          }
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

// Spec rev 9 (Cameron: "If we need to retest, lets just retest these ones
// only before we retest the whole thing"): the --only targets and the
// targeted plan. A targeted run is never the gate.
const GATE_SHEET_ONLY =
  'P2:tenants_for_property:sogi,P3:properties_for_tenant:address,P3:properties_for_tenant:sogi,P3:properties_for_tenant:authority,' +
  'P2:tenants_for_property:credit_income,P3:properties_for_tenant:credit_income,P3:tenants_for_property:authority,P3:tenants_for_property:sogi';

function gradedRun(spec: CallSpec, score: number): CallResult {
  return { spec, graded: true, score, capped: false, latencyMs: 1, candidatesScored: 3 };
}

function targetsOf(text: string): OnlyTarget[] {
  const parsed = parseOnlyTargets(text, DEFAULT_SUITE);
  if ('usage' in parsed) throw new Error(parsed.usage);
  return parsed;
}

describe('parseOnlyTargets (--only)', () => {
  it('reads comma-separated P<n>:<direction>:<swap>, trimmed, in list order, duplicates collapsed', () => {
    expect(targetsOf(' P3:properties_for_tenant:sogi , P2:tenants_for_property:sogi,P3:properties_for_tenant:sogi,')).toEqual([
      { pairId: 'P3', direction: 'properties_for_tenant', swapId: 'sogi' },
      { pairId: 'P2', direction: 'tenants_for_property', swapId: 'sogi' },
    ]);
    expect(targetsOf(GATE_SHEET_ONLY).map(onlyTargetText)).toEqual(GATE_SHEET_ONLY.split(','));
  });

  it('an unknown pair, direction or swap, a malformed target or an empty list is a usage error', () => {
    const usage = (text: string): string => {
      const parsed = parseOnlyTargets(text, DEFAULT_SUITE);
      return 'usage' in parsed ? parsed.usage : '';
    };
    expect(usage('P9:tenants_for_property:sogi')).toMatch(/unknown base pair "P9"/);
    expect(usage('C1:tenants_for_property:sogi')).toMatch(/unknown base pair "C1"/);
    expect(usage('P3:sideways:sogi')).toMatch(/unknown direction "sideways"/);
    expect(usage('P3:properties_for_tenant:height')).toMatch(/unknown swap "height"/);
    expect(usage('P3:properties_for_tenant')).toMatch(/is not P<n>:<direction>:<swap>/);
    expect(usage('P3:properties_for_tenant:sogi:extra')).toMatch(/is not P<n>:<direction>:<swap>/);
    expect(usage(' , ')).toMatch(/at least one target/);
  });
});

describe('the targeted plan (--only)', () => {
  const targeted: CounterfactualSuite = { ...DEFAULT_SUITE, only: targetsOf(GATE_SHEET_ONLY) };
  const specs = planStageOne(targeted);

  it('runs base groups A and B only for the named pair and direction pairs, and only the named swaps; no controls', () => {
    expect(selectionOf(targeted).map((s) => [s.pair.id, s.direction, s.swaps.map((w) => w.id)])).toEqual([
      ['P2', 'tenants_for_property', ['credit_income', 'sogi']],
      ['P3', 'tenants_for_property', ['sogi', 'authority']],
      ['P3', 'properties_for_tenant', ['address', 'credit_income', 'sogi', 'authority']],
    ]);
    // 3 pair and direction pairs x 6 base runs + 8 swaps x 3 = 42.
    expect(specs).toHaveLength(42);
    expect(specs.filter((s) => s.group === 'control')).toEqual([]);
    expect(controlsOf(targeted)).toEqual([]);
    expect(new Set(specs.filter((s) => s.group === 'variant').map((s) => `${s.pairId}:${s.direction}:${s.swapId}`))).toEqual(
      new Set(GATE_SHEET_ONLY.split(',')),
    );
    for (const group of ['base-A', 'base-B'] as const) expect(specs.filter((s) => s.group === group)).toHaveLength(9);
  });

  it('its batches are the full plan\'s batches, byte for byte', () => {
    for (const spec of specs) {
      const same = plan.find((s) => s.id === spec.id);
      expect(same, spec.id).toBeDefined();
      expect(spec.batch.user, spec.id).toBe(same!.batch.user);
    }
  });

  it('stage two follows the same rules, and the worst case counts only the targets', () => {
    expect(worstCaseStageTwoCalls(targeted)).toBe((3 * 2 + 8) * 5);
    const results = specs.map((s) => gradedRun(s, s.swapId === 'sogi' && s.pairId === 'P3' && s.direction === 'properties_for_tenant' ? 90 : 70));
    const two = planStageTwo(results, targeted);
    expect(two.map((s) => [s.group, s.swapId ?? '-', s.run])).toEqual([
      ...[4, 5, 6, 7, 8].map((run) => ['base-A', '-', run]),
      ...[4, 5, 6, 7, 8].map((run) => ['variant', 'sogi', run]),
    ]);
  });

  it('without --only the suite is the full check: every pair, direction, swap and control', () => {
    expect(selectionOf(DEFAULT_SUITE)).toHaveLength(BASE_PAIRS.length * 2);
    expect(controlsOf(DEFAULT_SUITE)).toBe(CONTROLS);
  });
});
