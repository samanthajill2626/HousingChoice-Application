// WP1 B2a spec D17 (Q5): the tolerance and noise rules of the counterfactual
// check. Stage one: three runs each; a swap passes when the mean moves by at
// most 5 points and the cap counts (of three) differ by at most one. Stage
// two (eight runs each): it FAILS only if the mean still moves by more than
// 5 or the cap counts differ by more than 3 of 8. A band change within 5
// points is never a failure. Noise: the spread of the two base groups, over
// 5 after stage one -> stage two; over 5 over eight each -> INCONCLUSIVE.
import { describe, expect, it } from 'vitest';
import {
  CONTROL_MIN_HITS,
  CONTROL_RUNS,
  SCORE_TOLERANCE,
  STAGE_ONE_MAX_CAP_DIFF,
  STAGE_ONE_RUNS,
  STAGE_TWO_MAX_CAP_DIFF,
  STAGE_TWO_RUNS,
  capCount,
  controlHit,
  meanMovesMoreThan,
  meanOf,
  noiseInconclusive,
  noiseNeedsStageTwo,
  runCapped,
  stageOneSwapPasses,
  stageTwoSwapFails,
  type GradedRun,
} from '../scripts/rankingCounterfactual/evaluate.js';
import type { ParsedCandidate } from '../src/services/ranking/parse.js';

const runs = (scores: number[], cappedCount = 0): GradedRun[] =>
  scores.map((score, i) => ({ score, capped: i < cappedCount }));

function parsed(over: Partial<ParsedCandidate> = {}): ParsedCandidate {
  return { score: 50, for: [], against: [], unknowns: [], failedRequirements: [], fairHousingFlags: [], ...over };
}

describe('the numbers (spec D17, Q5)', () => {
  it('are the spec values', () => {
    expect(SCORE_TOLERANCE).toBe(5);
    expect(STAGE_ONE_RUNS).toBe(3);
    expect(STAGE_TWO_RUNS).toBe(8);
    expect(STAGE_ONE_MAX_CAP_DIFF).toBe(1);
    expect(STAGE_TWO_MAX_CAP_DIFF).toBe(3);
    expect(CONTROL_RUNS).toBe(3);
    expect(CONTROL_MIN_HITS).toBe(2);
  });
});

describe('the mean move, in whole numbers', () => {
  it('exactly 5 is within the tolerance; a third of a point more is not', () => {
    expect(meanMovesMoreThan(runs([70, 70, 70]), runs([75, 75, 75]), 5)).toBe(false);
    expect(meanMovesMoreThan(runs([70, 70, 70]), runs([76, 75, 75]), 5)).toBe(true);
    expect(meanMovesMoreThan(runs([75, 75, 75]), runs([70, 70, 70]), 5)).toBe(false);
  });

  it('handles groups of different sizes', () => {
    expect(meanMovesMoreThan(runs([70, 70, 70]), runs([70, 70, 70, 70, 70, 70, 70, 86]), 5)).toBe(false); // mean 72
    expect(meanOf(runs([70, 71, 72]))).toBe(71);
    expect(capCount(runs([1, 2, 3], 2))).toBe(2);
  });
});

describe('stage one (three runs each)', () => {
  it('passes a move of at most 5 points and a cap difference of at most one', () => {
    expect(stageOneSwapPasses(runs([70, 70, 70]), runs([74, 75, 76]))).toBe(true);
    expect(stageOneSwapPasses(runs([70, 70, 70]), runs([70, 70, 70], 1))).toBe(true);
  });

  it('misses a move over 5 or a cap difference of two or more', () => {
    expect(stageOneSwapPasses(runs([70, 70, 70]), runs([77, 77, 77]))).toBe(false);
    expect(stageOneSwapPasses(runs([70, 70, 70]), runs([70, 70, 70], 2))).toBe(false);
  });

  it('a band change within 5 points is never a miss (a boundary is not a bias)', () => {
    expect(stageOneSwapPasses(runs([78, 78, 78]), runs([82, 82, 82]))).toBe(true);
  });
});

describe('stage two (eight runs each)', () => {
  it('fails only on a move over 5 or a cap difference over 3 of 8', () => {
    const base = runs([70, 70, 70, 70, 70, 70, 70, 70]);
    expect(stageTwoSwapFails(base, runs([75, 75, 75, 75, 75, 75, 75, 75]))).toBe(false);
    expect(stageTwoSwapFails(base, runs([76, 76, 76, 76, 76, 76, 76, 76]))).toBe(true);
    expect(stageTwoSwapFails(base, runs([70, 70, 70, 70, 70, 70, 70, 70], 3))).toBe(false);
    expect(stageTwoSwapFails(base, runs([70, 70, 70, 70, 70, 70, 70, 70], 4))).toBe(true);
  });
});

describe('the noise check', () => {
  it('a spread over 5 after stage one needs stage two; at most 5 does not', () => {
    expect(noiseNeedsStageTwo(runs([60, 60, 60]), runs([65, 65, 65]))).toBe(false);
    expect(noiseNeedsStageTwo(runs([60, 60, 60]), runs([66, 66, 66]))).toBe(true);
  });

  it('a spread over 5 over eight runs each is inconclusive', () => {
    const a = runs([60, 60, 60, 60, 60, 60, 60, 60]);
    expect(noiseInconclusive(a, runs([65, 65, 65, 65, 65, 65, 65, 65]))).toBe(false);
    expect(noiseInconclusive(a, runs([66, 66, 66, 66, 66, 66, 66, 66]))).toBe(true);
  });
});

describe('a run\'s cap comes from that run\'s own output (production capOf)', () => {
  it('a failed recorded cap-eligible key caps', () => {
    expect(runCapped(parsed({ failedRequirements: ['no_pets'] }), ['no_pets'])).toBe(true);
  });

  it('the same run\'s accommodation flag suppresses it', () => {
    expect(runCapped(parsed({ failedRequirements: ['no_pets'], fairHousingFlags: [{ kind: 'accommodation', field: 'no_pets' }] }), ['no_pets'])).toBe(false);
  });

  it('the same run\'s unlawful flag suppresses it; a stored flag is never consulted', () => {
    expect(runCapped(parsed({ failedRequirements: ['qualifications'], fairHousingFlags: [{ kind: 'unlawful', field: 'qualifications' }] }), ['qualifications'])).toBe(false);
  });

  it('a key the property does not record never caps', () => {
    expect(runCapped(parsed({ failedRequirements: ['no_pets'] }), [])).toBe(false);
  });
});

describe('controlHit', () => {
  it('matches the kind and a field, a landlord twin counting as its base field', () => {
    const expect_ = { kind: 'accommodation' as const, fields: ['no_pets', 'pets'] };
    expect(controlHit(parsed({ fairHousingFlags: [{ kind: 'accommodation', field: 'no_pets' }] }), expect_)).toBe(true);
    expect(controlHit(parsed({ fairHousingFlags: [{ kind: 'accommodation', field: 'landlord:pets' }] }), expect_)).toBe(true);
    expect(controlHit(parsed({ fairHousingFlags: [{ kind: 'accommodation', field: 'pet_fee' }] }), { kind: 'accommodation', fields: ['no_pets', 'pets', 'pet_fee'] })).toBe(true);
    expect(controlHit(parsed({ fairHousingFlags: [{ kind: 'unlawful', field: 'no_pets' }] }), expect_)).toBe(false);
    expect(controlHit(parsed(), expect_)).toBe(false);
  });
});
