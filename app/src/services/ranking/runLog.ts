// The ranking run (WP1 B2a spec D11; charter 11). Every model call - one per
// batch - is a run in the AI runs table under its OWN key family. This module
// builds the run's INPUT; rankingRunsRepo.putRun adds `rrun#<runId>`, the
// kind, the two pointers (rankings#global and the anchor's) and the 350 KB
// guard (spec D11 inputOmitted), so the guard lives with the stored item.
//
// results[] is what THIS run said: its parsed output per candidate, the
// pair's merged missing list (code flags then the model's unknowns, spec D3 -
// the same value the match row gets; PR14), and cappedAtRun, the cap computed
// when the run finished from that output and the unlawful flags open then
// (the same capOf the read uses - one cap, PR7). The matches store holds one
// row per pair that any later press may rewrite, so the run detail renders
// results[], never the current row, as the run's.
//
// matchesWritten is NOT set here: the batch sets it after its match write by
// S2's second conditional update (absent means the write did not finish).
import type { AppConfig } from '../../lib/config.js';
import { gzipBase64, rankingExpiresAt, type MatchMissing } from '../../repos/matchesRepo.js';
import type { RankingJobRecord, RankingRunRecordInput, RankingRunResult } from '../../repos/rankingRunsRepo.js';
import type { AssembledAnchor, VerifiedCandidate } from './assemble.js';
import { capOf, flagFieldsOfKind } from './cap.js';
import { mergeMissing } from './completeness.js';
import { costUsd } from './cost.js';
import type { RankingCall } from './driverTypes.js';
import { EXAMPLES_VERSION } from './examples.js';
import type { ParsedCandidate } from './parse.js';
import type { RankingPrompt } from './prompt.js';
import { RUBRIC_VERSION } from './rubric.js';
import type { Direction } from './types.js';

export interface BuildRunInput {
  runId: string;
  job: RankingJobRecord;
  anchor: AssembledAnchor;
  direction: Direction;
  batchIndex: number;
  candidates: VerifiedCandidate[];
  prompt: RankingPrompt;
  call: RankingCall;
  /** The parsed result per candidate id (empty for a failed call). */
  byCandidate: ReadonlyMap<string, ParsedCandidate>;
  /** Per property: the unlawful fields open when the run finished. */
  openByUnit: ReadonlyMap<string, string[]>;
  startedAt: string;
  finishedAt: string;
  config: Pick<AppConfig, 'aiPriceTable' | 'appEnv' | 'rankingPairTtlDays'>;
}

/** The pair's missing list (spec D3): the anchor's and the candidate's code flags, then the model's own unknowns. */
export function pairMissing(anchor: AssembledAnchor, candidate: VerifiedCandidate, result: ParsedCandidate): MatchMissing[] {
  return mergeMissing([...anchor.missing, ...candidate.missing], result.unknowns);
}

function runResults(input: BuildRunInput): RankingRunResult[] {
  const byId = new Map(input.candidates.map((candidate) => [candidate.candidateId, candidate]));
  return input.prompt.handles.map((h) => {
    const result = input.byCandidate.get(h.candidateId);
    const candidate = byId.get(h.candidateId);
    if (result === undefined || candidate === undefined) {
      return { handle: h.handle, candidateId: h.candidateId, display: h.display, returned: false };
    }
    return {
      handle: h.handle,
      candidateId: h.candidateId,
      display: h.display,
      returned: true,
      score: result.score,
      for: result.for,
      against: result.against,
      unknowns: result.unknowns,
      failedRequirements: result.failedRequirements,
      fairHousingFlags: result.fairHousingFlags,
      missing: pairMissing(input.anchor, candidate, result),
      cappedAtRun: capOf({
        failedRequirements: result.failedRequirements,
        accommodationFields: flagFieldsOfKind(result.fairHousingFlags, 'accommodation'),
        recordedRequirementKeys: candidate.propertyFacts.recordedRequirementKeys,
        openUnlawfulFields: input.openByUnit.get(candidate.unitId) ?? [],
      }),
    };
  });
}

export function buildRankingRun(input: BuildRunInput): RankingRunRecordInput {
  const { call, prompt, job } = input;
  const usage = call.meta.usage;
  return {
    runId: input.runId,
    anchorKind: job.anchorKind,
    anchorId: job.anchorId,
    direction: input.direction,
    jobGeneration: job.generation,
    batchIndex: input.batchIndex,
    candidateCount: input.candidates.length,
    driver: call.meta.driver,
    model: call.meta.model,
    rubricVersion: RUBRIC_VERSION,
    examplesVersion: EXAMPLES_VERSION,
    promptFingerprint: prompt.promptFingerprint,
    usage: {
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      ...(usage?.cacheReadInputTokens !== undefined && { cacheReadInputTokens: usage.cacheReadInputTokens }),
    },
    // 0 for fake / console / no usage; an unpriced billed model is refused at
    // startup (S2), so S4's throw is unreachable in a booted process (IR35).
    costUsd: costUsd(call.meta.model, usage, input.config.aiPriceTable),
    latencyMs: call.meta.latencyMs,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    outcome: call.ok ? 'scored' : 'failed',
    ...(!call.ok && { failure: call.failure, message: call.message }),
    ...(call.meta.rawText !== undefined && { rawText: call.meta.rawText }),
    inputGzip: gzipBase64(prompt.userText),
    handles: prompt.handles.map((h) => ({ handle: h.handle, candidateId: h.candidateId, display: h.display })),
    results: runResults(input),
    droppedUnlawfulFlags: call.ok ? call.output.droppedUnlawfulFlags : 0,
    environment: input.config.appEnv,
    expires_at: rankingExpiresAt(input.startedAt, input.config.rankingPairTtlDays),
  };
}
