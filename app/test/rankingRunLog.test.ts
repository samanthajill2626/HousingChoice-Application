// The ranking run (WP1 B2a spec D11): every model call is one run, with the
// batch's handles, its OWN parsed output per candidate (results[], with the
// pair's merged missing list and cappedAtRun computed from that output and
// the flags open then), cost from the price table, the environment and the
// user message gzipped. S2's putRun adds itemId, kind and the 350 KB guard.
import { describe, expect, it } from 'vitest';
import { gunzipBase64, rankingExpiresAt } from '../src/repos/matchesRepo.js';
import type { RankingCall } from '../src/services/ranking/driverTypes.js';
import { EXAMPLES_VERSION } from '../src/services/ranking/examples.js';
import type { ParsedCandidate } from '../src/services/ranking/parse.js';
import { RUBRIC_VERSION } from '../src/services/ranking/rubric.js';
import { buildRankingRun, type BuildRunInput } from '../src/services/ranking/runLog.js';
import {
  facts,
  isoAt,
  parsed,
  runningJob,
  stubBuildPrompt,
  T0,
  tenantCandidate,
  unitAnchor,
} from './helpers/rankingJobFixtures.js';

const PRICES = { 'claude-sonnet-5-5': { in: 2, out: 10 }, 'claude-opus-5-5': { in: 4, out: 20 } };
const ANCHOR = unitAnchor({ missing: [{ key: 'payment_standard', label: 'Payment standard' }] });

function promptFor(candidates: ReturnType<typeof tenantCandidate>[]) {
  return stubBuildPrompt({
    direction: 'tenants_for_property',
    batchIndex: 1,
    landlordCard: false,
    anchor: { card: ANCHOR.card, missing: ANCHOR.missing },
    candidates,
    homes: new Map(),
  });
}

function okCall(model = 'claude-sonnet-5-5'): RankingCall {
  return {
    ok: true,
    meta: {
      driver: 'anthropic',
      model,
      rawText: '{"candidates":[]}',
      usage: { inputTokens: 12_000, outputTokens: 3_000, cacheReadInputTokens: 0 },
      latencyMs: 4_200,
    },
    output: { byHandle: new Map(), droppedUnlawfulFlags: 2 },
  };
}

function input(over: Partial<BuildRunInput> = {}): BuildRunInput {
  const candidates = [tenantCandidate('t-1'), tenantCandidate('t-2', { missing: [{ key: 'area_preference', label: 'Area preference' }] })];
  const byCandidate = new Map<string, ParsedCandidate>([
    ['t-1', parsed({ score: 88 })],
    ['t-2', parsed({ score: 70, failedRequirements: ['no_pets'], unknowns: ['payment standard', 'move-in date'] })],
  ]);
  return {
    runId: 'run-9',
    job: runningJob({ generation: 'gen-7' }),
    anchor: ANCHOR,
    direction: 'tenants_for_property',
    batchIndex: 1,
    candidates,
    prompt: promptFor(candidates),
    call: okCall(),
    byCandidate,
    openByUnit: new Map(),
    startedAt: T0,
    finishedAt: isoAt(4_200),
    config: { aiPriceTable: PRICES, appEnv: 'dev', rankingPairTtlDays: 180 },
    ...over,
  };
}

describe('buildRankingRun', () => {
  it('records every D11 field for a scored batch (no key or kind: putRun adds them)', () => {
    const run = buildRankingRun(input());
    expect(run).toMatchObject({
      runId: 'run-9',
      anchorKind: 'unit',
      anchorId: 'unit-anchor',
      direction: 'tenants_for_property',
      jobGeneration: 'gen-7',
      batchIndex: 1,
      candidateCount: 2,
      driver: 'anthropic',
      model: 'claude-sonnet-5-5',
      rubricVersion: RUBRIC_VERSION,
      examplesVersion: EXAMPLES_VERSION,
      promptFingerprint: 'fp-test',
      usage: { inputTokens: 12_000, outputTokens: 3_000, cacheReadInputTokens: 0 },
      latencyMs: 4_200,
      startedAt: T0,
      finishedAt: isoAt(4_200),
      outcome: 'scored',
      rawText: '{"candidates":[]}',
      handles: [
        { handle: 'c1', candidateId: 't-1', display: 'Tenant t-1' },
        { handle: 'c2', candidateId: 't-2', display: 'Tenant t-2' },
      ],
      droppedUnlawfulFlags: 2,
      environment: 'dev',
      expires_at: rankingExpiresAt(T0, 180),
    });
    for (const key of ['itemId', 'kind', 'failure', 'matchesWritten', 'inputOmitted']) expect(key in run).toBe(false);
    expect(gunzipBase64(run.inputGzip!)).toBe(input().prompt.userText);
  });

  it('cost = in * inputTokens / 1e6 + out * outputTokens / 1e6 from the price table', () => {
    expect(buildRankingRun(input()).costUsd).toBeCloseTo((2 * 12_000) / 1e6 + (10 * 3_000) / 1e6, 6);
    expect(buildRankingRun(input({ call: okCall('claude-opus-5-5') })).costUsd).toBeCloseTo((4 * 12_000) / 1e6 + (20 * 3_000) / 1e6, 6);
    expect(buildRankingRun(input({ call: okCall('fake') })).costUsd).toBe(0);
  });

  it("results[] is this run's own output per handle, with the merged missing list (PR14) and cappedAtRun", () => {
    expect(buildRankingRun(input()).results).toEqual([
      {
        handle: 'c1', candidateId: 't-1', display: 'Tenant t-1', returned: true, score: 88,
        for: parsed().for, against: [], unknowns: [], failedRequirements: [], fairHousingFlags: [],
        missing: [{ key: 'payment_standard', text: 'Payment standard' }],
        cappedAtRun: { capped: false, capReason: null },
      },
      {
        handle: 'c2', candidateId: 't-2', display: 'Tenant t-2', returned: true, score: 70,
        for: parsed().for, against: [], unknowns: ['payment standard', 'move-in date'], failedRequirements: ['no_pets'], fairHousingFlags: [],
        // Code flags first (anchor, then candidate), then the unknowns that are not a flag's label.
        missing: [
          { key: 'payment_standard', text: 'Payment standard' },
          { key: 'area_preference', text: 'Area preference' },
          { text: 'move-in date' },
        ],
        cappedAtRun: { capped: true, capReason: 'requirement not met' },
      },
    ]);
  });

  it("cappedAtRun honors the pair's accommodation flag and the flags open at run finish", () => {
    const candidates = [tenantCandidate('t-1'), tenantCandidate('t-2')];
    const byCandidate = new Map<string, ParsedCandidate>([
      ['t-1', parsed({ failedRequirements: ['no_pets'], fairHousingFlags: [{ kind: 'accommodation', field: 'no_pets' }] })],
      ['t-2', parsed({ failedRequirements: ['qualifications'] })],
    ]);
    const run = buildRankingRun(
      input({ candidates, prompt: promptFor(candidates), byCandidate, openByUnit: new Map([['unit-anchor', ['qualifications']]]) }),
    );
    expect(run.results.map((r) => r.cappedAtRun)).toEqual([
      { capped: false, capReason: null },
      { capped: false, capReason: null },
    ]);
  });

  it('a requirement not recorded on the property never caps', () => {
    const candidates = [tenantCandidate('t-1', { propertyFacts: facts({ recordedRequirementKeys: [] }) })];
    const run = buildRankingRun(
      input({ candidates, prompt: promptFor(candidates), byCandidate: new Map([['t-1', parsed({ failedRequirements: ['no_pets'] })]]) }),
    );
    expect(run.results[0]?.cappedAtRun).toEqual({ capped: false, capReason: null });
  });

  it('a candidate the model did not return reads returned: false', () => {
    const run = buildRankingRun(input({ byCandidate: new Map([['t-1', parsed()]]) }));
    expect(run.results[1]).toEqual({ handle: 'c2', candidateId: 't-2', display: 'Tenant t-2', returned: false });
  });

  it('a failed call records outcome failed with its failure and message, and no parsed result', () => {
    const call: RankingCall = {
      ok: false,
      meta: { driver: 'anthropic', model: 'claude-sonnet-5-5', latencyMs: 120_000 },
      failure: 'timeout',
      message: 'request timed out',
    };
    const run = buildRankingRun(input({ call, byCandidate: new Map() }));
    expect(run).toMatchObject({
      outcome: 'failed',
      failure: 'timeout',
      message: 'request timed out',
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      droppedUnlawfulFlags: 0,
    });
    expect('rawText' in run).toBe(false);
    expect(run.results.every((r) => r.returned === false)).toBe(true);
  });
});
