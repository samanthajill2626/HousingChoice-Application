// WP1 B2a spec D17: the counterfactual check's verdict and its mission
// record. The verdict:
// - FAIL when any run is ungraded (a call failed or did not score the
//   subject; plan C6), any swap of a pair that is NOT inconclusive fails its
//   tolerance, or any control is not met (graded in all three runs, its flag
//   in at least two, never capped);
// - otherwise DECIDE when any base pair is INCONCLUSIVE (its own runs spread
//   more than the tolerance over eight runs each): Cameron decides;
// - otherwise PASS.
// What the record holds (spec D17; plan C12 as WORKLIST WL-S8-11 words it):
// per base pair and direction, every run's SCORE (groups A and B, and each
// swap's variant runs) and each group's cap COUNT - a swap row carries no
// per-run cap and no flags, so an unexpected flag on a base or variant run
// does not appear; per control and direction, every run's score with how
// many runs raised the expected flag and how many were capped; every
// ungraded run with its failure; the call count, tokens and cost. Raw model
// text is not in it.
import { DEFAULT_AI_PRICE_TABLE } from '../../src/lib/config.js';
import { costUsd } from '../../src/services/ranking/cost.js';
import { EXAMPLES_VERSION } from '../../src/services/ranking/examples.js';
import { RUBRIC_VERSION } from '../../src/services/ranking/rubric.js';
import type { Direction } from '../../src/services/ranking/types.js';
import {
  CONTROL_MIN_HITS,
  CONTROL_RUNS,
  SCORE_TOLERANCE,
  STAGE_ONE_RUNS,
  STAGE_TWO_RUNS,
  capCount,
  controlHit,
  meanOf,
  noiseInconclusive,
  stageOneSwapPasses,
  stageTwoSwapFails,
  type GradedRun,
} from './evaluate.js';
import { DIRECTIONS, gradedRuns, pairRuns, type CallResult, type CounterfactualSuite } from './plan.js';

export type CheckVerdict = 'PASS' | 'FAIL' | 'DECIDE';

export interface SwapVerdict {
  swapId: string;
  stage: 1 | 2;
  baseScores: number[];
  variantScores: number[];
  baseCaps: number;
  variantCaps: number;
  meanMove: number;
  verdict: 'pass' | 'fail' | 'ungraded';
}

export interface PairVerdict {
  pairId: string;
  about: string;
  direction: Direction;
  ungradedCalls: string[];
  groupA: number[];
  groupB: number[];
  spreadStageOne: number | null;
  spreadStageTwo: number | null;
  inconclusive: boolean;
  swaps: SwapVerdict[];
}

export interface ControlVerdict {
  controlId: string;
  about: string;
  direction: Direction;
  expect: string;
  scores: Array<number | null>;
  graded: number;
  hits: number;
  capped: number;
  verdict: 'pass' | 'fail';
}

export interface CheckResult {
  verdict: CheckVerdict;
  reasons: string[];
  pairs: PairVerdict[];
  controls: ControlVerdict[];
  ungraded: CallResult[];
  stageOneCalls: number;
  stageTwoCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function move(a: readonly GradedRun[], b: readonly GradedRun[]): number {
  return a.length === 0 || b.length === 0 ? 0 : round2(Math.abs(meanOf(b) - meanOf(a)));
}

export function evaluateCheck(
  results: readonly CallResult[],
  suite: CounterfactualSuite,
  opts: { model: string; stageOneCalls: number; stageTwoCalls: number },
): CheckResult {
  const pairs: PairVerdict[] = pairRuns(results, suite).map((p) => {
    const ungradedCalls = [...p.groupA, ...p.groupB, ...p.variants.flatMap((v) => v.runs)]
      .filter((r) => !r.graded)
      .map((r) => r.spec.id);
    const ok = ungradedCalls.length === 0;
    const aAll = gradedRuns(p.groupA);
    const bAll = gradedRuns(p.groupB);
    const a3 = aAll.slice(0, STAGE_ONE_RUNS);
    const b3 = bAll.slice(0, STAGE_ONE_RUNS);
    const extended = bAll.length === STAGE_TWO_RUNS;
    const inconclusive = ok && extended && noiseInconclusive(aAll, bAll);
    const swaps: SwapVerdict[] = p.variants.map((v) => {
      const vAll = gradedRuns(v.runs);
      const stage: 1 | 2 = vAll.length === STAGE_TWO_RUNS ? 2 : 1;
      const base = stage === 2 ? aAll : a3;
      let verdict: SwapVerdict['verdict'];
      if (!ok) verdict = 'ungraded';
      else if (stage === 2) verdict = stageTwoSwapFails(base, vAll) ? 'fail' : 'pass';
      else verdict = stageOneSwapPasses(base, vAll) ? 'pass' : 'fail';
      return {
        swapId: v.swapId,
        stage,
        baseScores: base.map((r) => r.score),
        variantScores: vAll.map((r) => r.score),
        baseCaps: capCount(base),
        variantCaps: capCount(vAll),
        meanMove: move(base, vAll),
        verdict,
      };
    });
    return {
      pairId: p.pairId,
      about: p.about,
      direction: p.direction,
      ungradedCalls,
      groupA: aAll.map((r) => r.score),
      groupB: bAll.map((r) => r.score),
      spreadStageOne: ok ? move(a3, b3) : null,
      spreadStageTwo: ok && extended ? move(aAll, bAll) : null,
      inconclusive,
      swaps,
    };
  });

  const controls: ControlVerdict[] = [];
  for (const control of suite.controls) {
    for (const direction of DIRECTIONS) {
      const runs = results
        .filter((r) => r.spec.group === 'control' && r.spec.pairId === control.id && r.spec.direction === direction)
        .sort((x, y) => x.spec.run - y.spec.run);
      const graded = runs.filter((r) => r.graded);
      const hits = graded.filter((r) => controlHit(r.parsed!, control.expect)).length;
      const capped = graded.filter((r) => r.capped === true).length;
      const pass = runs.length === CONTROL_RUNS && graded.length === CONTROL_RUNS && hits >= CONTROL_MIN_HITS && capped === 0;
      controls.push({
        controlId: control.id,
        about: control.about,
        direction,
        expect: `${control.expect.kind} flag on ${control.expect.fields.join(' or ')}`,
        scores: runs.map((r) => (r.graded ? r.score! : null)),
        graded: graded.length,
        hits,
        capped,
        verdict: pass ? 'pass' : 'fail',
      });
    }
  }

  const ungraded = results.filter((r) => !r.graded);
  const reasons: string[] = [];
  if (ungraded.length > 0) reasons.push(`${ungraded.length} ungraded run(s): a call failed or did not score the subject`);
  for (const p of pairs) {
    if (p.ungradedCalls.length > 0 || p.inconclusive) continue;
    for (const s of p.swaps) {
      if (s.verdict === 'fail') reasons.push(`swap ${s.swapId} on ${p.pairId} (${p.direction}) moved the result beyond the tolerance`);
    }
  }
  for (const c of controls) {
    if (c.verdict === 'fail') reasons.push(`control ${c.controlId} (${c.direction}) not met: ${c.hits} of ${c.graded} runs flagged, ${c.capped} capped`);
  }
  const verdict: CheckVerdict = reasons.length > 0 ? 'FAIL' : pairs.some((p) => p.inconclusive) ? 'DECIDE' : 'PASS';
  for (const p of pairs.filter((x) => x.inconclusive)) {
    reasons.push(`base pair ${p.pairId} (${p.direction}) is INCONCLUSIVE: its own runs spread more than ${SCORE_TOLERANCE} points; Cameron decides`);
  }

  let inputTokens = 0;
  let outputTokens = 0;
  for (const r of results) {
    if (r.usage !== undefined) {
      inputTokens += r.usage.inputTokens;
      outputTokens += r.usage.outputTokens;
    }
  }
  return {
    verdict,
    reasons,
    pairs,
    controls,
    ungraded,
    stageOneCalls: opts.stageOneCalls,
    stageTwoCalls: opts.stageTwoCalls,
    inputTokens,
    outputTokens,
    costUsd: costUsd(opts.model, { inputTokens, outputTokens }, DEFAULT_AI_PRICE_TABLE),
  };
}

export interface RecordHeader {
  now: string;
  model: string;
  keyTail: string;
  endpoint: string;
  promptFingerprint: string;
}

/** Model error text reaches the record: printable ASCII only, bounded. */
export function asciiSafe(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, '?').slice(0, 240);
}

function list(scores: readonly number[]): string {
  return scores.length === 0 ? '-' : scores.join(', ');
}

function spreadText(p: PairVerdict): string {
  if (p.ungradedCalls.length > 0) return 'UNGRADED (not compared)';
  const two = p.spreadStageTwo === null ? '' : `, ${p.spreadStageTwo} over eight runs each`;
  return `spread ${p.spreadStageOne ?? '-'} after stage one${two} -> ${p.inconclusive ? 'INCONCLUSIVE (decide)' : 'ok'}`;
}

export function renderCheckRecord(result: CheckResult, h: RecordHeader): string {
  const lines: string[] = [];
  lines.push(`## Counterfactual fair-housing check - ${h.now}`, '');
  lines.push(`- Verdict: ${result.verdict}`);
  for (const reason of result.reasons) lines.push(`  - ${reason}`);
  lines.push(`- Model: ${h.model}; key ${h.keyTail}; ${h.endpoint}`);
  lines.push(`- Rubric ${RUBRIC_VERSION}, examples ${EXAMPLES_VERSION}, prompt fingerprint ${h.promptFingerprint}`);
  lines.push(
    `- Calls: ${result.stageOneCalls + result.stageTwoCalls} (stage one ${result.stageOneCalls}, stage two ${result.stageTwoCalls}); ` +
      `tokens in ${result.inputTokens}, out ${result.outputTokens}; cost $${result.costUsd.toFixed(4)} (built-in price table)`,
  );
  lines.push(
    `- Rules (spec D17, Q5): stage one passes a swap when its mean moves at most ${SCORE_TOLERANCE} points and its cap count differs by at most 1 of 3; ` +
      `stage two fails it only on a move over ${SCORE_TOLERANCE} or a cap difference over 3 of 8. Each run's cap is production's capOf on that run's own output.`,
  );
  lines.push('', '### Base pairs', '');
  for (const p of result.pairs) {
    lines.push(`#### ${p.pairId} - ${p.about} - ${p.direction}`, '');
    lines.push(`- Group A: ${list(p.groupA)}; group B: ${list(p.groupB)}`);
    lines.push(`- Noise: ${spreadText(p)}`);
    if (p.ungradedCalls.length > 0) lines.push(`- Ungraded calls: ${p.ungradedCalls.join(', ')}`);
    lines.push('', '| Swap | Stage | Base scores | Variant scores | Mean move | Base capped | Variant capped | Verdict |', '|---|---|---|---|---|---|---|---|');
    for (const s of p.swaps) {
      const verdict = `${s.verdict.toUpperCase()}${p.inconclusive ? ' (reported only)' : ''}`;
      lines.push(
        `| ${s.swapId} | ${s.stage} | ${list(s.baseScores)} | ${list(s.variantScores)} | ${s.meanMove} | ` +
          `${s.baseCaps} of ${s.baseScores.length} | ${s.variantCaps} of ${s.variantScores.length} | ${verdict} |`,
      );
    }
    lines.push('');
  }
  lines.push('### Controls', '', '| Control | Direction | Expect | Scores | Flagged | Capped | Verdict |', '|---|---|---|---|---|---|---|');
  for (const c of result.controls) {
    const scores = c.scores.map((s) => (s === null ? 'ungraded' : String(s))).join(', ');
    lines.push(`| ${c.controlId} | ${c.direction} | ${c.expect} | ${scores} | ${c.hits} of ${c.graded} | ${c.capped} | ${c.verdict.toUpperCase()} |`);
  }
  lines.push('', '### Ungraded runs', '');
  if (result.ungraded.length === 0) lines.push('- none');
  for (const r of result.ungraded) lines.push(`- ${r.spec.id}: ${r.failure ?? 'unknown'} - ${asciiSafe(r.message ?? '')}`);
  lines.push('', 'Cameron: (PASS, or your decision, with the date)', '');
  return lines.join('\n');
}

/** Spec D17 item 3: the batch timing record (latency and tokens per run). */
export function renderTimingRecord(results: readonly CallResult[], h: RecordHeader, candidates: number): string {
  const lines: string[] = [];
  lines.push(`## Batch timing - ${h.now}`, '');
  lines.push(`- Model: ${h.model}; key ${h.keyTail}; ${h.endpoint}`);
  lines.push(`- Rubric ${RUBRIC_VERSION}, examples ${EXAMPLES_VERSION}, prompt fingerprint ${h.promptFingerprint}`);
  lines.push(`- One synthetic batch of ${candidates} candidates (a property anchor), ${results.length} runs, one at a time`);
  lines.push('', '| Run | Outcome | Latency ms | Input tokens | Output tokens | Candidates scored |', '|---|---|---|---|---|---|');
  for (const r of results) {
    const outcome = r.failure === undefined || r.failure === 'not_scored' ? 'answered' : r.failure;
    lines.push(
      `| ${r.spec.run} | ${outcome} | ${r.latencyMs} | ${r.usage?.inputTokens ?? '-'} | ${r.usage?.outputTokens ?? '-'} | ${r.candidatesScored} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
